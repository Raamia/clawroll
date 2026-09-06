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
  /**
   * Every table this process serves.
   *
   * A list rather than one table because a room with a single table is a room with nothing
   * to switch between. The runtime was always per-table and self-contained; only this
   * adapter assumed there was exactly one of them.
   */
  readonly tables: readonly TableConfig[];
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

export const DEFAULT_SERVER_CONFIG: Omit<ServerConfig, 'port' | 'tables'> = {
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
  /** Per table, so a slow table cannot hold up a busy one. */
  private readonly lastDealAttemptAt = new Map<string, number>();
  /**
   * Which table each agent is sitting at.
   *
   * Actions arrive on a socket, not addressed to a table, so this is how an action finds the
   * runtime that should judge it.
   */
  private readonly agentTable = new Map<string, string>();
  /**
   * Events drained from the runtime but not yet durable.
   *
   * `drainLedgerEvents()` empties the runtime's buffer, so anything that fails to persist
   * has to be held here — dropping it would lose a settled hand or leave a departed
   * player's chips stuck `in_play`.
   */
  private readonly undrained: LedgerEvent[] = [];

  readonly tables = new Map<string, TableRuntime>();

  /**
   * The only table, for a server configured with one.
   *
   * Most callers — the demo session, every gameplay test — serve a single table and reading
   * `[...tables.values()][0]` at each of them would be noise. Throws rather than returning
   * an arbitrary table when there are several, since "the table" is meaningless then.
   */
  get table(): TableRuntime {
    const all = [...this.tables.values()];
    if (all.length !== 1) {
      throw new Error(`this server serves ${all.length} tables; name the one you mean`);
    }
    return all[0]!;
  }

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
    for (const tableConfig of config.tables) {
      // Broadcast is scoped to the table it came from.
      //
      // A global broadcast would deliver table B's `table_state` to an agent sitting at
      // table A, and the SDK reads a state it does not appear in as "I am no longer seated"
      // — so it would try to buy in again, every time any other table moved. Spectators
      // still see everything and filter client-side; they are watching, not playing.
      const io: TableIO = {
        send: (agentId, message) => this.sendTo(agentId, message),
        broadcast: (message) => this.broadcastFrom(tableConfig.tableId, message),
      };

      this.tables.set(tableConfig.tableId, new TableRuntime(tableConfig, {
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
      }));
      this.lastDealAttemptAt.set(tableConfig.tableId, 0);
    }

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
        json(200, { tables: [...this.tables.values()].map((t) => t.tableState()) });
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
        // 404 rather than an empty profile for an id nobody has ever used. An empty
        // profile reads as "this agent has played nothing", which is a different and
        // wrong claim about an agent that does not exist.
        const profile = await this.archive.agentProfile(decodeURIComponent(agentMatch[1]!));
        profile ? json(200, profile) : json(404, { error: 'no such agent' });
        return;
      }

      json(404, { error: 'not found' });
    } catch (error) {
      json(500, { error: (error as Error).message });
    }
  }

  async start(): Promise<number> {
    // A restart leaves in_play balances with no table behind them: money the agent cannot
    // spend and no table holds. Returning it before accepting connections means a
    // reconnecting agent sees a correct balance rather than a mysteriously missing one.
    //
    // Every seat is released, not only those at tables this process no longer serves. Seating
    // lives in memory, so a process that has just started has nobody seated anywhere — see
    // `reconcileAtStartup`. Passing the live table ids here exempted the common case and
    // stranded real money on every deploy.
    if (this.bankroll) {
      // Pending settlements first, then reconciliation — and the order is load-bearing.
      //
      // A settlement moves chips between `in_play` balances. Reconciling first releases
      // those balances to `available`, and the settlement can then never apply: it fails
      // with "insufficient funds" and stays in the outbox forever, poisoning the queue.
      // That is exactly how a local database ended up with 134 wedged rows. A hand that has
      // already been played is owed regardless of who is still sitting down.
      const drained = await this.bankroll.applyPendingSettlements();
      if (drained.applied > 0 || drained.failed > 0) {
        console.log(
          `[clawroll] applied ${drained.applied} settlement(s) left by the previous process` +
            (drained.failed > 0 ? `, ${drained.failed} still failing` : ''),
        );
      }

      const reconciled = await this.bankroll.reconcileAtStartup();
      if (reconciled.agentsRestored > 0) {
        console.warn(
          `[clawroll] returned ${reconciled.microsRestored} micro-USDC left seated by the ` +
            `previous process for ${reconciled.agentsRestored} agent(s)`,
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
    const now = Date.now();
    for (const [tableId, table] of this.tables) {
      table.tick();

      if (!this.config.autoStartHands || table.currentPhase !== 'idle') continue;
      // Paced per table. Sharing one timestamp would let a busy table starve a quiet one of
      // its turn to deal.
      if (now - (this.lastDealAttemptAt.get(tableId) ?? 0) < this.config.handIntervalMs) continue;
      this.lastDealAttemptAt.set(tableId, now);
      if (table.startHand()) continue;

      // Too few players to deal, so re-announce the table instead of falling silent.
      //
      // An agent buys back in when it sees a `table_state` it is absent from — that is the
      // SDK's only rejoin trigger. A table that cannot deal never produces one, so a room
      // that empties below two seats stays empty *permanently*: the agents are still
      // connected and still funded, waiting on a message that can no longer arrive. That is
      // what took the `high` table down for a week in production. Re-announcing on the same
      // cadence a deal would have used gives them the trigger back.
      this.broadcastFrom(tableId, table.tableState());
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
        for (const record of [...this.tables.values()].flatMap((t) => t.drainHandRecords())) {
          try {
            await this.archive.record(record);
          } catch (error) {
            console.error(`[clawroll] failed to archive ${record.handId}: ${(error as Error).message}`);
          }
        }
      }

      if (this.bankroll === null) return;
      // Anything held over from a failed pass goes first, so ordering is preserved.
      const events = [
        ...this.undrained.splice(0),
        ...[...this.tables.values()].flatMap((t) => t.drainLedgerEvents()),
      ];

      for (const event of events) {
        try {
          if (event.type === 'hand_settled') {
            await this.bankroll.recordSettlement(event);
          } else {
            // The event's own id, not one rebuilt from handCount.
            //
            // handCount is 0 until the first hand is dealt and unchanged between hands, so
            // that key repeated — and a repeated external_ref is silently treated as an
            // already-posted transaction. The seat was untracked anyway, leaving the chips
            // in_play with nothing left to describe them.
            await this.bankroll.releaseChips(event.agentId, event.stack, event.releaseId);
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
      // Spectators get the current picture of every table immediately, so a page load is
      // not blank until the next hand starts — and so the client can offer a choice.
      for (const table of this.tables.values()) this.write(socket, table.tableState());
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
    // Every table, so an agent can see where there is room before asking to sit.
    for (const table of this.tables.values()) this.write(socket, table.tableState());
  }

  private onClose(socket: WebSocket, agent: AgentRecord): void {
    this.connections.delete(socket);
    if (this.agentSockets.get(agent.agentId) === socket) {
      this.agentSockets.delete(agent.agentId);
      // Mid-hand this only marks the seat; the runtime removes it at settlement so the
      // chips already in the pot stay there.
      this.tableOf(agent.agentId)?.unseat(agent.agentId);
      this.agentTable.delete(agent.agentId);
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
        void this.handleJoin(socket, agentId, displayName, message.tableId, message.buyIn, message.seat);
        break;
      case 'client_seed':
        this.tableOf(agentId)?.submitSeed(agentId, message.handId, message.seed);
        break;
      case 'action':
        this.tableOf(agentId)?.submitAction(agentId, {
          handId: message.handId,
          requestId: message.requestId,
          action: message.action,
          ...(message.amount !== undefined ? { amount: message.amount } : {}),
        });
        break;
      case 'leave_table':
        this.tableOf(agentId)?.unseat(agentId);
        this.agentTable.delete(agentId);
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
    tableId: string,
    buyIn: number,
    preferredSeat?: number,
  ): Promise<void> {
    const table = this.tables.get(tableId);
    if (!table) {
      this.write(socket, {
        type: 'error',
        code: 'unknown_table',
        message: `no table "${tableId}" here; this room serves ${[...this.tables.keys()].join(', ')}`,
      });
      return;
    }

    try {
      if (this.bankroll) {
        await this.bankroll.reserveBuyIn(agentId, tableId, buyIn);
      }

      // Recorded *before* seating, because `seat()` broadcasts the new table state itself —
      // and `broadcastFrom` only delivers a table's messages to agents known to be at it. Set
      // this afterwards and the one message telling an agent it sat down is the one message
      // filtered away from it, which the SDK reads as "still not seated".
      this.agentTable.set(agentId, tableId);

      const result =
        preferredSeat !== undefined
          ? table.seat(agentId, displayName, buyIn, preferredSeat)
          : table.seat(agentId, displayName, buyIn);

      if (!result.ok) {
        // The `agentTable` entry deliberately stays. It is what subscribes an agent to this
        // table's broadcasts, and a `table_state` is the only thing that will ever prompt it
        // to try joining again. Dropping the entry here made a refusal permanent: the agent
        // stayed connected but deaf, so a seat that freed up a second later was one it could
        // never learn about. It is not seated either way — `seat()` said no — and an action
        // from an unseated agent is rejected on its own merits.
        if (this.bankroll) {
          await this.bankroll.releaseChips(agentId, buyIn, `join-failed:${agentId}:${Date.now()}`);
        }
        this.write(socket, { type: 'error', code: result.code, message: result.message });
        return;
      }

      if (this.bankroll) {
        await this.bankroll.trackSeat(tableId, agentId, result.seat, buyIn);
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

  /**
   * The table an agent is sitting at, or `null` if it is not seated anywhere.
   *
   * Actions arrive on a socket and name a hand, not a table, so this is the only way to know
   * which runtime should judge them once a room serves more than one.
   */
  private tableOf(agentId: string): TableRuntime | null {
    const tableId = this.agentTable.get(agentId);
    return tableId === undefined ? null : (this.tables.get(tableId) ?? null);
  }

  /**
   * Send a table's public message to everyone entitled to it.
   *
   * Spectators get every table — they are watching a room, and the client picks which one to
   * render. Agents get only the table they are sitting at, because the SDK treats a
   * `table_state` it does not appear in as proof it has been unseated, and would try to buy
   * in again every time another table moved.
   */
  private broadcastFrom(tableId: string, message: ServerMessage): void {
    for (const connection of this.connections.values()) {
      const agentId = connection.agent?.agentId;
      if (agentId !== undefined && this.agentTable.get(agentId) !== tableId) continue;
      this.write(connection.socket, message);
    }
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
