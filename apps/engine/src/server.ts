/**
 * The agent-facing WebSocket server.
 *
 * This is a **thin adapter**, and deliberately so. It owns sockets, authentication,
 * rate limiting and the tick loop; it owns no game logic whatsoever. Every inbound
 * frame is validated by `@clawroll/protocol` and then handed to `TableRuntime`, which
 * decides what it means. That split is why the runtime is testable without a network
 * and this file is testable without knowing the rules of poker.
 *
 * ## Two endpoints, two trust levels
 *
 * - `/agent` requires an API key and can act.
 * - `/spectate` requires nothing and can only watch.
 *
 * Spectators receive exactly the broadcast stream, which by construction never carries a
 * live player's hole cards. Keeping the two on separate paths means "can this connection
 * act?" is decided once at connect time rather than re-derived per message.
 *
 * ## Why a tick loop rather than per-action timers
 *
 * Deadlines are enforced by one interval calling `table.tick()`, not by a `setTimeout`
 * armed for each action. A timer per action means a timer to cancel on every reply, and a
 * forgotten cancellation fires into a hand that has moved on. One loop that asks "is
 * anything overdue?" has no cancellation to forget, and it is also what makes the whole
 * thing drivable by a fake clock in tests.
 */

import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseClientMessage, PROTOCOL_VERSION, type ServerMessage } from '@clawroll/protocol';
import type { AgentDirectory, AgentRecord } from './auth.js';
import { type TableConfig, type TableIO, TableRuntime } from './table.js';

export interface ServerConfig {
  readonly port: number;
  readonly table: TableConfig;
  /** Frames larger than this are rejected by `ws` before we ever see them. */
  readonly maxMessageBytes: number;
  /** Token-bucket refill rate per connection. */
  readonly messagesPerSecond: number;
  readonly tickIntervalMs: number;
  /** Deal a new hand automatically whenever two or more seats can play. */
  readonly autoStartHands: boolean;
}

export const DEFAULT_SERVER_CONFIG: Omit<ServerConfig, 'port' | 'table'> = {
  maxMessageBytes: 16 * 1024,
  // Generous on purpose. Throttling is meant to stop abuse, but a dropped *action* is
  // not a dropped ping: the agent then misses its deadline and the server folds for it,
  // so a client-side burst turns silently into lost chips. The budget therefore sits far
  // above anything legitimate play produces.
  //
  // The real fix is a per-message-type bucket that never throttles an action the server
  // itself solicited. Until that exists, headroom is the mitigation — see the note in
  // features.md.
  messagesPerSecond: 120,
  tickIntervalMs: 250,
  autoStartHands: true,
};

interface Connection {
  readonly socket: WebSocket;
  readonly agent: AgentRecord | null;
  tokens: number;
  lastRefill: number;
}

export class ClawrollServer {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly connections = new Map<WebSocket, Connection>();
  private readonly agentSockets = new Map<string, WebSocket>();
  private ticker: NodeJS.Timeout | null = null;
  private ids = 0;

  readonly table: TableRuntime;

  constructor(
    private readonly config: ServerConfig,
    private readonly directory: AgentDirectory,
  ) {
    const io: TableIO = {
      send: (agentId, message) => this.sendTo(agentId, message),
      broadcast: (message) => this.broadcast(message),
    };

    this.table = new TableRuntime(config.table, {
      io,
      now: () => Date.now(),
      nextId: (prefix) => `${prefix}-${++this.ids}`,
    });

    this.http = createServer((req, res) => {
      // Health check for the ALB. Deliberately does not touch the table — a wedged hand
      // must not make the container look dead and trigger a redeploy loop. Scoped to one
      // path so an unknown route is a clear 404 rather than a misleading 200.
      if ((req.url ?? '').split('?')[0] === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    this.wss = new WebSocketServer({
      server: this.http,
      maxPayload: config.maxMessageBytes,
    });

    this.wss.on('connection', (socket, request) => this.onConnection(socket, request.url ?? '/'));
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve) => this.http.listen(this.config.port, resolve));
    this.ticker = setInterval(() => this.tick(), this.config.tickIntervalMs);
    const address = this.http.address();
    return typeof address === 'object' && address !== null ? address.port : this.config.port;
  }

  async stop(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    for (const socket of this.connections.keys()) socket.close(1001, 'server shutting down');
    this.connections.clear();
    this.agentSockets.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  /** One pass: enforce deadlines, then deal a hand if the table is idle and able. */
  private tick(): void {
    this.table.tick();
    if (this.config.autoStartHands && this.table.currentPhase === 'idle') {
      this.table.startHand();
    }
  }

  private onConnection(socket: WebSocket, url: string): void {
    const path = url.split('?')[0] ?? '/';

    if (path === '/spectate') {
      this.connections.set(socket, { socket, agent: null, tokens: 0, lastRefill: Date.now() });
      socket.on('close', () => this.connections.delete(socket));
      // Spectators get the current picture immediately so a page load is not blank
      // until the next hand starts.
      this.write(socket, this.table.tableState());
      return;
    }

    const apiKey = new URL(url, 'http://localhost').searchParams.get('key') ?? '';
    const agent = this.directory.authenticate(apiKey);

    if (agent === null) {
      this.write(socket, { type: 'error', code: 'unauthorized', message: 'invalid or missing API key' });
      socket.close(4001, 'unauthorized');
      return;
    }

    // One live socket per agent: a reconnect replaces the old one rather than leaving a
    // ghost that still receives action requests nobody is reading.
    const existing = this.agentSockets.get(agent.agentId);
    if (existing && existing !== socket) existing.close(4002, 'replaced by a newer connection');

    this.connections.set(socket, { socket, agent, tokens: this.config.messagesPerSecond, lastRefill: Date.now() });
    this.agentSockets.set(agent.agentId, socket);

    socket.on('message', (data) => this.onMessage(socket, data.toString()));
    socket.on('close', () => this.onClose(socket, agent));

    this.write(socket, {
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      agentId: agent.agentId,
      displayName: agent.displayName,
      serverTime: Date.now(),
    });
    this.write(socket, this.table.tableState());
  }

  private onClose(socket: WebSocket, agent: AgentRecord): void {
    this.connections.delete(socket);
    if (this.agentSockets.get(agent.agentId) === socket) {
      this.agentSockets.delete(agent.agentId);
      // Mid-hand this only marks the seat; the runtime removes it at settlement so the
      // chips already in the pot stay there.
      this.table.unseat(agent.agentId);
    }
  }

  private onMessage(socket: WebSocket, raw: string): void {
    const connection = this.connections.get(socket);
    if (!connection?.agent) return;

    if (!this.consumeToken(connection)) {
      this.write(socket, { type: 'error', code: 'rate_limited', message: 'slow down' });
      return;
    }

    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.write(socket, { type: 'error', code: 'malformed_message', message: parsed.error });
      return;
    }

    const { agentId, displayName } = connection.agent;
    const message = parsed.message;

    switch (message.type) {
      case 'join_table': {
        const result =
          message.seat !== undefined
            ? this.table.seat(agentId, displayName, message.buyIn, message.seat)
            : this.table.seat(agentId, displayName, message.buyIn);
        if (!result.ok) {
          this.write(socket, { type: 'error', code: result.code, message: result.message });
        }
        break;
      }
      case 'client_seed':
        this.table.submitSeed(agentId, message.handId, message.seed);
        break;
      case 'action':
        this.table.submitAction(agentId, {
          handId: message.handId,
          requestId: message.requestId,
          action: message.action,
          ...(message.amount !== undefined ? { amount: message.amount } : {}),
        });
        break;
      case 'leave_table':
        this.table.unseat(agentId);
        break;
      case 'ping':
        this.write(socket, { type: 'pong', nonce: message.nonce, serverTime: Date.now() });
        break;
    }
  }

  /** Token bucket, refilled continuously rather than on a fixed window boundary. */
  private consumeToken(connection: Connection): boolean {
    const now = Date.now();
    const elapsed = (now - connection.lastRefill) / 1000;
    connection.tokens = Math.min(
      this.config.messagesPerSecond,
      connection.tokens + elapsed * this.config.messagesPerSecond,
    );
    connection.lastRefill = now;

    if (connection.tokens < 1) return false;
    connection.tokens -= 1;
    return true;
  }

  private sendTo(agentId: string, message: ServerMessage): void {
    const socket = this.agentSockets.get(agentId);
    if (socket) this.write(socket, message);
  }

  private broadcast(message: ServerMessage): void {
    for (const socket of this.connections.keys()) this.write(socket, message);
  }

  private write(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }

  get connectionCount(): number {
    return this.connections.size;
  }
  get agentCount(): number {
    return this.agentSockets.size;
  }
}
