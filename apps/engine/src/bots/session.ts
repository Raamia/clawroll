/**
 * Runnable demo: start a table, seat some bots, let them play.
 *
 *   npx tsx apps/engine/src/bots/session.ts [hands]
 *
 * Everything runs in one process over real WebSockets — the same server, protocol and
 * runtime that will run on ECS, just with the bots next door. It exists to make the whole
 * stack executable in one command, and to be the thing a new contributor runs first.
 *
 * The audit at the end is the point. It re-derives every hand from the published messages
 * and checks it with the standalone verifier, so a run does not merely finish, it finishes
 * *provably fairly*.
 */

import WebSocket from 'ws';
import type { ServerMessage } from '@clawroll/protocol';
import { verifyHand } from '@clawroll/shuffle';
import { InMemoryAgentDirectory } from '../auth.js';
import { ClawrollServer, DEFAULT_SERVER_CONFIG } from '../server.js';
import type { TableConfig } from '../table.js';
import { Bot, callingStation, randomBot, tightAggressive } from './agent.js';

export const DEMO_TABLE: TableConfig = {
  tableId: 'demo',
  smallBlind: 50,
  bigBlind: 100,
  maxSeats: 6,
  minBuyIn: 2_000,
  maxBuyIn: 20_000,
  actionTimeoutMs: 2_000,
  seedTimeoutMs: 500,
};

export interface SessionResult {
  readonly handsPlayed: number;
  readonly chipsAtStart: number;
  readonly chipsAtEnd: number;
  readonly verifiedHands: number;
  readonly failedHands: string[];
  readonly botErrors: string[];
  readonly standings: { name: string; agentId: string; stack: number }[];
}

/**
 * A spectator that records the public feed, which is exactly what a verifier gets.
 *
 * Auditing from this stream rather than from server internals is deliberate: if a hand can
 * be verified from what a random onlooker saw, the fairness claim holds for everyone.
 */
class Auditor {
  readonly messages: ServerMessage[] = [];
  private socket: WebSocket | null = null;

  async connect(url: string): Promise<void> {
    const socket = new WebSocket(`${url}/spectate`);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    socket.on('message', (data) => this.messages.push(JSON.parse(data.toString()) as ServerMessage));
  }

  close(): void {
    this.socket?.close();
  }

  /** Verify every completed hand using only what was broadcast publicly. */
  audit(): { verified: number; failed: string[] } {
    const starts = new Map<string, Extract<ServerMessage, { type: 'hand_start' }>>();
    const boards = new Map<string, string>();
    let verified = 0;
    const failed: string[] = [];

    for (const message of this.messages) {
      if (message.type === 'hand_start') starts.set(message.handId, message);
      if (message.type === 'street') boards.set(message.handId, message.board);

      if (message.type === 'hand_end') {
        const started = starts.get(message.handId);
        if (!started) continue;

        const board = boards.get(message.handId) ?? '';
        const result = verifyHand({
          handId: message.handId,
          commit: started.commit,
          serverSeed: message.serverSeed,
          clientSeeds: message.clientSeeds,
          seats: started.seats.filter((s) => s.status !== 'empty').map((s) => s.seat),
          buttonSeat: started.buttonSeat,
          ...(board !== '' ? { board } : {}),
        });

        if (result.ok) verified++;
        else failed.push(`${message.handId}: ${result.checks.find((c) => !c.passed)?.detail ?? '?'}`);
      }
    }
    return { verified, failed };
  }
}

export async function runSession(targetHands = 20): Promise<SessionResult> {
  const directory = new InMemoryAgentDirectory();
  const server = new ClawrollServer(
    { ...DEFAULT_SERVER_CONFIG, port: 0, table: DEMO_TABLE, autoStartHands: true },
    directory,
  );
  const port = await server.start();
  const url = `ws://127.0.0.1:${port}`;

  const auditor = new Auditor();
  await auditor.connect(url);

  const strategies = [callingStation, tightAggressive, randomBot(7), randomBot(42)];
  const bots = strategies.map((strategy, i) => {
    const { apiKey } = directory.register(`agent-${i}`, strategy.name);
    return new Bot({ url, apiKey, tableId: DEMO_TABLE.tableId, buyIn: 10_000, strategy, rebuys: 20 });
  });

  await Promise.all(bots.map((bot) => bot.connect()));

  // Wait for the target, but never forever: a stalled table should fail the run rather
  // than hang a CI job.
  const deadline = Date.now() + 30_000;
  while (server.table.handCount < targetHands && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const standings = bots.map((bot, i) => ({
    name: bot.name,
    agentId: `agent-${i}`,
    stack: server.table.stackOf(`agent-${i}`) ?? 0,
  }));

  // Taken from the table, not from the bots. Bots re-buy after busting, and a client's
  // own count would include buy-ins the server rejected — the engine is the authority on
  // how many chips actually entered.
  const chipsAtStart = server.table.totalBoughtIn;

  const { verified, failed } = auditor.audit();
  const result: SessionResult = {
    handsPlayed: server.table.handCount,
    chipsAtStart,
    chipsAtEnd: server.table.totalChips() + server.table.totalCashedOut,
    verifiedHands: verified,
    failedHands: failed,
    botErrors: bots.flatMap((bot) => bot.errors),
    standings,
  };

  for (const bot of bots) bot.close();
  auditor.close();
  await server.stop();
  return result;
}

/** Entry point when run directly. */
async function main(): Promise<void> {
  const hands = Number(process.argv[2] ?? 20);
  console.log(`Clawroll demo — playing ${hands} hands\n`);

  const result = await runSession(hands);

  console.log(`hands played      ${result.handsPlayed}`);
  console.log(`hands verified    ${result.verifiedHands}`);
  console.log(`chips in / out    ${result.chipsAtStart} / ${result.chipsAtEnd}`);
  console.log(
    `conservation      ${result.chipsAtStart === result.chipsAtEnd ? 'OK' : 'VIOLATED'}\n`,
  );

  console.log('standings (stack now)');
  for (const s of [...result.standings].sort((a, b) => b.stack - a.stack)) {
    console.log(`  ${s.name.padEnd(18)} ${String(s.stack).padStart(7)}`);
  }

  if (result.failedHands.length > 0) {
    console.error('\nUNVERIFIED HANDS:');
    for (const failure of result.failedHands) console.error(`  ${failure}`);
  }
  if (result.botErrors.length > 0) {
    console.error('\nbot errors:');
    for (const error of [...new Set(result.botErrors)]) console.error(`  ${error}`);
  }

  const ok =
    result.chipsAtStart === result.chipsAtEnd &&
    result.failedHands.length === 0 &&
    result.handsPlayed > 0;
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1]?.endsWith('session.ts')) void main();
