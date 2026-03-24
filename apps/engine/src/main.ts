/**
 * Production entry point for the game server.
 *
 * Everything comes from the environment, and anything missing that matters is a hard failure
 * at startup rather than a default. A poker server that silently starts with the wrong table
 * stakes, or against the wrong database, is worse than one that refuses to boot.
 */

import { Ledger, createSql, migrate } from '@clawroll/db';
import { HandArchive } from './archive.js';
import { InMemoryAgentDirectory } from './auth.js';
import { BankrollService } from './bankroll.js';
import { ClawrollServer, DEFAULT_SERVER_CONFIG } from './server.js';
import type { TableConfig } from './table.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got ${raw}`);
  return parsed;
}

async function main(): Promise<void> {
  // Fails loudly in production if unset — see `databaseUrl()`.
  const sql = createSql();

  // Migrations run at boot. With a single engine task this is safe and removes a deploy
  // step; a second task would need this moved to a one-off job, because two containers
  // racing to migrate is a genuinely bad time.
  const applied = await migrate(sql);
  if (applied.length > 0) console.log(`[clawroll] applied migrations: ${applied.join(', ')}`);

  const ledger = new Ledger(sql);
  const table: TableConfig = {
    tableId: process.env['TABLE_ID'] ?? 'main',
    smallBlind: number('SMALL_BLIND_MICROS', 50_000),
    bigBlind: number('BIG_BLIND_MICROS', 100_000),
    maxSeats: number('MAX_SEATS', 6),
    minBuyIn: number('MIN_BUY_IN_MICROS', 2_000_000),
    maxBuyIn: number('MAX_BUY_IN_MICROS', 20_000_000),
    actionTimeoutMs: number('ACTION_TIMEOUT_MS', 5_000),
    seedTimeoutMs: number('SEED_TIMEOUT_MS', 2_000),
  };

  const server = new ClawrollServer(
    {
      ...DEFAULT_SERVER_CONFIG,
      port: number('PORT', 8080),
      table,
      autoStartHands: true,
      handIntervalMs: number('HAND_INTERVAL_MS', 2_000),
    },
    // TODO(M7): a Postgres-backed directory. The interface exists precisely so this swap is
    // a one-line change; until agent registration ships there is nothing to read.
    new InMemoryAgentDirectory(),
    new BankrollService(sql, ledger),
    new HandArchive(sql),
  );

  const port = await server.start();
  console.log(`[clawroll] engine listening on :${port} · table ${table.tableId}`);

  // ECS sends SIGTERM and waits before SIGKILL. Closing sockets deliberately means agents
  // see a clean close and can reconnect, rather than a hand vanishing mid-action.
  const shutdown = async (signal: string) => {
    console.log(`[clawroll] ${signal} received, shutting down`);
    await server.stop();
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error('[clawroll] engine failed to start:', error);
  process.exit(1);
});
