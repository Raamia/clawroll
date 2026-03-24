/**
 * Postgres-backed agent authentication.
 *
 * The in-memory directory was fine while nothing depended on keys surviving a restart. An
 * SDK changes that: an agent author who has to re-register every time the server redeploys
 * does not have a usable product.
 *
 * ## Registration is not an endpoint here
 *
 * There is no public "sign up" route, and that is deliberate on two counts.
 *
 * First, minting an API key is minting an identity that can sit at a table, so an
 * unauthenticated endpoint is an invitation to fill every seat with throwaway agents.
 *
 * Second and more importantly, creating an agent means deriving its deposit address, which
 * means holding the master seed. That seed lives in exactly one process — the wallet worker
 * — and adding a second one that needs it would double the blast radius of a compromise for
 * the sake of convenience. So registration is a CLI in the worker (`register.ts`), and the
 * engine only ever *reads* this table.
 *
 * Self-service registration is a real feature and it will need a different shape: the engine
 * creating a row without an address, and the worker backfilling one. That is deliberately not
 * bodged in here.
 */

import type { Sql } from '@clawroll/db';
import { type AgentDirectory, type AgentRecord, hashSecret, parseKey } from './auth.js';
import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time comparison, same reasoning as `auth.ts`: `===` on a digest leaks through
 * timing how many leading characters matched.
 */
function digestsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export class PostgresAgentDirectory implements AgentDirectory {
  /**
   * Cached by key prefix.
   *
   * `authenticate` is called on every WebSocket connection, and the record it needs is
   * immutable once written — an agent's id, name and key hash never change. Caching avoids a
   * database round trip on every reconnect without introducing any staleness that matters.
   *
   * Deliberately not a cache of *authentication results*: the secret is still hashed and
   * compared every time, so a cached record cannot let a wrong key through.
   */
  private readonly byPrefix = new Map<string, AgentRecord>();

  constructor(private readonly sql: Sql) {}

  /**
   * Synchronous because `AgentDirectory` is, and the socket handler cannot await.
   *
   * That means a first connection for an uncached agent fails, and the retry succeeds once
   * `warm()` has run. Rather than leave that as a surprise, the directory is warmed at
   * startup and refreshed on a timer — see `startRefreshing`.
   */
  authenticate(apiKey: string): AgentRecord | null {
    const parsed = parseKey(apiKey);
    if (parsed === null) return null;

    const record = this.byPrefix.get(parsed.keyPrefix);
    if (record === undefined) return null;

    return digestsMatch(record.keyHash, hashSecret(parsed.secret)) ? record : null;
  }

  /** Load every agent. Cheap at this scale, and the table is append-mostly. */
  async warm(): Promise<number> {
    const rows = await this.sql<
      { id: string; display_name: string; key_prefix: string; key_hash: string }[]
    >`SELECT id, display_name, key_prefix, key_hash FROM agents`;

    for (const row of rows) {
      this.byPrefix.set(row.key_prefix, {
        agentId: row.id,
        displayName: row.display_name,
        keyPrefix: row.key_prefix,
        keyHash: row.key_hash,
      });
    }
    return rows.length;
  }

  /**
   * Re-read periodically so an agent registered after startup can connect.
   *
   * A newly registered agent would otherwise have to wait for a redeploy, which is a poor
   * first experience for exactly the person we most want to succeed — someone who has just
   * followed the quickstart.
   */
  startRefreshing(intervalMs = 30_000): NodeJS.Timeout {
    const timer = setInterval(() => {
      void this.warm().catch((error: unknown) => {
        console.error(`[clawroll] agent refresh failed: ${(error as Error).message}`);
      });
    }, intervalMs);
    timer.unref();
    return timer;
  }

  get size(): number {
    return this.byPrefix.size;
  }
}
