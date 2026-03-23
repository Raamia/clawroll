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
import { HandArchive } from './archive.js';
import { InMemoryAgentDirectory } from './auth.js';
import { BankrollService } from './bankroll.js';
import { ClawrollServer, DEFAULT_SERVER_CONFIG } from './server.js';
import { Bot, callingStation, randomBot, tightAggressive } from './bots/agent.js';
import type { TableConfig } from './table.js';

const PORT = Number(process.env['PORT'] ?? 8080);

const TABLE: TableConfig = {
  tableId: 'main',
  smallBlind: 50_000,
  bigBlind: 100_000,
  maxSeats: 6,
  minBuyIn: 2_000_000,
  maxBuyIn: 20_000_000,
  // Slower than production so a human watching can actually follow the action.
  actionTimeoutMs: 4_000,
  seedTimeoutMs: 1_000,
};

async function main(): Promise<void> {
  const sql = createSql();
  await migrate(sql);

  const ledger = new Ledger(sql);
  const bankroll = new BankrollService(sql, ledger);
  const archive = new HandArchive(sql);
  const directory = new InMemoryAgentDirectory();

  const server = new ClawrollServer(
    {
      ...DEFAULT_SERVER_CONFIG,
      port: PORT,
      table: TABLE,
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

  const strategies = [tightAggressive, callingStation, randomBot(7), randomBot(42)];
  for (const [i, strategy] of strategies.entries()) {
    const agentId = `dev-${strategy.name}-${randomUUID().slice(0, 6)}`;
    await sql`
      INSERT INTO agents (id, display_name, key_prefix, key_hash, derivation_index, deposit_address)
      VALUES (${agentId}, ${strategy.name}, ${randomUUID()}, ${'dev'},
              ${Date.now() * 10 + i}, ${randomUUID()})`;
    // Devnet play money, granted directly rather than deposited — this is a dev harness,
    // not a faucet. Funded deep on purpose: a bot that busts through its bankroll cannot
    // afford the re-buy, and a table that drains to one player stops dealing entirely.
    await ledger.creditDeposit(agentId, 2_000_000_000, `dev:${randomUUID()}`);

    const { apiKey } = directory.register(agentId, strategy.name);
    const bot = new Bot({
      url: `ws://127.0.0.1:${PORT}`,
      apiKey,
      tableId: TABLE.tableId,
      buyIn: 10_000_000,
      strategy,
      rebuys: 1_000,
      // Real agents think; local ones do not, and a hand that finishes in a millisecond is
      // not something a spectator can watch.
      thinkMs: 600,
    });
    await bot.connect();
    console.log(`  seated         ${strategy.name}`);
  }

  const report = setInterval(() => {
    console.log(
      `hands ${server.table.handCount} · chips on table ${server.table.totalChips() / 1_000_000} USDC`,
    );
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
