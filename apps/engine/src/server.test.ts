import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '@clawroll/protocol';
import { InMemoryAgentDirectory, hashSecret, issueKey, parseKey } from './auth.js';
import { ClawrollServer, DEFAULT_SERVER_CONFIG, type ServerConfig } from './server.js';
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
    table: TABLE,
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
    const { apiKey } = directory.register('a1', 'Bot One');
    const client = await connect(`/agent?key=${apiKey}`);
    await client.waitFor('welcome');

    for (let i = 0; i < 100; i++) client.send({ type: 'ping', nonce: `n${i}` });
    await new Promise((r) => setTimeout(r, 100));

    const limited = client.of('error').filter((e) => e.code === 'rate_limited');
    expect(limited.length).toBeGreaterThan(0);
    expect(client.closed).toBe(false);
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
