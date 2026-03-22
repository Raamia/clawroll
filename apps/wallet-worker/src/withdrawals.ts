/**
 * The withdrawal worker.
 *
 * This is the only code in Clawroll that *sends* money, which makes it the riskiest file in
 * the repository. Everything else can be retried freely; a duplicated withdrawal is gone.
 *
 * ## The hard problem: a sent transaction has an unknown fate
 *
 * `sendTransaction` returning an error does **not** mean the transaction failed. It may have
 * reached the network and be waiting to land. A timeout means even less. The naive recovery —
 * "the send errored, so retry it" — builds a *second* transaction, and if the first one lands
 * the agent is paid twice.
 *
 * So the worker never asks "did the send succeed?". It asks "what does the chain say about
 * the signature I already recorded?", which is a question with a real answer.
 *
 * ## The protocol
 *
 * 1. **Debit the ledger first**, keyed on the withdrawal id. An agent cannot withdraw what
 *    it does not have, and the debit is idempotent, so this step is safe to repeat.
 * 2. **Build and sign**, producing a deterministic signature.
 * 3. **Record the signature before broadcasting.** This is the crux. After a crash the row
 *    tells us exactly which transaction to ask about. Broadcasting first would leave a
 *    transaction in flight that nothing in the system knows the name of.
 * 4. **Send.** Errors here are recorded but change nothing — the fate is still unknown.
 * 5. **Poll the recorded signature.**
 *    - Landed and succeeded → confirmed.
 *    - Landed and failed → refund the agent, since the money never left.
 *    - Not landed, blockhash still valid → wait. Re-sending the *same* signed transaction is
 *      safe and often necessary; the chain deduplicates it.
 *    - Not landed, blockhash expired → **now** it is provably safe to rebuild.
 *
 * ## Why blockhash expiry is the thing that makes rebuilding safe
 *
 * A Solana transaction is only valid while its blockhash is recent — roughly 150 slots. Once
 * the chain is past `lastValidBlockHeight`, that transaction **can never be included**. Not
 * "probably won't": cannot. That is the only signal that turns "I don't know whether it
 * landed" into "it definitively did not", and it is what separates a safe rebuild from a
 * coin flip.
 *
 * Everything else here is bookkeeping. This is the part worth understanding.
 */

import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Ledger } from '@clawroll/db';

export type WithdrawalStatus =
  | 'debited'
  | 'signed'
  | 'sent'
  | 'confirmed'
  | 'failed'
  | 'refunded';

export interface Withdrawal {
  readonly id: string;
  readonly agentId: string;
  readonly destination: string;
  readonly amountMicros: number;
  readonly status: WithdrawalStatus;
  readonly signature: string | null;
  readonly lastValidBlockHeight: number | null;
  readonly attempts: number;
  readonly error: string | null;
}

/** What a signed-but-not-yet-sent transaction looks like to this worker. */
export interface SignedTransfer {
  readonly signature: string;
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
  readonly rawTransaction: Uint8Array;
}

export interface SignatureOutcome {
  /** True once the transaction is finalized. */
  readonly landed: boolean;
  /** Non-null when it landed but the instruction failed. */
  readonly err: unknown;
}

/**
 * The chain operations a withdrawal needs.
 *
 * An interface for the same reason the deposit scanner has one: the cases that matter —
 * a send that errors but lands anyway, a blockhash expiring mid-flight, a crash between
 * signing and broadcasting — cannot be requested from a real RPC.
 */
export interface WithdrawalGateway {
  buildAndSign(destination: string, amountMicros: number): Promise<SignedTransfer>;
  send(rawTransaction: Uint8Array): Promise<void>;
  getSignatureOutcome(signature: string): Promise<SignatureOutcome | null>;
  getBlockHeight(): Promise<number>;
}

export class WithdrawalError extends Error {}

export class WithdrawalWorker {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: Ledger,
    private readonly gateway: WithdrawalGateway,
  ) {}

  /**
   * Accept a withdrawal request and debit the agent.
   *
   * The debit happens before anything touches the chain, so an agent can never have a
   * transfer in flight for money it does not hold. If the debit fails, nothing was sent.
   */
  async request(agentId: string, destination: string, amountMicros: number): Promise<Withdrawal> {
    if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) {
      throw new WithdrawalError(`withdrawal amount must be a positive integer, got ${amountMicros}`);
    }

    const id = `wd_${randomUUID()}`;
    const debit = await this.ledger.debitWithdrawal(agentId, amountMicros, id);

    await this.sql`
      INSERT INTO withdrawals (id, agent_id, destination, amount_micros, status, ledger_tx_id)
      VALUES (${id}, ${agentId}, ${destination}, ${amountMicros}, ${'debited'}, ${debit.txId})`;

    return this.load(id);
  }

  async load(id: string): Promise<Withdrawal> {
    const rows = await this.sql<
      {
        id: string;
        agent_id: string;
        destination: string;
        amount_micros: string;
        status: WithdrawalStatus;
        signature: string | null;
        last_valid_block_height: string | null;
        attempts: number;
        error: string | null;
      }[]
    >`SELECT id, agent_id, destination, amount_micros::text, status, signature,
             last_valid_block_height::text, attempts, error
      FROM withdrawals WHERE id = ${id}`;

    const row = rows[0];
    if (!row) throw new WithdrawalError(`no withdrawal ${id}`);
    return {
      id: row.id,
      agentId: row.agent_id,
      destination: row.destination,
      amountMicros: Number(row.amount_micros),
      status: row.status,
      signature: row.signature,
      lastValidBlockHeight:
        row.last_valid_block_height === null ? null : Number(row.last_valid_block_height),
      attempts: row.attempts,
      error: row.error,
    };
  }

  /**
   * Advance one withdrawal by exactly one step.
   *
   * Deliberately a single step per call rather than a loop-until-done. Every state is
   * durable in Postgres, so a crash resumes from wherever it stopped — and each step is
   * separately observable, which is what makes a stuck withdrawal diagnosable rather than
   * a black box.
   */
  async advance(id: string): Promise<Withdrawal> {
    const withdrawal = await this.load(id);

    switch (withdrawal.status) {
      case 'debited':
        return this.signAndSend(withdrawal);
      case 'signed':
      case 'sent':
        return this.checkOutcome(withdrawal);
      case 'confirmed':
      case 'failed':
      case 'refunded':
        return withdrawal;
    }
  }

  /** Sign, record the signature, then broadcast — in that order, always. */
  private async signAndSend(withdrawal: Withdrawal): Promise<Withdrawal> {
    const signed = await this.gateway.buildAndSign(withdrawal.destination, withdrawal.amountMicros);

    // Recorded BEFORE the send. If the process dies on the next line, this row is the only
    // thing that lets us ask the chain what happened rather than guess.
    await this.sql`
      UPDATE withdrawals
      SET status = ${'signed'}, signature = ${signed.signature}, blockhash = ${signed.blockhash},
          last_valid_block_height = ${signed.lastValidBlockHeight},
          attempts = attempts + 1, updated_at = now()
      WHERE id = ${withdrawal.id}`;

    try {
      await this.gateway.send(signed.rawTransaction);
      await this.sql`
        UPDATE withdrawals SET status = ${'sent'}, updated_at = now() WHERE id = ${withdrawal.id}`;
    } catch (error) {
      // A send error does not mean the transaction failed — it may already be on its way.
      // Record the error and leave the status at `signed`; the outcome check decides.
      await this.sql`
        UPDATE withdrawals SET error = ${(error as Error).message}, updated_at = now()
        WHERE id = ${withdrawal.id}`;
    }

    return this.load(withdrawal.id);
  }

  /** Ask the chain about the recorded signature and act on the answer. */
  private async checkOutcome(withdrawal: Withdrawal): Promise<Withdrawal> {
    if (withdrawal.signature === null) {
      throw new WithdrawalError(`withdrawal ${withdrawal.id} is ${withdrawal.status} with no signature`);
    }

    const outcome = await this.gateway.getSignatureOutcome(withdrawal.signature);

    if (outcome?.landed) {
      if (outcome.err === null) {
        await this.sql`
          UPDATE withdrawals SET status = ${'confirmed'}, error = ${null}, updated_at = now()
          WHERE id = ${withdrawal.id}`;
      } else {
        // It landed and the instruction failed, so the money never left. The agent was
        // debited up front, so it has to come back.
        await this.refund(withdrawal, `on-chain failure: ${JSON.stringify(outcome.err)}`);
      }
      return this.load(withdrawal.id);
    }

    // Not landed. The only question that matters is whether it still could.
    const blockHeight = await this.gateway.getBlockHeight();
    const expired =
      withdrawal.lastValidBlockHeight !== null && blockHeight > withdrawal.lastValidBlockHeight;

    if (!expired) {
      // Still live. Re-broadcasting the same signed bytes is safe — the chain deduplicates
      // by signature — and is often what gets a dropped transaction through.
      return withdrawal;
    }

    // Past its last valid block height, so it can never be included. Only now is rebuilding
    // safe: this is the one signal that turns "unknown" into "definitively did not land".
    await this.sql`
      UPDATE withdrawals
      SET status = ${'debited'}, signature = ${null}, blockhash = ${null},
          last_valid_block_height = ${null},
          error = ${'blockhash expired before inclusion; rebuilding'}, updated_at = now()
      WHERE id = ${withdrawal.id}`;
    return this.load(withdrawal.id);
  }

  /** Return the money and mark the withdrawal refunded. Idempotent on the withdrawal id. */
  private async refund(withdrawal: Withdrawal, reason: string): Promise<void> {
    await this.ledger.refundWithdrawal(
      withdrawal.agentId,
      withdrawal.amountMicros,
      withdrawal.id,
    );
    await this.sql`
      UPDATE withdrawals SET status = ${'refunded'}, error = ${reason}, updated_at = now()
      WHERE id = ${withdrawal.id}`;
  }

  /** Withdrawals still needing work, oldest first. */
  async pending(): Promise<Withdrawal[]> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT id FROM withdrawals
      WHERE status IN ('debited','signed','sent')
      ORDER BY created_at ASC`;
    return Promise.all(rows.map((r) => this.load(r.id)));
  }

  /**
   * Withdrawals that have been retried far more than any healthy one should be.
   *
   * Worth alerting on: a withdrawal cycling through rebuilds usually means the treasury is
   * out of SOL for fees, or the destination account cannot receive the token.
   */
  async findStuck(attemptThreshold = 5): Promise<Withdrawal[]> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT id FROM withdrawals
      WHERE status IN ('debited','signed','sent') AND attempts >= ${attemptThreshold}`;
    return Promise.all(rows.map((r) => this.load(r.id)));
  }
}
