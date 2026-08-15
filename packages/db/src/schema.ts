/**
 * Postgres schema.
 *
 * ## Money is a double-entry ledger, and the ledger is the truth
 *
 * There is no `balance` column anywhere. A balance is `SUM(amount_micros)` over an
 * account's entries, always. A stored balance is a second source of truth that can
 * disagree with the first, and when it does there is no way to tell which one is
 * wrong — the failure mode is a number that looks authoritative and is not. Deriving it
 * costs an indexed aggregate and buys the guarantee that the history and the balance can
 * never diverge, because there is only one of them.
 *
 * ## Amounts are integers of micro-USDC, bounded by the database
 *
 * 1 USDC = 1,000,000. Chips at a table are the same unit, so a buy-in, a bet and a ledger
 * entry are the same number with no conversion and therefore no rounding anywhere.
 *
 * The column is `BIGINT`, which can hold values JavaScript's `number` cannot represent
 * exactly. Rather than reach for `BigInt` in the application — which would mean two
 * numeric representations in one money system, and a conversion at every boundary — a
 * `CHECK` constraint bounds every amount to ±2^53−1. **The database enforces what the
 * type system assumes.** One representation everywhere, and the unrepresentable case is
 * impossible rather than merely unlikely.
 *
 * ## `external_ref` is the idempotency key
 *
 * A deposit's `external_ref` is its Solana transaction signature, and it is `UNIQUE`.
 * That single constraint is what makes double-crediting *impossible* rather than
 * unlikely: a scanner that sees the same transaction twice — after a restart, a retry, or
 * an overlapping poll window — gets a constraint violation on the second insert instead of
 * silently paying twice. It is the most important line in this file.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** Largest magnitude JavaScript can represent exactly. */
export const MAX_SAFE_MICROS = 9_007_199_254_740_991n;

export const accountTypeEnum = pgEnum('account_type', [
  /** Settled funds an agent may buy in with or withdraw. */
  'available',
  /** Funds committed to a table and unavailable until cash-out. */
  'in_play',
  /** The platform's on-chain custody position. */
  'treasury',
  /** Rake taken from pots. */
  'rake',
  /** Balancing counterparty for deposits and withdrawals. */
  'house',
]);

export const ledgerKindEnum = pgEnum('ledger_kind', [
  'deposit',
  'withdrawal',
  'buy_in',
  'cash_out',
  'hand_settlement',
  'rake',
  'adjustment',
  // Chips moved between house bots so a permanently-running room never empties. Its own
  // kind rather than 'adjustment', because "the operator moved money between its own bots"
  // and "somebody corrected a mistake" are different claims and should be separable in an
  // audit.
  'rebalance',
]);

export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  /** Public half of the API key — indexed so a key can be found without hashing every row. */
  keyPrefix: text('key_prefix').notNull().unique(),
  keyHash: text('key_hash').notNull(),
  /** Index into the HD derivation path. Assigned once and never reused. */
  derivationIndex: bigint('derivation_index', { mode: 'number' }).notNull().unique(),
  depositAddress: text('deposit_address').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    /** Null for system accounts (treasury, rake, house). */
    agentId: text('agent_id').references(() => agents.id),
    type: accountTypeEnum('type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Exactly one account per agent per type. Postgres treats NULLs as distinct in a
    // unique index, so this has to be a partial index or every system account would be
    // allowed to exist many times over.
    uniqueIndex('accounts_agent_type_key')
      .on(table.agentId, table.type)
      .where(sql`${table.agentId} IS NOT NULL`),
    uniqueIndex('accounts_system_type_key')
      .on(table.type)
      .where(sql`${table.agentId} IS NULL`),
  ],
);

export const ledgerTxs = pgTable(
  'ledger_txs',
  {
    id: text('id').primaryKey(),
    kind: ledgerKindEnum('kind').notNull(),
    /**
     * External identity of this transaction — the Solana signature for a deposit, the
     * hand id for a settlement. UNIQUE, and the reason a replayed event cannot double-pay.
     */
    externalRef: text('external_ref').unique(),
    memo: text('memo'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ledger_txs_created_at_idx').on(table.createdAt)],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: text('id').primaryKey(),
    txId: text('tx_id')
      .notNull()
      .references(() => ledgerTxs.id),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    /** Signed micro-USDC. Debits are negative, credits positive; each tx sums to zero. */
    amountMicros: bigint('amount_micros', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Balances are derived, so this index is what makes them cheap.
    index('ledger_entries_account_idx').on(table.accountId),
    index('ledger_entries_tx_idx').on(table.txId),
    // The database enforces what the application's `number` type assumes.
    check(
      'ledger_entries_amount_safe_range',
      sql`${table.amountMicros} BETWEEN -${MAX_SAFE_MICROS} AND ${MAX_SAFE_MICROS}`,
    ),
    // A zero-amount entry is always a bug: it records a movement that did not happen.
    check('ledger_entries_amount_nonzero', sql`${table.amountMicros} <> 0`),
  ],
);

/** Deposits the scanner has observed, keyed by signature so a replay is a no-op. */
export const depositSightings = pgTable('deposit_sightings', {
  signature: text('signature').primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id),
  amountMicros: bigint('amount_micros', { mode: 'number' }).notNull(),
  slot: bigint('slot', { mode: 'number' }).notNull(),
  creditedTxId: text('credited_tx_id').references(() => ledgerTxs.id),
  seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Agent = typeof agents.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type LedgerTx = typeof ledgerTxs.$inferSelect;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type AccountType = (typeof accountTypeEnum.enumValues)[number];
export type LedgerKind = (typeof ledgerKindEnum.enumValues)[number];
