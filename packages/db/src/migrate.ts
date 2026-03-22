/**
 * Schema migration.
 *
 * The DDL is hand-written rather than generated, because the constraints *are* the
 * correctness mechanism here and they should be readable in one place: the `UNIQUE` on
 * `external_ref` that makes double-crediting impossible, the partial unique indexes that
 * allow exactly one system account per type, and the `CHECK` that bounds amounts to what
 * JavaScript can represent exactly.
 *
 * `schema.ts` declares the same shapes for typed queries. Those two could drift, so
 * `ledger.test.ts` interrogates `information_schema` and asserts every constraint listed
 * here actually exists on the live database — a declared constraint that was never
 * created is worse than no constraint, because the code is written trusting it.
 */

import type { Sql } from 'postgres';

export const MIGRATIONS: readonly { name: string; sql: string }[] = [
  {
    name: '001_initial',
    sql: /* sql */ `
      DO $$ BEGIN
        CREATE TYPE account_type AS ENUM ('available','in_play','treasury','rake','house');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE TYPE ledger_kind AS ENUM
          ('deposit','withdrawal','buy_in','cash_out','hand_settlement','rake','adjustment');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      CREATE TABLE IF NOT EXISTS agents (
        id                TEXT PRIMARY KEY,
        display_name      TEXT NOT NULL,
        key_prefix        TEXT NOT NULL UNIQUE,
        key_hash          TEXT NOT NULL,
        derivation_index  BIGINT NOT NULL UNIQUE,
        deposit_address   TEXT NOT NULL UNIQUE,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS accounts (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT REFERENCES agents(id),
        type        account_type NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Postgres treats NULLs as distinct in a unique index, so one index cannot cover
      -- both agent accounts and system accounts. Two partial indexes do.
      CREATE UNIQUE INDEX IF NOT EXISTS accounts_agent_type_key
        ON accounts (agent_id, type) WHERE agent_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS accounts_system_type_key
        ON accounts (type) WHERE agent_id IS NULL;

      CREATE TABLE IF NOT EXISTS ledger_txs (
        id            TEXT PRIMARY KEY,
        kind          ledger_kind NOT NULL,
        -- The idempotency key. A Solana signature seen twice hits this and cannot pay twice.
        external_ref  TEXT UNIQUE,
        memo          TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS ledger_txs_created_at_idx ON ledger_txs (created_at);

      CREATE TABLE IF NOT EXISTS ledger_entries (
        id             TEXT PRIMARY KEY,
        tx_id          TEXT NOT NULL REFERENCES ledger_txs(id),
        account_id     TEXT NOT NULL REFERENCES accounts(id),
        amount_micros  BIGINT NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        -- The database enforces what the application's \`number\` type assumes.
        CONSTRAINT ledger_entries_amount_safe_range
          CHECK (amount_micros BETWEEN -9007199254740991 AND 9007199254740991),
        -- A zero entry records a movement that did not happen.
        CONSTRAINT ledger_entries_amount_nonzero CHECK (amount_micros <> 0)
      );
      CREATE INDEX IF NOT EXISTS ledger_entries_account_idx ON ledger_entries (account_id);
      CREATE INDEX IF NOT EXISTS ledger_entries_tx_idx ON ledger_entries (tx_id);

      CREATE TABLE IF NOT EXISTS deposit_sightings (
        signature       TEXT PRIMARY KEY,
        agent_id        TEXT NOT NULL REFERENCES agents(id),
        amount_micros   BIGINT NOT NULL,
        slot            BIGINT NOT NULL,
        credited_tx_id  TEXT REFERENCES ledger_txs(id),
        seen_at         TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    name: '002_withdrawals',
    sql: /* sql */ `
      DO $$ BEGIN
        CREATE TYPE withdrawal_status AS ENUM
          ('debited','signed','sent','confirmed','failed','refunded');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      CREATE TABLE IF NOT EXISTS withdrawals (
        id                       TEXT PRIMARY KEY,
        agent_id                 TEXT NOT NULL REFERENCES agents(id),
        destination              TEXT NOT NULL,
        amount_micros            BIGINT NOT NULL CHECK (amount_micros > 0),
        status                   withdrawal_status NOT NULL,
        ledger_tx_id             TEXT REFERENCES ledger_txs(id),
        -- Recorded BEFORE the transaction is broadcast. After a crash this is the only
        -- way to ask the chain what happened instead of guessing.
        signature                TEXT UNIQUE,
        blockhash                TEXT,
        -- A Solana transaction whose blockhash is past this height can never be included.
        -- That is what makes rebuilding provably safe rather than a gamble.
        last_valid_block_height  BIGINT,
        attempts                 INTEGER NOT NULL DEFAULT 0,
        error                    TEXT,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS withdrawals_status_idx ON withdrawals (status);
      CREATE INDEX IF NOT EXISTS withdrawals_agent_idx ON withdrawals (agent_id);
    `,
  },
];

/** Apply any migration that has not run. Safe to call repeatedly. */
export async function migrate(sql: Sql): Promise<string[]> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  const applied = new Set(
    (await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name),
  );

  const ran: string[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    await sql.unsafe(migration.sql);
    await sql`INSERT INTO schema_migrations (name) VALUES (${migration.name})`;
    ran.push(migration.name);
  }
  return ran;
}

/** Drop everything. Test-only — it is deliberately explicit about being destructive. */
export async function dropAllTablesForTests(sql: Sql): Promise<void> {
  await sql.unsafe(`
    DROP TABLE IF EXISTS withdrawals, deposit_sightings, ledger_entries, ledger_txs, accounts,
      agents, schema_migrations CASCADE;
    DROP TYPE IF EXISTS account_type, ledger_kind, withdrawal_status CASCADE;
  `);
}
