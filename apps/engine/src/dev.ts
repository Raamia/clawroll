/**
 * The whole stack, locally, in one command.
 *
 *   pnpm dev:infra     # Postgres + Redis
 *   pnpm dev           # this
 *   pnpm --filter @clawroll/web dev
 *
 * Runs the real server — real ledger, real archive, real WebSockets — on a fixed port, with
 * a few bots seated so there is something to watch. Nothing here is a mock: the spectator app
 * talks to exactly the code that will run on ECS.
 */

import { randomUUID } from 'node:crypto';
import { Ledger, createSql, migrate } from '@clawroll/db';
import { PostgresAgentDirectory } from './agent-directory.js';
import { HandArchive } from './archive.js';
import { InMemoryAgentDirectory } from './auth.js';
import { BankrollService } from './bankroll.js';
import { ClawrollServer, DEFAULT_SERVER_CONFIG } from './server.js';
import { Bot, callingStation, randomBot, tightAggressive } from './bots/agent.js';
import type { TableConfig } from './table.js';

const PORT = Number(process.env['PORT'] ?? 8080);

/**
 * Two tables, mirroring the deployed room.
 *
 * Unraked, like production and for the same reason: bot poker is zero-sum, so with no rake
 * the chips circulate and the game runs indefinitely. A rake drains the table instead — 5%
 * took 32.67 of 40 USDC off the real room in about four minutes.
 */
const TABLES: TableConfig[] = [
  {
    tableId: 'main',
    smallBlind: 10_000,
    bigBlind: 20_000,
    maxSeats: 6,
    minBuyIn: 1_000_000,
    maxBuyIn: 5_000_000,
    // Slower than production so a human watching can actually follow the action.
    actionTimeoutMs: 4_000,
    seedTimeoutMs: 1_000,
  },
  {
    tableId: 'high',
    smallBlind: 50_000,
    bigBlind: 100_000,
    maxSeats: 6,
    minBuyIn: 1_000_000,
    maxBuyIn: 5_000_000,
    actionTimeoutMs: 4_000,
    seedTimeoutMs: 1_000,
  },
];

async function main(): Promise<void> {
  const sql = createSql();
  await migrate(sql);

  const ledger = new Ledger(sql);
  const bankroll = new BankrollService(sql, ledger);
  const archive = new HandArchive(sql);
  // Two directories, chained.
  //
  // The demo bots are minted in-process and never persisted, but anyone following the
  // quickstart registers through the CLI and lands in Postgres — and it is precisely that
  // person whose first connection must work. Using only the in-memory directory here meant a
  // freshly registered agent was rejected with `unauthorized`, which reads as a broken key
  // rather than a dev-harness gap.
  const memory = new InMemoryAgentDirectory();
  const persisted = new PostgresAgentDirectory(sql);
  await persisted.warm();
  persisted.startRefreshing(5_000);

  const directory = {
    authenticate: (apiKey: string) => memory.authenticate(apiKey) ?? persisted.authenticate(apiKey),
  };

  const server = new ClawrollServer(
    {
      ...DEFAULT_SERVER_CONFIG,
      port: PORT,
      tables: TABLES,
      autoStartHands: true,
      // Slow enough that a person watching can follow a hand.
      handIntervalMs: 4_000,
    },
    directory,
    bankroll,
    archive,
  );
  await server.start();

  console.log(`clawroll engine  http://127.0.0.1:${PORT}`);
  console.log(`  health         /healthz`);
  console.log(`  read api       /api/tables  /api/hands  /api/leaderboard`);
  console.log(`  spectate       ws://127.0.0.1:${PORT}/spectate`);

  // Five per table, which is what a room worth watching looks like — heads-up poker between
  // two bots is mostly blinds.
  const strategies = [
    tightAggressive, callingStation, randomBot(7), randomBot(42), randomBot(11),
    tightAggressive, callingStation, randomBot(3), randomBot(23), randomBot(31),
  ];
  for (const [i, strategy] of strategies.entries()) {
    const table = TABLES[i % TABLES.length]!;
    // Suffixed with the table, because the same strategy is seated at both and two seats
    // labelled `calling-station` on different tables is confusing to watch.
    const displayName = `${strategy.name}-${table.tableId}`;
    const agentId = `dev-${displayName}-${randomUUID().slice(0, 6)}`;
    await sql`
      INSERT INTO agents (id, display_name, key_prefix, key_hash, derivation_index, deposit_address)
      VALUES (${agentId}, ${displayName}, ${randomUUID()}, ${'dev'},
              ${Date.now() * 10 + i}, ${randomUUID()})`;
    // Devnet play money, granted directly rather than deposited — this is a dev harness,
    // not a faucet. Funded deep on purpose: a bot that busts through its bankroll cannot
    // afford the re-buy, and a table that drains to one player stops dealing entirely.
    await ledger.creditDeposit(agentId, 2_000_000_000, `dev:${randomUUID()}`);

    const { apiKey } = memory.register(agentId, displayName);
    const bot = new Bot({
      url: `ws://127.0.0.1:${PORT}`,
      apiKey,
      tableId: table.tableId,
      // Must sit inside the table's own bounds. It was 10 USDC against a maxBuyIn of 5,
      // so every seating was refused and the room sat empty with the bots reporting
      // themselves as "seated" — they had connected, not sat down.
      buyIn: 5_000_000,
      strategy,
      rebuys: 1_000,
      // Real agents think; local ones do not, and a hand that finishes in a millisecond is
      // not something a spectator can watch.
      thinkMs: 600,
    });
    await bot.connect();
    console.log(`  seated         ${displayName}`);
  }

  const report = setInterval(() => {
    const line = [...server.tables.values()]
      .map((t) => `${t.tableId} ${t.handCount} hands / ${t.totalChips() / 1_000_000} USDC`)
      .join(' · ');
    console.log(line);
  }, 15_000);
  report.unref();

  const shutdown = async () => {
    clearInterval(report);
    await server.stop();
    await sql.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();
