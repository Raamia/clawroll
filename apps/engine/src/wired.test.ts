import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '@clawroll/protocol';
import { Ledger, type Sql, createSql, migrate } from '@clawroll/db';
import { InMemoryAgentDirectory } from './auth.js';
import { BankrollService } from './bankroll.js';
import { ClawrollServer, DEFAULT_SERVER_CONFIG } from './server.js';
import type { TableConfig } from './table.js';

/**
 * The server, the runtime and Postgres together.
 *
 * Everything here has been tested in isolation. What is left is whether a buy-in over a
 * real socket actually moves money, and whether the chips a table is holding match the
 * ledger once hands have been played.
 */
let sql: Sql;
let ledger: Ledger;
let bankroll: BankrollService;

const TABLE: TableConfig = {
  tableId: `wired_${randomUUID().slice(0, 8)}`,
  smallBlind: 50_000,
  bigBlind: 100_000,
  maxSeats: 6,
  minBuyIn: 1_000_000,
  maxBuyIn: 20_000_000,
  actionTimeoutMs: 400,
  seedTimeoutMs: 200,
};

class Client {
  readonly received: ServerMessage[] = [];
  constructor(private readonly socket: WebSocket) {}

  static async connect(port: number, path: string): Promise<Client> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const client = new Client(socket);
    socket.on('message', (data) => client.received.push(JSON.parse(data.toString()) as ServerMessage));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return client;
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  of<T extends ServerMessage['type']>(type: T) {
    return this.received.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }

  close(): void {
    this.socket.close();
  }
}

async function fundedAgent(micros: number): Promise<string> {
  const agentId = `agent_${randomUUID()}`;
  await sql`
    INSERT INTO agents (id, display_name, key_prefix, key_hash, derivation_index, deposit_address)
    VALUES (${agentId}, 'Bot', ${randomUUID()}, 'hash',
            ${Math.floor(Math.random() * 2 ** 40)}, ${randomUUID()})`;
  await ledger.creditDeposit(agentId, micros, `sig_${randomUUID()}`);
  return agentId;
}

const holdings = async (agentId: string) =>
  (await ledger.balanceOfAgent(agentId, 'available')) +
  (await ledger.balanceOfAgent(agentId, 'in_play'));

/**
 * Wait for a condition rather than for a duration.
 *
 * A fixed sleep is calibrated against an idle machine. Under a full parallel test run
 * these same tests failed — the buy-in simply had not finished within 400ms — which looks
 * exactly like a logic bug and is not. Polling the actual condition makes the test
 * insensitive to how loaded the machine is, and it fails with a real message when the
 * condition genuinely never holds.
 *
 * The budget is deliberately generous. Five suites in this repo contend for one Postgres
 * instance across parallel workers, and a tight timeout there produces exactly the failure
 * that wastes the most time: an intermittent red build with no defect behind it.
 */
async function waitUntil(
  check: () => Promise<boolean>,
  describe: string,
  timeoutMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${describe}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Give the drain loop a chance to run when the expectation is that nothing changes. */
const quiesce = () => new Promise((r) => setTimeout(r, 800));

beforeAll(async () => {
  sql = createSql();
  await migrate(sql);
  ledger = new Ledger(sql);
  bankroll = new BankrollService(sql, ledger);
  // Scoped to this run's table: files run in parallel workers against one database, so an
  // unscoped delete would remove rows another suite is still asserting on.
  await sql`
    DELETE FROM hand_settlements
    WHERE applied_ledger_tx_id IS NULL AND table_id = ${TABLE.tableId}`;
}, 30_000);

const servers: ClawrollServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.stop();
});

async function startServer(overrides: Partial<TableConfig> = {}) {
  const directory = new InMemoryAgentDirectory();
  const server = new ClawrollServer(
    {
      ...DEFAULT_SERVER_CONFIG,
      port: 0,
      tables: [{ ...TABLE, ...overrides }],
      autoStartHands: false,
    },
    directory,
    bankroll,
  );
  servers.push(server);
  return { server, directory, port: await server.start() };
}

describe('buying in over a socket moves real money', () => {
  it('debits available and credits in_play', async () => {
    const { directory, port } = await startServer();
    const agentId = await fundedAgent(10_000_000);
    const { apiKey } = directory.register(agentId, 'Bot');

    const client = await Client.connect(port, `/agent?key=${apiKey}`);
    clients.push(client);
    client.send({ type: 'join_table', tableId: TABLE.tableId, buyIn: 4_000_000 });
    await waitUntil(
      async () => (await ledger.balanceOfAgent(agentId, 'in_play')) === 4_000_000,
      'the buy-in to reach the ledger',
    );

    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(6_000_000);
  });

  it('refuses a buy-in the agent cannot fund, and does not seat them', async () => {
    // Reserve first, then seat: seating first would put chips on the table backed by
    // nothing at all.
    const { server, directory, port } = await startServer();
    const agentId = await fundedAgent(500_000);
    const { apiKey } = directory.register(agentId, 'Bot');

    const client = await Client.connect(port, `/agent?key=${apiKey}`);
    clients.push(client);
    client.send({ type: 'join_table', tableId: TABLE.tableId, buyIn: 5_000_000 });
    await waitUntil(async () => client.of('error').length > 0, 'the rejection');

    expect(client.of('error')[0]?.code).toBe('insufficient_funds');
    expect(server.table.seatOf(agentId)).toBeNull();
    expect(await ledger.balanceOfAgent(agentId, 'in_play')).toBe(0);
    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(500_000);
  });

  it('hands the reservation back when seating fails', async () => {
    // A full table is the reachable case. The money must not stay reserved.
    const { server, directory, port } = await startServer({ maxSeats: 1 });
    const first = await fundedAgent(10_000_000);
    const second = await fundedAgent(10_000_000);

    for (const [agentId, buyIn] of [
      [first, 2_000_000],
      [second, 2_000_000],
    ] as const) {
      const { apiKey } = directory.register(agentId, 'Bot');
      const client = await Client.connect(port, `/agent?key=${apiKey}`);
      clients.push(client);
      client.send({ type: 'join_table', tableId: TABLE.tableId, buyIn });
      await quiesce();
    }

    expect(server.table.seatOf(second)).toBeNull();
    expect(await ledger.balanceOfAgent(second, 'in_play')).toBe(0);
    expect(await holdings(second)).toBe(10_000_000);
  });
});

describe('leaving returns chips to the spendable balance', () => {
  it('cashes out on an explicit leave', async () => {
    const { server, directory, port } = await startServer();
    const agentId = await fundedAgent(10_000_000);
    const { apiKey } = directory.register(agentId, 'Bot');

    const client = await Client.connect(port, `/agent?key=${apiKey}`);
    clients.push(client);
    client.send({ type: 'join_table', tableId: TABLE.tableId, buyIn: 3_000_000 });
    await waitUntil(
      async () => server.table.seatOf(agentId) !== null,
      'the agent to be seated',
    );

    client.send({ type: 'leave_table' });
    await waitUntil(
      async () => (await ledger.balanceOfAgent(agentId, 'available')) === 10_000_000,
      'the cash-out to reach the ledger',
    );
    expect(await ledger.balanceOfAgent(agentId, 'in_play')).toBe(0);
  });

  it('cashes out when an agent disconnects', async () => {
    const { server, directory, port } = await startServer();
    const agentId = await fundedAgent(10_000_000);
    const { apiKey } = directory.register(agentId, 'Bot');

    const client = await Client.connect(port, `/agent?key=${apiKey}`);
    client.send({ type: 'join_table', tableId: TABLE.tableId, buyIn: 3_000_000 });
    await waitUntil(
      async () => server.table.seatOf(agentId) !== null,
      'the agent to be seated',
    );

    client.close();
    await waitUntil(
      async () => (await ledger.balanceOfAgent(agentId, 'in_play')) === 0,
      'the disconnect cash-out',
    );
    expect(await holdings(agentId)).toBe(10_000_000);
    expect(await ledger.balanceOfAgent(agentId, 'in_play')).toBe(0);
  });
});

describe('hands settle through to the ledger', () => {
  it('leaves in_play matching the stacks the table is holding', async () => {
    // The wiring claim in one assertion: after real hands over real sockets, what the
    // table thinks each player has is what the ledger says they have.
    const { server, directory, port } = await startServer();
    const agents = await Promise.all([fundedAgent(20_000_000), fundedAgent(20_000_000)]);
    const totalBefore = (await Promise.all(agents.map(holdings))).reduce((a, b) => a + b, 0);

    for (const agentId of agents) {
      const { apiKey } = directory.register(agentId, 'Bot');
      const client = await Client.connect(port, `/agent?key=${apiKey}`);
      clients.push(client);

      client.send({ type: 'join_table', tableId: TABLE.tableId, buyIn: 5_000_000 });
      // Answer the protocol so the hand can actually play out.
      const socket = client;
      const respond = () => {
        for (const message of socket.received.splice(0)) {
          if (message.type === 'hand_start') {
            socket.send({ type: 'client_seed', handId: message.handId, seed: 'b'.repeat(64) });
          } else if (message.type === 'action_request') {
            socket.send({
              type: 'action',
              handId: message.handId,
              requestId: message.requestId,
              action: message.legal.canCheck ? 'check' : 'call',
            });
          }
        }
      };
      setInterval(respond, 10).unref();
    }
    await waitUntil(
      async () => agents.every((a) => server.table.seatOf(a) !== null),
      'both agents to be seated',
    );

    for (let i = 0; i < 3; i++) {
      server.table.startHand();
      for (let waited = 0; waited < 80 && server.table.currentPhase !== 'idle'; waited++) {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    await waitUntil(async () => {
      await bankroll.applyPendingSettlements();
      for (const agentId of agents) {
        if (server.table.seatOf(agentId) === null) continue;
        if ((await ledger.balanceOfAgent(agentId, 'in_play')) !== server.table.stackOf(agentId)) {
          return false;
        }
      }
      return true;
    }, 'the ledger to catch up with the table');

    expect(server.table.handCount).toBeGreaterThan(0);

    // Counted, because the loop skips unseated agents — without this the whole check
    // could pass having compared nothing at all.
    let compared = 0;
    for (const agentId of agents) {
      if (server.table.seatOf(agentId) === null) continue;
      expect(await ledger.balanceOfAgent(agentId, 'in_play')).toBe(server.table.stackOf(agentId));
      compared++;
    }
    expect(compared).toBeGreaterThan(0);

    const totalAfter = (await Promise.all(agents.map(holdings))).reduce((a, b) => a + b, 0);
    expect(totalAfter).toBe(totalBefore);
    await ledger.assertBalanced();
    expect(await ledger.findNegativeAgentAccounts()).toEqual([]);
  }, 90_000);
});

describe('hand ids are globally unique', () => {
  it('does not repeat ids across server restarts', async () => {
    // Regression, and a nasty one. Hand ids were generated from a per-process counter, so
    // every restart re-issued `hand-1`, `hand-2`, … The hand id is the idempotency key for
    // settlement — the outbox PRIMARY KEY and the ledger's `external_ref` — so a collision
    // did not error. `ON CONFLICT DO NOTHING` silently discarded a real settlement: chips
    // moved at the table and the ledger never heard about it.
    const seen = new Set<string>();

    for (let restart = 0; restart < 3; restart++) {
      const { server, directory, port } = await startServer();
      const agents = await Promise.all([fundedAgent(10_000_000), fundedAgent(10_000_000)]);

      for (const agentId of agents) {
        const { apiKey } = directory.register(agentId, 'Bot');
        const client = await Client.connect(port, `/agent?key=${apiKey}`);
        clients.push(client);
        client.send({ type: 'join_table', tableId: TABLE.tableId, buyIn: 2_000_000 });
      }
      await waitUntil(
        async () => agents.every((a) => server.table.seatOf(a) !== null),
        'agents to be seated',
      );

      server.table.startHand();
      const handId = server.table.currentHandId;
      expect(handId).toBeTruthy();
      expect(seen.has(handId!)).toBe(false);
      seen.add(handId!);

      for (const client of clients.splice(0)) client.close();
      await servers.pop()!.stop();
    }

    expect(seen.size).toBe(3);
  }, 90_000);
});

describe('startup reconciliation', () => {
  it('returns chips stranded at a table this process does not serve', async () => {
    const agentId = await fundedAgent(10_000_000);
    await bankroll.reserveBuyIn(agentId, 'table-from-a-dead-process', 4_000_000);
    await bankroll.trackSeat('table-from-a-dead-process', agentId, 0, 4_000_000);

    // Starting a server for a different table treats those chips as abandoned.
    await startServer();

    // Reconciliation runs inside `start()`, so it has already happened by now.
    expect(await ledger.balanceOfAgent(agentId, 'in_play')).toBe(0);
    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(10_000_000);
  });
});
