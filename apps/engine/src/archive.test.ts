import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '@clawroll/protocol';
import { Ledger, type Sql, createSql, migrate } from '@clawroll/db';
import { verifyHand } from '@clawroll/shuffle';
import { HandArchive } from './archive.js';
import { InMemoryAgentDirectory } from './auth.js';
import { BankrollService } from './bankroll.js';
import { ClawrollServer, DEFAULT_SERVER_CONFIG } from './server.js';
import type { HandRecord, TableConfig } from './table.js';

let sql: Sql;
let ledger: Ledger;
let bankroll: BankrollService;
let archive: HandArchive;

const TABLE_ID = `arch_${randomUUID().slice(0, 8)}`;

const TABLE: TableConfig = {
  tableId: TABLE_ID,
  smallBlind: 50_000,
  bigBlind: 100_000,
  maxSeats: 6,
  minBuyIn: 1_000_000,
  maxBuyIn: 20_000_000,
  actionTimeoutMs: 400,
  seedTimeoutMs: 200,
};

/** Unique per run so fixtures never collide with other suites or previous runs. */
const ALICE = `alice_${randomUUID().slice(0, 8)}`;
const BOB = `bob_${randomUUID().slice(0, 8)}`;

function sampleHand(overrides: Partial<HandRecord> = {}): HandRecord {
  return {
    handId: `hand_${randomUUID()}`,
    tableId: TABLE_ID,
    buttonSeat: 0,
    smallBlind: 50_000,
    bigBlind: 100_000,
    commitment: 'a'.repeat(64),
    serverSeed: 'b'.repeat(64),
    clientSeeds: [{ seat: 0, seed: 'c'.repeat(64) }],
    board: '2h 5s 9c Jd Th',
    seats: [
      { seat: 0, agentId: ALICE, startingStack: 5_000_000, finalStack: 6_000_000, holeCards: 'As Kd' },
      { seat: 1, agentId: BOB, startingStack: 5_000_000, finalStack: 4_000_000, holeCards: 'Qc Qh' },
    ],
    actions: [{ seat: 0, action: 'call', amount: 100_000, street: 'preflop' }],
    pots: [{ amount: 2_000_000, eligibleSeats: [0, 1] }],
    awards: [{ seat: 0, amount: 2_000_000, potIndex: 0 }],
    ...overrides,
  };
}

async function waitUntil(check: () => Promise<boolean>, what: string, ms = 45_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  sql = createSql();
  await migrate(sql);
  ledger = new Ledger(sql);
  bankroll = new BankrollService(sql, ledger);
  archive = new HandArchive(sql);
  await sql`DELETE FROM hands WHERE table_id = ${TABLE_ID}`;
}, 30_000);

const servers: ClawrollServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of servers.splice(0)) await server.stop();
});

describe('publishing a hand', () => {
  it('round-trips the complete record', async () => {
    const hand = sampleHand();
    await archive.record(hand);

    const stored = await archive.get(hand.handId);
    expect(stored).toMatchObject({
      handId: hand.handId,
      board: '2h 5s 9c Jd Th',
      commitment: hand.commitment,
      serverSeed: hand.serverSeed,
    });
    expect(stored?.seats).toHaveLength(2);
    expect(stored?.actions).toHaveLength(1);
  });

  it('is written once and never updated', async () => {
    // A history that could be edited after publication would make verification
    // meaningless: the claim is that the record was fixed before anyone knew the outcome.
    const hand = sampleHand();
    await archive.record(hand);
    await archive.record({ ...hand, board: 'Ah Ad Ac As Kh' });

    expect((await archive.get(hand.handId))?.board).toBe('2h 5s 9c Jd Th');
  });

  it('returns null for a hand that does not exist', async () => {
    expect(await archive.get('nope')).toBeNull();
  });

  it('keeps hole cards null for seats that never showed', async () => {
    // The published record must contain what was shown publicly, not what the server knew.
    const hand = sampleHand({
      seats: [
        { seat: 0, agentId: ALICE, startingStack: 5_000_000, finalStack: 6_000_000, holeCards: null },
        { seat: 1, agentId: BOB, startingStack: 5_000_000, finalStack: 4_000_000, holeCards: null },
      ],
    });
    await archive.record(hand);

    const stored = await archive.get(hand.handId);
    expect(stored?.seats.every((s) => s.holeCards === null)).toBe(true);

    const proof = await archive.proofFor(hand.handId);
    expect(proof?.['holeCards']).toEqual([]);
  });
});

describe('proofs', () => {
  it('contains what a verifier needs and nothing else', async () => {
    // Every extra field is one more thing a reader has to decide whether to trust.
    const hand = sampleHand();
    await archive.record(hand);

    const proof = await archive.proofFor(hand.handId);
    expect(Object.keys(proof!).sort()).toEqual(
      ['board', 'buttonSeat', 'clientSeeds', 'commit', 'handId', 'holeCards', 'seats', 'serverSeed'].sort(),
    );
    // Notably absent: pot, winners, stacks. A verifier answers one question.
    expect(proof).not.toHaveProperty('pots');
    expect(proof).not.toHaveProperty('awards');
  });

  it('returns null for an unknown hand', async () => {
    expect(await archive.proofFor('nope')).toBeNull();
  });
});

describe('listings', () => {
  it('reports recent hands newest first with pot and winners', async () => {
    const first = sampleHand();
    await archive.record(first);
    const second = sampleHand();
    await archive.record(second);

    const recent = await archive.recent(50, TABLE_ID);
    expect(recent.length).toBeGreaterThanOrEqual(2);
    expect(recent[0]?.potTotal).toBe(2_000_000);
    expect(recent[0]?.winners[0]?.agentId).toBe(ALICE);
  });

  it('ranks the leaderboard by net winnings', async () => {
    // Computed from the published hands rather than the ledger, so it shows exactly what
    // anyone reading the public record would compute for themselves.
    //
    // Scoped to this run's table. An unscoped leaderboard is a global top-25 over every
    // hand ever archived, so as the database fills up these fixtures drop off the end and
    // the test fails for a reason that has nothing to do with ranking. Same trap as the
    // global settlement-drain assertion earlier: never assert on a global aggregate.
    const board = await archive.leaderboard(25, TABLE_ID);
    const alice = board.find((r) => r.agentId === ALICE);
    const bob = board.find((r) => r.agentId === BOB);

    expect(alice?.netMicros).toBeGreaterThan(0);
    expect(bob?.netMicros).toBeLessThan(0);
    expect(board.findIndex((r) => r.agentId === ALICE)).toBeLessThan(
      board.findIndex((r) => r.agentId === BOB),
    );
  });
});

describe('a hand played by the engine becomes publicly verifiable', () => {
  it('is archived, served over HTTP, and verifies from the served proof', async () => {
    // The point of the whole archive: what the public API hands out actually verifies.
    // Not "the engine could produce a valid proof" — the proof a stranger downloads does.
    const directory = new InMemoryAgentDirectory();
    const server = new ClawrollServer(
      { ...DEFAULT_SERVER_CONFIG, port: 0, table: TABLE, autoStartHands: false },
      directory,
      bankroll,
      archive,
    );
    servers.push(server);
    const port = await server.start();

    const agents: string[] = [];
    for (let i = 0; i < 2; i++) {
      const agentId = `agent_${randomUUID()}`;
      await sql`
        INSERT INTO agents (id, display_name, key_prefix, key_hash, derivation_index, deposit_address)
        VALUES (${agentId}, ${`Bot ${i}`}, ${randomUUID()}, 'hash',
                ${Math.floor(Math.random() * 2 ** 40)}, ${randomUUID()})`;
      await ledger.creditDeposit(agentId, 20_000_000, `sig_${randomUUID()}`);
      agents.push(agentId);

      const { apiKey } = directory.register(agentId, `Bot ${i}`);
      const socket = new WebSocket(`ws://127.0.0.1:${port}/agent?key=${apiKey}`);
      sockets.push(socket);
      const inbox: ServerMessage[] = [];
      socket.on('message', (d) => inbox.push(JSON.parse(d.toString()) as ServerMessage));
      await new Promise<void>((resolve) => socket.once('open', () => resolve()));
      socket.send(JSON.stringify({ type: 'join_table', tableId: TABLE_ID, buyIn: 5_000_000 }));

      setInterval(() => {
        for (const message of inbox.splice(0)) {
          if (message.type === 'hand_start') {
            socket.send(JSON.stringify({ type: 'client_seed', handId: message.handId, seed: 'd'.repeat(64) }));
          } else if (message.type === 'action_request') {
            socket.send(
              JSON.stringify({
                type: 'action',
                handId: message.handId,
                requestId: message.requestId,
                action: message.legal.canCheck ? 'check' : 'call',
              }),
            );
          }
        }
      }, 10).unref();
    }

    await waitUntil(
      async () => agents.every((a) => server.table.seatOf(a) !== null),
      'both agents to be seated',
    );

    server.table.startHand();
    const handId = server.table.currentHandId!;
    await waitUntil(async () => server.table.currentPhase === 'idle', 'the hand to finish');
    await waitUntil(async () => (await archive.get(handId)) !== null, 'the hand to be archived');

    // Fetch the proof exactly as a stranger would.
    const response = await fetch(`http://127.0.0.1:${port}/api/hands/${handId}/proof`);
    expect(response.status).toBe(200);
    const proof = (await response.json()) as Parameters<typeof verifyHand>[0];

    const result = verifyHand(proof);
    expect(result.checks.filter((c) => !c.passed)).toEqual([]);
    expect(result.ok).toBe(true);

    // And it is not passing vacuously.
    const names = result.checks.map((c) => c.name);
    expect(names).toContain('commitment');
    expect(names).toContain('deck');

    // The hand also appears in the public listings.
    const listing = await fetch(`http://127.0.0.1:${port}/api/hands`);
    const { hands } = (await listing.json()) as { hands: { handId: string }[] };
    expect(hands.some((h) => h.handId === handId)).toBe(true);
  }, 90_000);
});

describe('the read API', () => {
  async function serve() {
    const server = new ClawrollServer(
      { ...DEFAULT_SERVER_CONFIG, port: 0, table: TABLE, autoStartHands: false },
      new InMemoryAgentDirectory(),
      bankroll,
      archive,
    );
    servers.push(server);
    return server.start();
  }

  it('is unauthenticated, because the whole point is that anyone can check', async () => {
    const port = await serve();
    for (const path of ['/api/tables', '/api/hands', '/api/leaderboard']) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(response.status, path).toBe(200);
    }
  });

  it('allows a browser on another origin to read it', async () => {
    const port = await serve();
    const response = await fetch(`http://127.0.0.1:${port}/api/hands`);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('404s an unknown hand rather than returning an empty success', async () => {
    const port = await serve();
    const response = await fetch(`http://127.0.0.1:${port}/api/hands/does-not-exist`);
    expect(response.status).toBe(404);
  });

  it('404s an unknown route', async () => {
    const port = await serve();
    expect((await fetch(`http://127.0.0.1:${port}/api/nope`)).status).toBe(404);
  });

  it('still serves the health check', async () => {
    const port = await serve();
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
  });
});
