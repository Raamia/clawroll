/**
 * The deposit scanner.
 *
 * Polls every agent's deposit token account for incoming USDC and credits the ledger. It is
 * the only component that turns something that happened on a blockchain into money in
 * Clawroll, so it is written around one assumption: **it will see the same deposit more
 * than once, and that is normal.**
 *
 * Restarts, retries, overlapping poll windows and cursor gaps all replay signatures. A
 * scanner that treats a replay as an error will eventually either double-credit or drop a
 * deposit, because every call site has to classify the failure correctly and one of them
 * will not.
 *
 * ## Credit first, then record the sighting
 *
 * The ordering is deliberate and it is the crash-safety argument:
 *
 * 1. `ledger.creditDeposit(agentId, amount, signature)` — idempotent on the signature.
 * 2. Record the sighting, which also advances the cursor.
 *
 * Crash between the two and the next poll re-credits (a no-op, `created: false`) and then
 * records. Crash after both and the cursor has moved on. **Doing it the other way round —
 * sighting first — would mean a crash in the middle permanently skips a real deposit**,
 * because the next poll sees the signature as already handled and never credits it.
 *
 * The sighting table is therefore an observability record and a cursor, not a correctness
 * mechanism. Correctness lives entirely in the ledger's `UNIQUE (external_ref)`.
 *
 * ## Everything runs at `finalized`
 *
 * A `confirmed` transaction can still be rolled back by a fork. Crediting on it means a
 * deposit that later ceases to exist while the agent has already played with the chips.
 */

import type { Sql } from 'postgres';
import type { Ledger } from '@clawroll/db';
import { PublicKey, type SolanaGateway } from '@clawroll/solana';

export interface DepositTarget {
  readonly agentId: string;
  /** The Associated Token Account USDC actually lands in. */
  readonly tokenAccount: string;
}

export interface ScanSummary {
  readonly addressesScanned: number;
  readonly signaturesSeen: number;
  readonly depositsCredited: number;
  /** Signatures seen again that had already been credited. */
  readonly replaysIgnored: number;
  readonly failures: { signature: string; reason: string }[];
}

export interface ScannerOptions {
  /** Ignore dust below this, in micro-USDC. Defaults to 0 (credit everything). */
  readonly minimumMicros?: number;
}

export class DepositScanner {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: Ledger,
    private readonly gateway: SolanaGateway,
    private readonly options: ScannerOptions = {},
  ) {}

  /** Every agent with a deposit address. */
  async targets(): Promise<DepositTarget[]> {
    const rows = await this.sql<{ id: string; deposit_address: string }[]>`
      SELECT id, deposit_address FROM agents`;
    return rows.map((r) => ({ agentId: r.id, tokenAccount: r.deposit_address }));
  }

  /**
   * The newest signature already processed for an address.
   *
   * Used as the `until` cursor so a poll fetches only what is new. If it is missing —
   * because a crash lost the sighting — the scan simply re-reads more history and the
   * ledger absorbs the duplicates. Losing the cursor costs time, never money.
   */
  private async cursorFor(tokenAccount: string): Promise<string | undefined> {
    const rows = await this.sql<{ signature: string }[]>`
      SELECT s.signature FROM deposit_sightings s
      JOIN agents a ON a.id = s.agent_id
      WHERE a.deposit_address = ${tokenAccount}
      ORDER BY s.slot DESC, s.seen_at DESC
      LIMIT 1`;
    return rows[0]?.signature;
  }

  /** Run one pass over every deposit address. */
  async scanOnce(): Promise<ScanSummary> {
    const summary: ScanSummary = {
      addressesScanned: 0,
      signaturesSeen: 0,
      depositsCredited: 0,
      replaysIgnored: 0,
      failures: [],
    };

    const mutable = summary as {
      -readonly [K in keyof ScanSummary]: ScanSummary[K];
    };

    for (const target of await this.targets()) {
      mutable.addressesScanned++;
      try {
        await this.scanAddress(target, mutable);
      } catch (error) {
        mutable.failures.push({
          signature: `address:${target.tokenAccount}`,
          reason: (error as Error).message,
        });
      }
    }
    return summary;
  }

  private async scanAddress(
    target: DepositTarget,
    summary: { -readonly [K in keyof ScanSummary]: ScanSummary[K] },
  ): Promise<void> {
    const cursor = await this.cursorFor(target.tokenAccount);
    const signatures = await this.gateway.getSignaturesForAddress(
      new PublicKey(target.tokenAccount),
      cursor,
    );

    // Oldest first, so the cursor advances monotonically even if the pass is interrupted
    // partway through.
    for (const record of [...signatures].reverse()) {
      summary.signaturesSeen++;

      // A transaction that landed but failed moved no money. Recording it still advances
      // the cursor, which is what stops it being re-fetched on every future poll.
      if (record.err !== null) {
        await this.recordSighting(target.agentId, record.signature, 0, record.slot, null);
        continue;
      }

      try {
        await this.creditSignature(target, record.signature, record.slot, summary);
      } catch (error) {
        // Leave the cursor where it is: an uncredited deposit must be retried, and the
        // ledger will refuse to pay it twice when it is.
        summary.failures.push({ signature: record.signature, reason: (error as Error).message });
      }
    }
  }

  private async creditSignature(
    target: DepositTarget,
    signature: string,
    slot: number,
    summary: { -readonly [K in keyof ScanSummary]: ScanSummary[K] },
  ): Promise<void> {
    const transfers = await this.gateway.getTokenTransfers(signature);
    const incoming = transfers.filter((t) => t.destination === target.tokenAccount);

    if (incoming.length === 0) {
      // Touched the account without depositing — an ATA creation, or an outgoing sweep.
      await this.recordSighting(target.agentId, signature, 0, slot, null);
      return;
    }

    const amountMicros = incoming.reduce((sum, t) => sum + t.amountMicros, 0);
    const minimum = this.options.minimumMicros ?? 0;
    if (amountMicros < minimum) {
      await this.recordSighting(target.agentId, signature, amountMicros, slot, null);
      return;
    }

    // Credit BEFORE recording. See the note at the top of this file: recording first would
    // mean a crash in between permanently skips a real deposit.
    const result = await this.ledger.creditDeposit(target.agentId, amountMicros, signature);
    if (result.created) summary.depositsCredited++;
    else summary.replaysIgnored++;

    await this.recordSighting(target.agentId, signature, amountMicros, slot, result.txId);
  }

  private async recordSighting(
    agentId: string,
    signature: string,
    amountMicros: number,
    slot: number,
    creditedTxId: string | null,
  ): Promise<void> {
    await this.sql`
      INSERT INTO deposit_sightings (signature, agent_id, amount_micros, slot, credited_tx_id)
      VALUES (${signature}, ${agentId}, ${amountMicros}, ${slot}, ${creditedTxId})
      ON CONFLICT (signature) DO UPDATE
        SET credited_tx_id = COALESCE(deposit_sightings.credited_tx_id, EXCLUDED.credited_tx_id)`;
  }

  /**
   * Deposits observed but never credited.
   *
   * Should always be empty. A non-empty result means money arrived on chain that an agent
   * has not been paid for — the one failure in this system a user would notice immediately,
   * so it is worth alerting on rather than discovering from a support message.
   */
  async findUncreditedDeposits(): Promise<{ signature: string; agentId: string; amountMicros: number }[]> {
    const rows = await this.sql<{ signature: string; agent_id: string; amount_micros: string }[]>`
      SELECT signature, agent_id, amount_micros::text
      FROM deposit_sightings
      WHERE credited_tx_id IS NULL AND amount_micros > 0`;
    return rows.map((r) => ({
      signature: r.signature,
      agentId: r.agent_id,
      amountMicros: Number(r.amount_micros),
    }));
  }
}
