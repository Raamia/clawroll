/**
 * The double-entry ledger.
 *
 * Every movement of money is a transaction whose entries sum to exactly zero. Nothing
 * writes `ledger_entries` except `postTransaction`, so there is one place where the
 * balance rule is enforced and one place to read to know it holds.
 *
 * ## Posting is idempotent, not merely safe to retry
 *
 * `postTransaction` takes an optional `externalRef` — a Solana signature for a deposit, a
 * hand id for a settlement — and returns `{ txId, created }`. A second call with the same
 * ref does not throw and does not double-post: it returns the original `txId` with
 * `created: false`.
 *
 * That distinction matters more than it looks. A deposit scanner will see the same
 * transaction again after a restart, a retry, or an overlapping poll window — that is
 * normal operation, not an error. If replaying threw, every caller would need a try/catch
 * that distinguishes "already credited" from "genuinely failed", and the first caller to
 * get that wrong either double-credits or drops a deposit. Making the *normal* case
 * return normally removes that decision from every call site.
 *
 * ## Accounts are locked in a deterministic order
 *
 * Balances are derived, so checking one before writing means reading entries — which is
 * only meaningful if nothing else writes concurrently. `postTransaction` locks every
 * account it touches with `SELECT … FOR UPDATE`, **sorted by account id**.
 *
 * The sort is the entire point. Two concurrent transfers touching accounts A and B in
 * opposite orders deadlock; the same two acquiring locks in a globally consistent order
 * cannot. It is one `.sort()` and it is the difference between a system that works under
 * load and one that fails at 3am under exactly the conditions nobody tested.
 */

import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { AccountType, LedgerKind } from './schema.js';

export interface EntryInput {
  readonly accountId: string;
  /** Signed micro-USDC. Negative debits, positive credits. */
  readonly amountMicros: number;
}

export interface PostTransactionInput {
  readonly kind: LedgerKind;
  readonly entries: readonly EntryInput[];
  readonly externalRef?: string;
  readonly memo?: string;
  /**
   * Accounts permitted to go negative — the system side of a deposit or withdrawal, which
   * is a liability position by definition. Agent accounts are never in this set.
   */
  readonly mayGoNegative?: readonly string[];
}

export interface PostResult {
  readonly txId: string;
  /** False when `externalRef` had already been posted; the original id is returned. */
  readonly created: boolean;
}

export class LedgerError extends Error {}

/** Postgres `unique_violation`. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export class Ledger {
  constructor(private readonly sql: Sql) {}

  /** Get or create an agent's account of a given type. */
  async ensureAccount(agentId: string | null, type: AccountType): Promise<string> {
    const existing = agentId
      ? await this.sql<{ id: string }[]>`
          SELECT id FROM accounts WHERE agent_id = ${agentId} AND type = ${type}`
      : await this.sql<{ id: string }[]>`
          SELECT id FROM accounts WHERE agent_id IS NULL AND type = ${type}`;

    if (existing[0]) return existing[0].id;

    const id = `acct_${randomUUID()}`;
    await this.sql`
      INSERT INTO accounts (id, agent_id, type) VALUES (${id}, ${agentId}, ${type})
      ON CONFLICT DO NOTHING`;

    // Lost the race with a concurrent creator — read back whichever row won.
    const settled = agentId
      ? await this.sql<{ id: string }[]>`
          SELECT id FROM accounts WHERE agent_id = ${agentId} AND type = ${type}`
      : await this.sql<{ id: string }[]>`
          SELECT id FROM accounts WHERE agent_id IS NULL AND type = ${type}`;

    const account = settled[0];
    if (!account) throw new LedgerError(`could not create ${type} account for ${agentId ?? 'system'}`);
    return account.id;
  }

  /** Current balance of an account, derived from its entries. */
  async balanceOf(accountId: string): Promise<number> {
    const rows = await this.sql<{ balance: string | null }[]>`
      SELECT COALESCE(SUM(amount_micros), 0)::text AS balance
      FROM ledger_entries WHERE account_id = ${accountId}`;
    return Number(rows[0]?.balance ?? 0);
  }

  async balanceOfAgent(agentId: string, type: AccountType): Promise<number> {
    const accountId = await this.ensureAccount(agentId, type);
    return this.balanceOf(accountId);
  }

  /**
   * Post a balanced transaction.
   *
   * Validates before touching the database, then does the whole write — lock, check
   * balances, insert tx, insert entries — inside one Postgres transaction. There is no
   * window in which a partial transaction is visible.
   */
  async postTransaction(input: PostTransactionInput): Promise<PostResult> {
    const { kind, entries, externalRef, memo } = input;

    if (entries.length < 2) {
      throw new LedgerError(`a transaction needs at least 2 entries, got ${entries.length}`);
    }
    const total = entries.reduce((sum, e) => sum + e.amountMicros, 0);
    if (total !== 0) {
      throw new LedgerError(`entries must sum to zero, got ${total}`);
    }
    for (const entry of entries) {
      if (!Number.isSafeInteger(entry.amountMicros)) {
        throw new LedgerError(`amount must be a safe integer, got ${entry.amountMicros}`);
      }
      if (entry.amountMicros === 0) {
        throw new LedgerError('a zero-amount entry records a movement that did not happen');
      }
    }

    const mayGoNegative = new Set(input.mayGoNegative ?? []);

    try {
      return await this.postInTransaction(input, mayGoNegative);
    } catch (error) {
      // Two callers posting the same `externalRef` at the same instant both find no row,
      // both insert, and one loses on the UNIQUE constraint. The money is already correct
      // at that point — the constraint did its job — but the loser would see an exception
      // where the contract promises `created: false`.
      //
      // Without this, every caller would need to classify Postgres error codes to tell
      // "already credited" from "genuinely failed", and the first one to get that wrong
      // either double-credits or silently drops a deposit. The race is resolved here,
      // once, by reading back whichever transaction won.
      if (externalRef !== undefined && isUniqueViolation(error)) {
        const existing = await this.sql<{ id: string }[]>`
          SELECT id FROM ledger_txs WHERE external_ref = ${externalRef}`;
        if (existing[0]) return { txId: existing[0].id, created: false };
      }
      throw error;
    }
  }

  private async postInTransaction(
    input: PostTransactionInput,
    mayGoNegative: ReadonlySet<string>,
  ): Promise<PostResult> {
    const { kind, entries, externalRef, memo } = input;

    return this.sql.begin(async (tx) => {
      if (externalRef !== undefined) {
        const existing = await tx<{ id: string }[]>`
          SELECT id FROM ledger_txs WHERE external_ref = ${externalRef}`;
        // Replaying a deposit is normal operation, not an error.
        if (existing[0]) return { txId: existing[0].id, created: false };
      }

      // Sorted so concurrent transfers acquire locks in a globally consistent order and
      // therefore cannot deadlock against each other.
      const touched = [...new Set(entries.map((e) => e.accountId))].sort();
      const locked = await tx<{ id: string }[]>`
        SELECT id FROM accounts WHERE id IN ${tx(touched)} ORDER BY id FOR UPDATE`;
      if (locked.length !== touched.length) {
        throw new LedgerError('one or more accounts in this transaction do not exist');
      }

      const netByAccount = new Map<string, number>();
      for (const entry of entries) {
        netByAccount.set(entry.accountId, (netByAccount.get(entry.accountId) ?? 0) + entry.amountMicros);
      }

      for (const [accountId, delta] of netByAccount) {
        if (delta >= 0 || mayGoNegative.has(accountId)) continue;
        const rows = await tx<{ balance: string | null }[]>`
          SELECT COALESCE(SUM(amount_micros), 0)::text AS balance
          FROM ledger_entries WHERE account_id = ${accountId}`;
        const balance = Number(rows[0]?.balance ?? 0);
        if (balance + delta < 0) {
          throw new LedgerError(
            `insufficient funds in ${accountId}: balance ${balance}, needs ${-delta}`,
          );
        }
      }

      const txId = `ltx_${randomUUID()}`;
      await tx`
        INSERT INTO ledger_txs (id, kind, external_ref, memo)
        VALUES (${txId}, ${kind}, ${externalRef ?? null}, ${memo ?? null})`;

      await tx`
        INSERT INTO ledger_entries ${tx(
          entries.map((entry) => ({
            id: `lde_${randomUUID()}`,
            tx_id: txId,
            account_id: entry.accountId,
            amount_micros: entry.amountMicros,
          })),
        )}`;

      return { txId, created: true };
    });
  }

  // -------------------------------------------------------------------------
  // Domain operations
  // -------------------------------------------------------------------------

  /**
   * Credit a confirmed on-chain deposit, keyed on its Solana signature.
   *
   * Calling this twice with the same signature credits once. That is the whole design of
   * the deposit path — see the note at the top of this file.
   */
  async creditDeposit(agentId: string, amountMicros: number, signature: string): Promise<PostResult> {
    const available = await this.ensureAccount(agentId, 'available');
    const house = await this.ensureAccount(null, 'house');

    return this.postTransaction({
      kind: 'deposit',
      externalRef: signature,
      memo: `devnet deposit ${signature}`,
      entries: [
        { accountId: house, amountMicros: -amountMicros },
        { accountId: available, amountMicros },
      ],
      // The house account is a liability position and is expected to run negative.
      mayGoNegative: [house],
    });
  }

  /**
   * Return money for a withdrawal that could not be sent.
   *
   * Posted as an `adjustment`, deliberately not reused from `creditDeposit`. The money
   * movement is identical, but a refund recorded as a deposit would inflate every figure
   * derived from deposits — volume, per-agent totals, on-chain reconciliation — with money
   * that never arrived from the chain. Idempotent on the withdrawal id.
   */
  async refundWithdrawal(
    agentId: string,
    amountMicros: number,
    withdrawalId: string,
  ): Promise<PostResult> {
    const available = await this.ensureAccount(agentId, 'available');
    const house = await this.ensureAccount(null, 'house');

    return this.postTransaction({
      kind: 'adjustment',
      externalRef: `refund:${withdrawalId}`,
      memo: `refund for withdrawal ${withdrawalId}`,
      entries: [
        { accountId: house, amountMicros: -amountMicros },
        { accountId: available, amountMicros },
      ],
      mayGoNegative: [house],
    });
  }

  /** Debit for a withdrawal. Fails if the agent cannot cover it. */
  async debitWithdrawal(agentId: string, amountMicros: number, requestId: string): Promise<PostResult> {
    const available = await this.ensureAccount(agentId, 'available');
    const house = await this.ensureAccount(null, 'house');

    return this.postTransaction({
      kind: 'withdrawal',
      externalRef: `withdrawal:${requestId}`,
      entries: [
        { accountId: available, amountMicros: -amountMicros },
        { accountId: house, amountMicros },
      ],
    });
  }

  /** Move settled funds onto a table. */
  async buyIn(agentId: string, amountMicros: number, ref: string): Promise<PostResult> {
    return this.transferBetweenOwnAccounts(agentId, 'available', 'in_play', amountMicros, 'buy_in', ref);
  }

  /** Move chips back off a table. */
  async cashOut(agentId: string, amountMicros: number, ref: string): Promise<PostResult> {
    return this.transferBetweenOwnAccounts(agentId, 'in_play', 'available', amountMicros, 'cash_out', ref);
  }

  private async transferBetweenOwnAccounts(
    agentId: string,
    from: AccountType,
    to: AccountType,
    amountMicros: number,
    kind: LedgerKind,
    ref: string,
  ): Promise<PostResult> {
    const source = await this.ensureAccount(agentId, from);
    const destination = await this.ensureAccount(agentId, to);
    return this.postTransaction({
      kind,
      externalRef: `${kind}:${ref}`,
      entries: [
        { accountId: source, amountMicros: -amountMicros },
        { accountId: destination, amountMicros },
      ],
    });
  }

  /**
   * Settle a hand: move chips between the seated agents' `in_play` accounts, plus rake.
   *
   * Keyed on the hand id, so replaying a settlement — after a crash between the engine
   * writing the hand and the ledger acknowledging it — is a no-op rather than paying the
   * winner twice.
   */
  async settleHand(
    handId: string,
    deltas: readonly { agentId: string; amountMicros: number }[],
    rakeMicros = 0,
  ): Promise<PostResult> {
    const entries: EntryInput[] = [];
    for (const delta of deltas) {
      if (delta.amountMicros === 0) continue;
      entries.push({
        accountId: await this.ensureAccount(delta.agentId, 'in_play'),
        amountMicros: delta.amountMicros,
      });
    }
    if (rakeMicros > 0) {
      entries.push({ accountId: await this.ensureAccount(null, 'rake'), amountMicros: rakeMicros });
    }

    return this.postTransaction({
      kind: 'hand_settlement',
      externalRef: `hand:${handId}`,
      memo: `settlement for ${handId}`,
      entries,
    });
  }

  // -------------------------------------------------------------------------
  // Invariants
  // -------------------------------------------------------------------------

  /**
   * The global invariant: every entry ever written sums to zero.
   *
   * Runs as a scheduled job in production, not only in tests. An invariant worth asserting
   * is worth monitoring — and this one is cheap enough to check continuously and
   * catastrophic enough to be worth knowing about within minutes rather than at audit time.
   */
  async assertBalanced(): Promise<void> {
    const rows = await this.sql<{ total: string | null }[]>`
      SELECT COALESCE(SUM(amount_micros), 0)::text AS total FROM ledger_entries`;
    const total = Number(rows[0]?.total ?? 0);
    if (total !== 0) {
      throw new LedgerError(`ledger is unbalanced: all entries sum to ${total}, expected 0`);
    }
  }

  /** Transactions whose own entries do not sum to zero. Should always be empty. */
  async findUnbalancedTransactions(): Promise<{ txId: string; total: number }[]> {
    const rows = await this.sql<{ tx_id: string; total: string }[]>`
      SELECT tx_id, SUM(amount_micros)::text AS total
      FROM ledger_entries GROUP BY tx_id HAVING SUM(amount_micros) <> 0`;
    return rows.map((r) => ({ txId: r.tx_id, total: Number(r.total) }));
  }

  /** Agent accounts sitting below zero. Should always be empty. */
  async findNegativeAgentAccounts(): Promise<{ accountId: string; balance: number }[]> {
    const rows = await this.sql<{ account_id: string; balance: string }[]>`
      SELECT e.account_id, SUM(e.amount_micros)::text AS balance
      FROM ledger_entries e
      JOIN accounts a ON a.id = e.account_id
      WHERE a.agent_id IS NOT NULL
      GROUP BY e.account_id HAVING SUM(e.amount_micros) < 0`;
    return rows.map((r) => ({ accountId: r.account_id, balance: Number(r.balance) }));
  }
}
