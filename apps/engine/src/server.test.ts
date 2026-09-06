import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '@clawroll/protocol';
import { InMemoryAgentDirectory, hashSecret, issueKey, parseKey } from './auth.js';
import { ClawrollServer, DEFAULT_SERVER_CONFIG, type ServerConfig } from './server.js';
import type { HandArchive } from './archive.js';
import type { TableConfig } from './table.js';

const TABLE: TableConfig = {
  tableId: 't1',
  smallBlind: 50,
  bigBlind: 100,
  maxSeats: 6,
  minBuyIn: 1_000,
  maxBuyIn: 20_000,
  actionTimeoutMs: 300,
  seedTimeoutMs: 200,
};

/** A test client that records everything the server sends it. */
class TestClient {
  readonly received: ServerMessage[] = [];
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data) => this.received.push(JSON.parse(data.toString()) as ServerMessage));
  }

  static async connect(port: number, path: string): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const client = new TestClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
      socket.once('close', () => resolve());
    });
    return client;
  }

  send(message: unknown): void {
    this.socket.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  of<T extends ServerMessage['type']>(type: T) {
    return this.received.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }

  /** Wait until a message of `type` arrives, or throw on timeout. */
  async waitFor<T extends ServerMessage['type']>(
    type: T,
    timeoutMs = 2_000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.of(type);
      if (found.length > 0) return found[found.length - 1]!;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  get closed(): boolean {
    return this.socket.readyState === WebSocket.CLOSED || this.socket.readyState === WebSocket.CLOSING;
  }

  close(): void {
    this.socket.close();
  }
}

describe('API key handling', () => {
  it('round-trips a minted key', () => {
    const { apiKey, record } = issueKey('a1', 'Bot');
    const parsed = parseKey(apiKey)!;
    expect(parsed.keyPrefix).toBe(record.keyPrefix);
    expect(hashSecret(parsed.secret)).toBe(record.keyHash);
  });

  it('never stores the secret half', () => {
    const { apiKey, record } = issueKey('a1', 'Bot');
    const secret = parseKey(apiKey)!.secret;
    expect(JSON.stringify(record)).not.toContain(secret);
  });

  it('issues distinct keys every time', () => {
    const keys = new Set(Array.from({ length: 500 }, () => issueKey('a', 'b').apiKey));
    expect(keys.size).toBe(500);
  });

  it('authenticates every key it issues, 500 times over', () => {
    // Regression, and the reason this loop is 500 rather than 1. The first version used
    // base64url for the prefix as well as the secret — and `_` is both the field
    // separator and a member of the base64url alphabet, so roughly half of all issued
    // keys split into the wrong fields and failed to authenticate. A single-key test
    // passes about 50% of the time; 500 makes it certain.
    const directory = new InMemoryAgentDirectory();
    const issued = Array.from({ length: 500 }, (_, i) => directory.register(`a${i}`, `Bot ${i}`));
    for (const { apiKey, record } of issued) {
      expect(directory.authenticate(apiKey)?.agentId, apiKey).toBe(record.agentId);
    }
  });

  it('handles a secret containing the field separator', () => {
    // base64url secrets legitimately contain `_`, so everything after the second
    // separator is the secret rather than requiring exactly three parts.
    const parsed = parseKey('ck_abc123_secret_with_underscores');
    expect(parsed).toEqual({ keyPrefix: 'abc123', secret: 'secret_with_underscores' });
  });

  it.each([
    ['empty', ''],
    ['wrong scheme', 'sk_abc_def'],
    ['too few parts', 'ck_abc'],
    ['too many parts', 'ck_a_b_c'],
    ['empty secret', 'ck_abc_'],
  ])('rejects a %s key', (_label, key) => {
    const directory = new InMemoryAgentDirectory();
    directory.register('a1', 'Bot');
    expect(directory.authenticate(key)).toBeNull();
  });

  it('rejects a valid prefix with the wrong secret', () => {
    const directory = new InMemoryAgentDirectory();
    const { record } = directory.register('a1', 'Bot');
    expect(directory.authenticate(`ck_${record.keyPrefix}_wrongsecret`)).toBeNull();
  });

  it('authenticates a registered key', () => {
    const directory = new InMemoryAgentDirectory();
    const { apiKey } = directory.register('a1', 'Bot');
    expect(directory.authenticate(apiKey)?.agentId).toBe('a1');
  });
});

describe('the server over real sockets', () => {
  let server: ClawrollServer;
  let directory: InMemoryAgentDirectory;
  let port: number;
  const clients: TestClient[] = [];

  const config = (overrides: Partial<ServerConfig> = {}): ServerConfig => ({
    ...DEFAULT_SERVER_CONFIG,
    port: 0,
    tables: [TABLE],
    autoStartHands: false,
    ...overrides,
  });

  beforeEach(async () => {
    directory = new InMemoryAgentDirectory();
    server = new ClawrollServer(config(), directory);
    port = await server.start();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await server.stop();
  });

  const connect = async (path: string) => {
    const client = await TestClient.connect(port, path);
    clients.push(client);
    return client;
  };

  it('rejects a connection with no API key', async () => {
    const client = await connect('/agent');
    await new Promise((r) => setTimeout(r, 50));
    expect(client.of('error')[0]).toMatchObject({ code: 'unauthorized' });
  });

  it('rejects a connection with a bogus API key', async () => {
    const client = await connect('/agent?key=ck_nope_nope');
    await new Promise((r) => setTimeout(r, 50));
    expect(client.of('error')[0]).toMatchObject({ code: 'unauthorized' });
  });

  it('welcomes a valid agent and sends the table state', async () => {
    const { apiKey } = directory.register('a1', 'Bot One');
    const client = await connect(`/agent?key=${apiKey}`);

    const welcome = await client.waitFor('welcome');
    expect(welcome).toMatchObject({ agentId: 'a1', displayName: 'Bot One' });
    await client.waitFor('table_state');
  });

  it('lets a spectator watch without any credential', async () => {
    const client = await connect('/spectate');
    await client.waitFor('table_state');
    expect(client.closed).toBe(false);
  });

  describe('a table that cannot deal', () => {
    /**
     * The deadlock that took the `high` table down for a week in production.
     *
     * An agent buys back in only when it sees a `table_state` it is absent from, and a table
     * with fewer than two players never deals — so once a room emptied below two seats it
     * fell silent, and silence was exactly the condition that stopped anything from ever
     * refilling it. The agents stayed connected and funded the whole time.
     */
    it('keeps announcing itself so a lone agent is not stranded', async () => {
      await server.stop();
      server = new ClawrollServer(config({ autoStartHands: true, handIntervalMs: 20 }), directory);
      port = await server.start();

      const { apiKey } = directory.register('a1', 'Bot One');
      const client = await connect(`/agent?key=${apiKey}`);
      await client.waitFor('welcome');
      client.send({ type: 'join_table', tableId: 't1', buyIn: 10_000 });
      await new Promise((r) => setTimeout(r, 60));

      const before = client.of('table_state').length;
      await new Promise((r) => setTimeout(r, 200));

      expect(client.of('table_state').length).toBeGreaterThan(before);
      // …and still nothing was dealt, because one player cannot make a hand. The point is
      // that the table stays audible while it waits, not that it deals anyway.
      expect(client.of('hand_start')).toHaveLength(0);
    });

    it('does not announce while it is still within the deal interval', async () => {
      // The re-announcement rides the same pacing a deal would have used. Without that it
      // would fire on every 250ms tick and flood a quiet table's spectators.
      await server.stop();
      server = new ClawrollServer(config({ autoStartHands: true, handIntervalMs: 10_000 }), directory);
      port = await server.start();

      const { apiKey } = directory.register('a1', 'Bot One');
      const client = await connect(`/agent?key=${apiKey}`);
      await client.waitFor('welcome');
      client.send({ type: 'join_table', tableId: 't1', buyIn: 10_000 });
      // Long enough for the first deal attempt to have happened and re-announced once;
      // what is being measured is the silence *after* it, not the announcement itself.
      await new Promise((r) => setTimeout(r, 500));

      const before = client.of('table_state').length;
      await new Promise((r) => setTimeout(r, 300));
      expect(client.of('table_state').length).toBe(before);
    });
  });

  it('keeps a refused agent subscribed so it can try again', async () => {
    // A refusal used to unsubscribe the agent from the table it had just asked for, which
    // made the refusal permanent: it stayed connected but never heard another `table_state`,
    // and `table_state` is the only thing that prompts a retry.
    const small: TableConfig = { ...TABLE, tableId: 't1', maxSeats: 1 };
    await server.stop();
    server = new ClawrollServer(config({ tables: [small] }), directory);
    port = await server.start();

    const first = directory.register('a1', 'Bot One');
    const second = directory.register('a2', 'Bot Two');

    const seated = await connect(`/agent?key=${first.apiKey}`);
    await seated.waitFor('welcome');
    seated.send({ type: 'join_table', tableId: 't1', buyIn: 10_000 });
    await new Promise((r) => setTimeout(r, 50));

    const refused = await connect(`/agent?key=${second.apiKey}`);
    await refused.waitFor('welcome');
    refused.send({ type: 'join_table', tableId: 't1', buyIn: 10_000 });
    await refused.waitFor('error');

    // The seat frees up. The refused agent must be able to hear about it.
    const before = refused.of('table_state').length;
    seated.send({ type: 'leave_table' });
    await new Promise((r) => setTimeout(r, 50));

    expect(refused.of('table_state').length).toBeGreaterThan(before);
  });

  it('answers 503 rather than hanging when the archive is slow', async () => {
    // What a spectator saw in production: loading skeletons, indefinitely, with no error
    // anywhere — the read was queued behind a saturated pool and never came back. A prompt
    // "busy" is something a page can show and a client can retry; a request that never
    // completes is neither.
    await server.stop();
    const stuck = { recent: () => new Promise<never>(() => {}) } as unknown as HandArchive;
    server = new ClawrollServer(config({ httpQueryTimeoutMs: 100 }), directory, null, stuck);
    port = await server.start();

    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/api/hands`);
    expect(response.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('seats an agent that asks to join', async () => {
    const { apiKey } = directory.register('a1', 'Bot One');
    const client = await connect(`/agent?key=${apiKey}`);
    await client.waitFor('welcome');

    client.send({ type: 'join_table', tableId: 't1', buyIn: 10_000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(server.table.seatOf('a1')).toBe(0);
  });

  it('reports a buy-in the table will not accept', async () => {
    const { apiKey } = directory.register('a1', 'Bot One');
    const client = await connect(`/agent?key=${apiKey}`);
    await client.waitFor('welcome');

    client.send({ type: 'join_table', tableId: 't1', buyIn: 5 });
    const error = await client.waitFor('error');
    expect(error.code).toBe('insufficient_funds');
  });

  it('answers a malformed frame without dropping the connection', async () => {
    // A crash here would be a denial-of-service primitive on a public endpoint.
    const { apiKey } = directory.register('a1', 'Bot One');
    const client = await connect(`/agent?key=${apiKey}`);
    await client.waitFor('welcome');

    client.send('{not json at all');
    const error = await client.waitFor('error');
    expect(error.code).toBe('malformed_message');
    expect(client.closed).toBe(false);
  });

  it('answers a ping', async () => {
    const { apiKey } = directory.register('a1', 'Bot One');
    const client = await connect(`/agent?key=${apiKey}`);
    await client.waitFor('welcome');

    client.send({ type: 'ping', nonce: 'n1' });
    const pong = await client.waitFor('pong');
    expect(pong.nonce).toBe('n1');
  });

  it('rate limits a flood without closing the socket', async () => {
    // Runs its own server with a deliberately tiny budget. Depending on the default
    // would make this test a hostage to that number — it already broke once when the
    // default was raised, which proved it was testing the constant, not the mechanism.
    const tightDirectory = new InMemoryAgentDirectory();
    const tightServer = new ClawrollServer(
      config({ messagesPerSecond: 5 }),
      tightDirectory,
    );
    const tightPort = await tightServer.start();

    try {
      const { apiKey } = tightDirectory.register('a1', 'Bot One');
      const client = await TestClient.connect(tightPort, `/agent?key=${apiKey}`);
      clients.push(client);
      await client.waitFor('welcome');

      for (let i = 0; i < 50; i++) client.send({ type: 'ping', nonce: `n${i}` });
      await new Promise((r) => setTimeout(r, 100));

      const limited = client.of('error').filter((e) => e.code === 'rate_limited');
      expect(limited.length).toBeGreaterThan(0);
      // Throttled, never disconnected: dropping a chatty agent mid-hand would fold it
      // by timeout, turning a client bug into lost chips.
      expect(client.closed).toBe(false);
    } finally {
      await tightServer.stop();
    }
  });

  it('replaces an older connection when an agent reconnects', async () => {
    // Otherwise the ghost keeps receiving action requests nobody is reading.
    const { apiKey } = directory.register('a1', 'Bot One');
    const first = await connect(`/agent?key=${apiKey}`);
    await first.waitFor('welcome');

    const second = await connect(`/agent?key=${apiKey}`);
    await second.waitFor('welcome');
    await new Promise((r) => setTimeout(r, 50));

    expect(first.closed).toBe(true);
    expect(server.agentCount).toBe(1);
  });

  it('broadcasts hand traffic to spectators', async () => {
    const keys = [0, 1].map((i) => directory.register(`a${i}`, `Bot ${i}`).apiKey);
    const agents = await Promise.all(keys.map((k) => connect(`/agent?key=${k}`)));
    const spectator = await connect('/spectate');

    for (const agent of agents) {
      await agent.waitFor('welcome');
      agent.send({ type: 'join_table', tableId: 't1', buyIn: 10_000 });
    }
    await new Promise((r) => setTimeout(r, 50));

    server.table.startHand();
    const started = await spectator.waitFor('hand_start');
    expect(started.commit).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never sends a spectator anyone’s hole cards', async () => {
    const keys = [0, 1].map((i) => directory.register(`a${i}`, `Bot ${i}`).apiKey);
    const agents = await Promise.all(keys.map((k) => connect(`/agent?key=${k}`)));
    const spectator = await connect('/spectate');

    for (const agent of agents) {
      await agent.waitFor('welcome');
      agent.send({ type: 'join_table', tableId: 't1', buyIn: 10_000 });
    }
    await new Promise((r) => setTimeout(r, 50));

    server.table.startHand();
    const started = await agents[0]!.waitFor('hand_start');
    for (const agent of agents) {
      agent.send({ type: 'client_seed', handId: started.handId, seed: 'a'.repeat(64) });
    }
    await agents[0]!.waitFor('your_cards');

    // The agent sees its own cards; the spectator sees none, ever.
    expect(spectator.of('your_cards')).toHaveLength(0);
    for (const message of spectator.received) {
      if (message.type === 'hand_start' || message.type === 'table_state') {
        for (const seat of message.seats) expect(seat.holeCards).toBeNull();
      }
    }
  });

  it('unseats an agent that disconnects between hands', async () => {
    const { apiKey } = directory.register('a1', 'Bot One');
    const client = await connect(`/agent?key=${apiKey}`);
    await client.waitFor('welcome');
    client.send({ type: 'join_table', tableId: 't1', buyIn: 10_000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(server.table.seatOf('a1')).toBe(0);

    client.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(server.table.seatOf('a1')).toBeNull();
  });

  it('serves a health check that does not depend on the table', async () => {
    // A wedged hand must not make the container look dead and trigger a redeploy loop.
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it('404s an unknown HTTP route', async () => {
    // Scoped so a typo'd health-check path fails loudly instead of reporting healthy.
    const response = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(response.status).toBe(404);
  });
});

describe('a room with more than one table', () => {
  const T1: TableConfig = { ...TABLE, tableId: 'alpha' };
  const T2: TableConfig = { ...TABLE, tableId: 'beta' };

  let directory: InMemoryAgentDirectory;
  let server: ClawrollServer;
  let port: number;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    directory = new InMemoryAgentDirectory();
    server = new ClawrollServer(
      { ...DEFAULT_SERVER_CONFIG, port: 0, tables: [T1, T2], autoStartHands: false },
      directory,
    );
    port = await server.start();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await server.stop();
  });

  const connect = async (path: string) => {
    const client = await TestClient.connect(port, path);
    clients.push(client);
    return client;
  };

  const seat = async (agentId: string, tableId: string) => {
    const { apiKey } = directory.register(agentId, agentId);
    const client = await connect(`/agent?key=${apiKey}`);
    await client.waitFor('welcome');
    client.send({ type: 'join_table', tableId, buyIn: 5_000 });
    await new Promise((r) => setTimeout(r, 120));
    return client;
  };

  it('serves both tables and seats agents at the one they asked for', async () => {
    await seat('a1', 'alpha');
    await seat('b1', 'beta');

    expect(server.tables.get('alpha')?.stackOf('a1')).toBe(5_000);
    expect(server.tables.get('beta')?.stackOf('b1')).toBe(5_000);
    // And crucially not at each other's.
    expect(server.tables.get('beta')?.stackOf('a1')).toBeNull();
    expect(server.tables.get('alpha')?.stackOf('b1')).toBeNull();
  });

  it('sends no further updates from a table an agent is not sitting at', async () => {
    // The failure this prevents is subtle and self-inflicted: the SDK treats a `table_state`
    // it does not appear in as proof it has been unseated, and re-buys. Broadcast every
    // table to every agent and each one would try to buy in again whenever the *other* table
    // moved — quietly draining bankrolls with nothing in any log to explain it.
    //
    // Only *updates* are scoped. The one-off snapshot on connect deliberately carries every
    // table, so an agent can see where there is room before choosing one, and at that point
    // it is seated nowhere and nothing is being claimed about it. So the count is taken after
    // seating and compared, rather than asserting beta never appears at all.
    const alpha = await seat('a1', 'alpha');
    const betaSeenBefore = alpha
      .of('table_state')
      .filter((m) => (m as { tableId: string }).tableId === 'beta').length;

    // Moves beta, which broadcasts beta's new state.
    await seat('b1', 'beta');
    await new Promise((r) => setTimeout(r, 120));

    const betaSeenAfter = alpha
      .of('table_state')
      .filter((m) => (m as { tableId: string }).tableId === 'beta').length;

    expect(betaSeenAfter).toBe(betaSeenBefore);
    // And it is still hearing about its own table.
    expect(
      alpha.of('table_state').some((m) => (m as { tableId: string }).tableId === 'alpha'),
    ).toBe(true);
  });

  it('refuses a table this room does not serve', async () => {
    const { apiKey } = directory.register('c1', 'c1');
    const client = await connect(`/agent?key=${apiKey}`);
    await client.waitFor('welcome');
    client.send({ type: 'join_table', tableId: 'nonexistent', buyIn: 5_000 });

    const error = await client.waitFor('error');
    expect(error).toMatchObject({ code: 'unknown_table' });
    // Names what is actually on offer, rather than only what is not.
    expect((error as { message: string }).message).toContain('alpha');
  });

  it('reports every table over the read API', async () => {
    const spectator = await connect('/spectate');
    await new Promise((r) => setTimeout(r, 80));
    const ids = spectator.of('table_state').map((m) => (m as { tableId: string }).tableId);
    expect(new Set(ids)).toEqual(new Set(['alpha', 'beta']));
  });

  it('deals on both tables independently', async () => {
    for (const id of ['a1', 'a2']) await seat(id, 'alpha');
    for (const id of ['b1', 'b2']) await seat(id, 'beta');

    expect(server.tables.get('alpha')!.startHand()).toBe(true);
    expect(server.tables.get('beta')!.startHand()).toBe(true);
    expect(server.tables.get('alpha')!.currentHandId).not.toBe(
      server.tables.get('beta')!.currentHandId,
    );
  });
});
