/**
 * `@clawroll/db` — Postgres schema and the double-entry ledger.
 *
 * Every movement of money is a transaction whose entries sum to exactly zero, and
 * balances are derived from those entries rather than stored. There is no second source
 * of truth to disagree with the first.
 */
export * from './client.js';
export * from './ledger.js';
export * from './migrate.js';
export * from './schema.js';
