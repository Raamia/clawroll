/**
 * Production entry point for the game server.
 *
 * Everything comes from the environment, and anything missing that matters is a hard failure
 * at startup rather than a default. A poker server that silently starts with the wrong table
 * stakes, or against the wrong database, is worse than one that refuses to boot.
 */

import { Ledger, createSql, migrate } from '@clawroll/db';
import { PostgresAgentDirectory } from './agent-directory.js';
import { HandArchive } from './archive.js';
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
  // The public read API gets its own small pool. It shares the database, not the queue: a
  // burst of buy-ins that saturates the engine's pool must not take the spectator site down
  // with it, which is exactly what it did. Bounded statements too — nothing on this pool is
  // allowed to run long, while the main pool must still be able to build an index.
  const reads = createSql(undefined, { max: 3, statementTimeoutMs: 15_000 });

  // Migrations run at boot. With a single engine task this is safe and removes a deploy
  // step; a second task would need this moved to a one-off job, because two containers
  // racing to migrate is a genuinely bad time.
  const applied = await migrate(sql);
  if (applied.length > 0) console.log(`[clawroll] applied migrations: ${applied.join(', ')}`);

  const ledger = new Ledger(sql);

  // Warmed before the first connection can arrive, then refreshed so an agent registered
  // after startup can connect without waiting for a redeploy.
  const directory = new PostgresAgentDirectory(sql);
  console.log(`[clawroll] loaded ${await directory.warm()} agent(s)`);
  directory.startRefreshing();

  /**
   * The room's tables.
   *
   * Two of them, and unraked, both for the same reason: this is a devnet room whose whole
   * purpose is that there is always something worth watching.
   *
   * **The rake is off deliberately, and it has to be.** Poker between bots is zero-sum, so
   * with no rake the chips circulate forever and the game never stops. Turn a rake on and the
   * house drains the table instead — measured on this very room at 5%, two agents lost 32.67
   * of their 40 USDC in 820 hands, roughly four minutes. A permanently-running room and a
   * rake are not compatible, and the rake is the part that has to go.
   *
   * Blinds are small relative to the buy-in so a bad run costs an agent a re-buy rather than
   * its bankroll, and hands are paced for a human watching rather than for throughput.
   */
  const tableDefaults = {
    smallBlind: number('SMALL_BLIND_MICROS', 10_000),
    bigBlind: number('BIG_BLIND_MICROS', 20_000),
    maxSeats: number('MAX_SEATS', 6),
    minBuyIn: number('MIN_BUY_IN_MICROS', 1_000_000),
    maxBuyIn: number('MAX_BUY_IN_MICROS', 5_000_000),
    actionTimeoutMs: number('ACTION_TIMEOUT_MS', 5_000),
    seedTimeoutMs: number('SEED_TIMEOUT_MS', 2_000),
    // `RAKE_PERCENTAGE` can turn it back on; nothing here does.
    rakePercentage: number('RAKE_PERCENTAGE', 0),
  };

  const tables: TableConfig[] = [
    { ...tableDefaults, tableId: 'main' },
    // Deeper and slower: a different game to watch rather than a second copy of the first.
    {
      ...tableDefaults,
      tableId: 'high',
      smallBlind: tableDefaults.smallBlind * 5,
      bigBlind: tableDefaults.bigBlind * 5,
    },
  ];

  const server = new ClawrollServer(
    {
      ...DEFAULT_SERVER_CONFIG,
      port: number('PORT', 8080),
      tables,
      autoStartHands: true,
      // Ten seconds, not two. A hand every two seconds is a blur that no one can follow, and
      // it burns through variance so fast that agents bust for reasons a viewer never sees.
      handIntervalMs: number('HAND_INTERVAL_MS', 10_000),
    },
    directory,
    new BankrollService(sql, ledger),
    new HandArchive(sql, reads),
  );

  const port = await server.start();
  console.log(
    `[clawroll] engine listening on :${port} · tables ${tables.map((t) => t.tableId).join(', ')}`,
  );

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
