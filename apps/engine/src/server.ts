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

import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseClientMessage, PROTOCOL_VERSION, type ServerMessage } from '@clawroll/protocol';
import type { HandArchive } from './archive.js';
import type { AgentDirectory, AgentRecord } from './auth.js';
import type { BankrollService } from './bankroll.js';
import { type LedgerEvent, type TableConfig, type TableIO, TableRuntime } from './table.js';

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
  /**
   * Minimum pause between hands.
   *
   * Without one, a table of fast agents deals a new hand the instant the last settles —
   * local bots manage roughly sixty hands a second, which is unwatchable for a spectator
   * and gives a reconnecting agent no gap to sit down in. A real room pauses between hands
   * for the same reason.
   */
  readonly handIntervalMs: number;
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
  handIntervalMs: 2_000,
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
  private draining = false;
  private lastHandEndedAt = 0;
  /**
   * Events drained from the runtime but not yet durable.
   *
   * `drainLedgerEvents()` empties the runtime's buffer, so anything that fails to persist
   * has to be held here — dropping it would lose a settled hand or leave a departed
   * player's chips stuck `in_play`.
   */
  private readonly undrained: LedgerEvent[] = [];

  readonly table: TableRuntime;

  constructor(
    private readonly config: ServerConfig,
    private readonly directory: AgentDirectory,
    /**
     * Omit to run with in-memory chips only — which is what the protocol and gameplay
     * tests do, since they have nothing to say about money.
     */
    private readonly bankroll: BankrollService | null = null,
    /** Omit to run without a public archive; the read API then reports nothing. */
    private readonly archive: HandArchive | null = null,
  ) {
    const io: TableIO = {
      send: (agentId, message) => this.sendTo(agentId, message),
      broadcast: (message) => this.broadcast(message),
    };

    this.table = new TableRuntime(config.table, {
      io,
      now: () => Date.now(),
      // Globally unique, not a per-process counter.
      //
      // A counter restarts at zero on every boot, so a restarted server re-issues
      // `hand-1`, `hand-2`, … Hand ids are the idempotency key for settlement — both in
      // the outbox's PRIMARY KEY and in the ledger's `external_ref` — so a collision does
      // not error, it makes `ON CONFLICT DO NOTHING` **silently discard a real
      // settlement**. Chips move at the table and the ledger never hears about it.
      //
      // Hand ids are also published in hand histories and used for verification, where a
      // collision would make the record ambiguous. Two server instances would collide from
      // their very first hand.
      nextId: (prefix) => `${prefix}_${randomUUID()}`,
    });

    this.http = createServer((req, res) => {
      void this.handleHttp(req.url ?? '/', res);
    });

    this.wss = new WebSocketServer({
      server: this.http,
      maxPayload: config.maxMessageBytes,
    });

    this.wss.on('connection', (socket, request) => this.onConnection(socket, request.url ?? '/'));
  }

  /**
   * The public read API.
   *
   * Read-only and unauthenticated by design: every hand Clawroll has ever dealt is public,
   * and requiring a credential to check our work would defeat the point of publishing it.
   */
  private async handleHttp(url: string, res: ServerResponse): Promise<void> {
    const path = (url.split('?')[0] ?? '/').replace(/\/$/, '') || '/';
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, {
        'content-type': 'application/json',
        // The spectator app is served from a different origin.
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify(body));
    };

    try {
      // Deliberately does not touch the table: a wedged hand must not make the container
      // look dead and trigger a redeploy loop.
      if (path === '/healthz') {
        json(200, { ok: true, protocolVersion: PROTOCOL_VERSION });
        return;
      }

      if (path === '/api/tables') {
        json(200, { tables: [this.table.tableState()] });
        return;
      }

      // Routes below need the archive. The check is per-route rather than a single early
      // return, because an early return also swallows genuinely unknown paths and answers
      // 503 where the honest answer is 404 — which is exactly what it did until a test
      // caught it. "I am not configured for that" and "there is no such thing" are
      // different answers and a client will act on them differently.
      const archiveRoutes =
        path === '/api/hands' ||
        path === '/api/leaderboard' ||
        /^\/api\/(hands|agents)\/[^/]+(\/proof)?$/.test(path);

      if (archiveRoutes && this.archive === null) {
        json(503, { error: 'no hand archive configured' });
        return;
      }
      if (this.archive === null) {
        json(404, { error: 'not found' });
        return;
      }

      if (path === '/api/hands') {
        json(200, { hands: await this.archive.recent(50) });
        return;
      }

      if (path === '/api/leaderboard') {
        json(200, { leaderboard: await this.archive.leaderboard() });
        return;
      }

      const proofMatch = /^\/api\/hands\/([^/]+)\/proof$/.exec(path);
      if (proofMatch) {
        const proof = await this.archive.proofFor(decodeURIComponent(proofMatch[1]!));
        proof ? json(200, proof) : json(404, { error: 'no such hand' });
        return;
      }

      const handMatch = /^\/api\/hands\/([^/]+)$/.exec(path);
      if (handMatch) {
        const hand = await this.archive.get(decodeURIComponent(handMatch[1]!));
        hand ? json(200, hand) : json(404, { error: 'no such hand' });
        return;
      }

      const agentMatch = /^\/api\/agents\/([^/]+)$/.exec(path);
      if (agentMatch) {
        const agentId = decodeURIComponent(agentMatch[1]!);
        json(200, {
          agentId,
          hands: await this.archive.handsForAgent(agentId),
        });
        return;
      }

      json(404, { error: 'not found' });
    } catch (error) {
      json(500, { error: (error as Error).message });
    }
  }

  async start(): Promise<number> {
    // A crash leaves in_play balances with no table behind them: money the agent cannot
    // spend and no table holds. Returning it before accepting connections means a
    // reconnecting agent sees a correct balance rather than a mysteriously missing one.
    if (this.bankroll) {
      const reconciled = await this.bankroll.reconcileOrphanedChips([this.config.table.tableId]);
      if (reconciled.agentsRestored > 0) {
        console.warn(
          `[clawroll] returned ${reconciled.microsRestored} micro-USDC stranded at dead tables ` +
            `for ${reconciled.agentsRestored} agent(s)`,
        );
      }
    }

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

  /** One pass: enforce deadlines, deal if idle, then get what happened into Postgres. */
  private tick(): void {
    this.table.tick();

    if (this.config.autoStartHands && this.table.currentPhase === 'idle') {
      const now = Date.now();
      if (now - this.lastHandEndedAt >= this.config.handIntervalMs) {
        if (this.table.startHand()) this.lastHandEndedAt = now;
      }
    }
    void this.drainToLedger();
  }

  /**
   * Persist everything the table has done since the last pass.
   *
   * Guarded against overlap because the interval does not await: two drains running
   * together would both call `drainLedgerEvents()`, and while the ledger would refuse the
   * duplicates, the second drain could interleave a partial failure in a way that is far
   * harder to reason about than simply not overlapping.
   */
  private async drainToLedger(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      // Published first. A hand that settled but was never archived is invisible: nobody
      // can replay it and nobody can verify it, which is worse than a settlement that is
      // merely late, since that one at least retries.
      if (this.archive) {
        for (const record of this.table.drainHandRecords()) {
          try {
            await this.archive.record(record);
          } catch (error) {
            console.error(`[clawroll] failed to archive ${record.handId}: ${(error as Error).message}`);
          }
        }
      }

      if (this.bankroll === null) return;
      // Anything held over from a failed pass goes first, so ordering is preserved.
      const events = [...this.undrained.splice(0), ...this.table.drainLedgerEvents()];

      for (const event of events) {
        try {
          if (event.type === 'hand_settled') {
            await this.bankroll.recordSettlement(event);
          } else {
            await this.bankroll.releaseChips(
              event.agentId,
              event.stack,
              `release:${event.tableId}:${event.agentId}:${this.table.handCount}`,
            );
            await this.bankroll.untrackSeat(event.tableId, event.agentId);
          }
        } catch (error) {
          // Hold it rather than drop it: a lost settlement is money that silently never
          // moved, and a lost release leaves a departed player's chips stuck in_play.
          this.undrained.push(event);
          console.error(`[clawroll] deferring ledger event: ${(error as Error).message}`);
        }
      }

      await this.bankroll.applyPendingSettlements();
    } catch (error) {
      console.error(`[clawroll] ledger drain failed: ${(error as Error).message}`);
    } finally {
      this.draining = false;
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
      case 'join_table':
        // Fire and forget: seating now needs a database round trip, and the message loop
        // must not block behind it. Failures come back to the agent as an `error`.
        void this.handleJoin(socket, agentId, displayName, message.buyIn, message.seat);
        break;
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

  /**
   * Seat an agent, taking the buy-in from their ledger balance first.
   *
   * The order matters: reserve, then seat. Seating first would put chips on the table that
   * are not backed by anything, and a failed reserve afterwards would leave them there.
   * If seating fails for some other reason the reservation is handed straight back.
   */
  private async handleJoin(
    socket: WebSocket,
    agentId: string,
    displayName: string,
    buyIn: number,
    preferredSeat?: number,
  ): Promise<void> {
    try {
      if (this.bankroll) {
        await this.bankroll.reserveBuyIn(agentId, this.config.table.tableId, buyIn);
      }

      const result =
        preferredSeat !== undefined
          ? this.table.seat(agentId, displayName, buyIn, preferredSeat)
          : this.table.seat(agentId, displayName, buyIn);

      if (!result.ok) {
        if (this.bankroll) {
          await this.bankroll.releaseChips(agentId, buyIn, `join-failed:${agentId}:${Date.now()}`);
        }
        this.write(socket, { type: 'error', code: result.code, message: result.message });
        return;
      }

      if (this.bankroll) {
        await this.bankroll.trackSeat(this.config.table.tableId, agentId, result.seat, buyIn);
      }
    } catch (error) {
      this.write(socket, {
        type: 'error',
        code: 'insufficient_funds',
        message: (error as Error).message,
      });
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
