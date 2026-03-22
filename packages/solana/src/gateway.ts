/**
 * The narrow slice of Solana the wallet worker actually needs.
 *
 * Defining this as an interface rather than passing `Connection` around everywhere is not
 * ceremony. The deposit scanner's job is *reasoning about money under partial failure* —
 * replays, restarts, overlapping poll windows, transactions whose fate is unknown. Those
 * are the cases worth testing exhaustively, and none of them are reachable through a real
 * RPC on demand: you cannot ask devnet to deliver the same signature twice, or to go down
 * mid-poll.
 *
 * With a gateway, every one of those becomes a three-line fake. `RpcGateway` below is the
 * real implementation, deliberately thin enough that reading it is a substitute for
 * testing it.
 */

import { type Connection, PublicKey } from '@solana/web3.js';

export interface SignatureRecord {
  readonly signature: string;
  readonly slot: number;
  /** Solana reports an error object for a transaction that landed but failed. */
  readonly err: unknown;
}

export interface TokenTransfer {
  readonly signature: string;
  readonly slot: number;
  /** The token account that received the funds. */
  readonly destination: string;
  /** Amount in the mint's base unit — micro-USDC for USDC. */
  readonly amountMicros: number;
}

export interface SolanaGateway {
  /**
   * Signatures touching `address`, newest first, stopping once `until` is reached.
   *
   * `until` is the cursor: the newest signature already processed for this address.
   */
  getSignaturesForAddress(address: PublicKey, until?: string): Promise<SignatureRecord[]>;

  /** Net token movement into any account, or `null` if the transaction moved no tokens. */
  getTokenTransfers(signature: string): Promise<TokenTransfer[]>;
}

/**
 * The real gateway.
 *
 * Everything runs at `finalized`, never `confirmed`. A confirmed transaction can still be
 * rolled back by a fork; crediting on it means a deposit that later ceases to exist while
 * the agent has already played with the chips. Finality is slower and it is the only
 * commitment level at which crediting is safe.
 */
export class RpcGateway implements SolanaGateway {
  constructor(private readonly connection: Connection) {}

  async getSignaturesForAddress(address: PublicKey, until?: string): Promise<SignatureRecord[]> {
    const results = await this.connection.getSignaturesForAddress(
      address,
      { ...(until !== undefined ? { until } : {}), limit: 1000 },
      'finalized',
    );
    return results.map((r) => ({ signature: r.signature, slot: r.slot, err: r.err }));
  }

  async getTokenTransfers(signature: string): Promise<TokenTransfer[]> {
    const parsed = await this.connection.getParsedTransaction(signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    if (!parsed?.meta || parsed.meta.err !== null) return [];

    // Derived from the balance delta rather than by decoding instructions. A transfer can
    // arrive through `transfer`, `transferChecked`, a CPI from some other program, or
    // several at once; the balance change is what actually happened regardless of how.
    const before = new Map<number, string>();
    for (const balance of parsed.meta.preTokenBalances ?? []) {
      before.set(balance.accountIndex, balance.uiTokenAmount.amount);
    }

    const transfers: TokenTransfer[] = [];
    for (const balance of parsed.meta.postTokenBalances ?? []) {
      const priorRaw = before.get(balance.accountIndex) ?? '0';
      const delta = Number(balance.uiTokenAmount.amount) - Number(priorRaw);
      if (delta <= 0) continue;

      const accounts = parsed.transaction.message.accountKeys;
      const destination = accounts[balance.accountIndex]?.pubkey.toBase58();
      if (destination === undefined) continue;

      transfers.push({
        signature,
        slot: parsed.slot,
        destination,
        amountMicros: delta,
      });
    }
    return transfers;
  }
}

export { PublicKey };
