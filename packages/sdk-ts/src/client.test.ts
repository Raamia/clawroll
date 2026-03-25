import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Ledger, type Sql, createSql, migrate } from '@clawroll/db';
import {
  BankrollService,
  ClawrollServer,
  DEFAULT_SERVER_CONFIG,
  InMemoryAgentDirectory,
  type TableConfig,
} from '@clawroll/engine';
import { ClawrollAgent } from './client.js';
import type { Decision, Situation } from './types.js';

/**
 * Real server, real sockets, real Postgres.
 *
 * The SDK's whole promise is that an author writes one function and everything else is
 * handled — so the only test worth having is one where a bot written the documented way
 * actually plays hands.
 */
let sql: Sql;
let ledger: Ledger;
let bankroll: BankrollService;

const TABLE: TableConfig = {
  tableId: `sdk_${randomUUID().slice(0, 8)}`,
  smallBlind: 50_000,
  bigBlind: 100_000,
  maxSeats: 6,
  minBuyIn: 1_000_000,
  maxBuyIn: 20_000_000,
  actionTimeoutMs: 1_500,
  seedTimeoutMs: 500,
};

async function waitUntil(check: () => boolean, what: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  sql = createSql();
  await migrate(sql);
  ledger = new Ledger(sql);
  bankroll = new BankrollService(sql, ledger);
}, 30_000);

const servers: ClawrollServer[] = [];
const agents: ClawrollAgent[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) agent.close();
  for (const server of servers.splice(0)) await server.stop();
});

async function startTable() {
  const directory = new InMemoryAgentDirectory();
  const server = new ClawrollServer(
    { ...DEFAULT_SERVER_CONFIG, port: 0, table: TABLE, autoStartHands: true, handIntervalMs: 0 },
    directory,
    bankroll,
  );
  servers.push(server);
  return { server, directory, port: await server.start() };
}

async function fundedKey(directory: InMemoryAgentDirectory, name: string): Promise<string> {
  const agentId = `agent_${randomUUID()}`;
  await sql`
    INSERT INTO agents (id, display_name, key_prefix, key_hash, derivation_index, deposit_address)
    VALUES (${agentId}, ${name}, ${randomUUID()}, 'hash',
            ${Math.floor(Math.random() * 2 ** 40)}, ${randomUUID()})`;
  await ledger.creditDeposit(agentId, 100_000_000, `sig_${randomUUID()}`);
  return directory.register(agentId, name).apiKey;
}

/** A bot written exactly the way the quickstart documents. */
function passiveBot(port: number, apiKey: string, onHand?: () => void): ClawrollAgent {
  const agent = new ClawrollAgent({
    url: `ws://127.0.0.1:${port}`,
    apiKey,
    tableId: TABLE.tableId,
    buyIn: 5_000_000,
    rebuys: 50,
    act: ({ legal }) => (legal.canCheck ? { action: 'check' } : { action: 'call' }),
    onHandEnd: () => onHand?.(),
    onWarning: () => {},
  });
  agents.push(agent);
  return agent;
}

describe('a bot written the documented way plays hands', () => {
  it('connects, sits down, and finishes hands', async () => {
    // Everything the author did not write: seed contribution, requestId echo, buy-in,
    // re-buys. If any of it were missing, no hand would complete.
    const { server, directory, port } = await startTable();
    let handsSeen = 0;

    for (const name of ['alpha', 'beta']) {
      const key = await fundedKey(directory, name);
      await passiveBot(port, key, () => handsSeen++).connect();
    }

    await waitUntil(() => server.table.handCount >= 3, 'three hands');
    expect(handsSeen).toBeGreaterThan(0);
  }, 60_000);

  it('reports each hand result to the author', async () => {
    const { server, directory, port } = await startTable();
    const results: number[] = [];

    for (const name of ['gamma', 'delta']) {
      const key = await fundedKey(directory, name);
      const agent = new ClawrollAgent({
        url: `ws://127.0.0.1:${port}`,
        apiKey: key,
        tableId: TABLE.tableId,
        buyIn: 5_000_000,
        rebuys: 50,
        act: ({ legal }) => (legal.canCheck ? { action: 'check' } : { action: 'call' }),
        onHandEnd: (result) => results.push(result.net),
        onWarning: () => {},
      });
      agents.push(agent);
      await agent.connect();
    }

    await waitUntil(() => results.length >= 2, 'hand results');
    // Somebody wins and somebody loses; a hand where nothing moved would be suspicious.
    expect(results.some((n) => n !== 0)).toBe(true);
    expect(server.table.handCount).toBeGreaterThan(0);
  }, 60_000);
});

describe('the SDK protects the author from their own mistakes', () => {
  it('clamps an out-of-range raise instead of having it rejected', async () => {
    // An author who raises beyond their stack should get a message naming their bug, not an
    // `illegal_action` that reads like a server fault — and the hand should keep moving.
    const { server, directory, port } = await startTable();
    const warnings: string[] = [];

    for (const [i, name] of ['eps', 'zeta'].entries()) {
      const key = await fundedKey(directory, name);
      const agent = new ClawrollAgent({
        url: `ws://127.0.0.1:${port}`,
        apiKey: key,
        tableId: TABLE.tableId,
        buyIn: 5_000_000,
        rebuys: 50,
        act: ({ legal }): Decision => {
          if (i === 0 && (legal.canBet || legal.canRaise)) {
            // Deliberately absurd.
            return { action: legal.canBet ? 'bet' : 'raise', amount: 999_999_999_999 };
          }
          return legal.canCheck ? { action: 'check' } : { action: 'call' };
        },
        onWarning: (message) => warnings.push(message),
      });
      agents.push(agent);
      await agent.connect();
    }

    await waitUntil(() => server.table.handCount >= 2, 'hands to play');
    expect(warnings.some((w) => w.includes('clamped'))).toBe(true);
    // Crucially, no server-side rejection: the SDK caught it first.
    expect(warnings.some((w) => w.includes('illegal_action'))).toBe(false);
  }, 60_000);

  it('substitutes a legal action when the author picks an impossible one', async () => {
    const { server, directory, port } = await startTable();
    const warnings: string[] = [];

    for (const [i, name] of ['eta', 'theta'].entries()) {
      const key = await fundedKey(directory, name);
      const agent = new ClawrollAgent({
        url: `ws://127.0.0.1:${port}`,
        apiKey: key,
        tableId: TABLE.tableId,
        buyIn: 5_000_000,
        rebuys: 50,
        // Always checks, which is illegal when facing a bet.
        act: (): Decision => (i === 0 ? { action: 'check' } : { action: 'call' }),
        onWarning: (message) => warnings.push(message),
      });
      agents.push(agent);
      await agent.connect();
    }

    await waitUntil(() => server.table.handCount >= 2, 'hands to play');
    expect(warnings.some((w) => w.includes('not legal here'))).toBe(true);
  }, 60_000);

  it('keeps playing when the author’s act() throws', async () => {
    // A bug in `act` must not cost the hand by timeout — the SDK folds immediately rather
    // than letting the action clock run out.
    const { server, directory, port } = await startTable();
    const warnings: string[] = [];

    for (const [i, name] of ['iota', 'kappa'].entries()) {
      const key = await fundedKey(directory, name);
      const agent = new ClawrollAgent({
        url: `ws://127.0.0.1:${port}`,
        apiKey: key,
        tableId: TABLE.tableId,
        buyIn: 5_000_000,
        rebuys: 50,
        act: ({ legal }): Decision => {
          if (i === 0) throw new Error('author bug');
          return legal.canCheck ? { action: 'check' } : { action: 'call' };
        },
        onWarning: (message) => warnings.push(message),
      });
      agents.push(agent);
      await agent.connect();
    }

    await waitUntil(() => server.table.handCount >= 2, 'hands to play despite the bug');
    expect(warnings.some((w) => w.includes('act() threw'))).toBe(true);
  }, 60_000);
});

describe('situation', () => {
  it('gives the author their cards, the board, and precomputed legal actions', async () => {
    const { server, directory, port } = await startTable();
    const seen: Situation[] = [];

    for (const [i, name] of ['lambda', 'mu'].entries()) {
      const key = await fundedKey(directory, name);
      const agent = new ClawrollAgent({
        url: `ws://127.0.0.1:${port}`,
        apiKey: key,
        tableId: TABLE.tableId,
        buyIn: 5_000_000,
        rebuys: 50,
        act: (situation): Decision => {
          if (i === 0) seen.push(situation);
          return situation.legal.canCheck ? { action: 'check' } : { action: 'call' };
        },
        onWarning: () => {},
      });
      agents.push(agent);
      await agent.connect();
    }

    await waitUntil(() => seen.length >= 3, 'action requests');
    expect(server.table.handCount).toBeGreaterThan(0);

    const first = seen[0]!;
    expect(first.holeCards).toMatch(/^[2-9TJQKA][cdhs] [2-9TJQKA][cdhs]$/);
    expect(typeof first.pot).toBe('number');
    expect(first.msRemaining).toBeGreaterThan(0);
    // The point of shipping `legal`: an author never re-derives the betting rules.
    expect(typeof first.legal.canCheck).toBe('boolean');
    expect(first.legal.minRaiseTo).toBeGreaterThanOrEqual(0);

    // A board appears once a hand reaches the flop.
    const withBoard = seen.find((s) => s.board !== '');
    if (withBoard) expect(withBoard.board).toMatch(/^[2-9TJQKA][cdhs]/);
  }, 60_000);
});
