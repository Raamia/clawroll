import { describe, expect, it } from 'vitest';
import { createSql } from './client.js';

/**
 * Session settings the pool applies to every connection.
 *
 * These exist because of a production wedge that no restart-free path could undo: the
 * engine's ten pool connections all ended up inside transactions that were never going to
 * complete, every public read queued behind them, and the site served loading skeletons
 * until a redeploy. Postgres can end a session like that on its own — if asked to. This
 * checks that we ask, and that the pool comes back healthy afterwards, which is the part
 * that turns "an error" into "self-healing".
 */
describe('pool session settings', () => {
  it('ends a session left idle inside a transaction, and the pool recovers', async () => {
    // One connection, so the second query below can only succeed if that one connection
    // was replaced after Postgres terminated it.
    const sql = createSql(undefined, { max: 1, idleInTransactionTimeoutMs: 200 });
    try {
      await expect(
        sql.begin(async (tx) => {
          await tx`SELECT 1`;
          // Idle inside the transaction, for longer than the session is allowed to be.
          await new Promise((r) => setTimeout(r, 700));
          await tx`SELECT 1`;
        }),
      ).rejects.toThrow();

      const rows = await sql<{ one: number }[]>`SELECT 1::int AS one`;
      expect(rows[0]?.one).toBe(1);
    } finally {
      await sql.end();
    }
  }, 15_000);

  it('bounds a statement when asked to, and leaves it unbounded otherwise', async () => {
    const bounded = createSql(undefined, { max: 1, statementTimeoutMs: 100 });
    const unbounded = createSql(undefined, { max: 1 });
    try {
      await expect(bounded`SELECT pg_sleep(0.5)`).rejects.toThrow(/statement timeout/);
      // The pool that runs migrations must be allowed to take its time.
      await expect(unbounded`SELECT pg_sleep(0.3)`).resolves.toBeDefined();
    } finally {
      await bounded.end();
      await unbounded.end();
    }
  }, 15_000);
});
