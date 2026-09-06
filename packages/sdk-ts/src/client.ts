/**
 * The client.
 *
 * Handles every protocol obligation so the author's `act` function can be pure poker.
 */

import WebSocket from 'ws';
import {
  type ServerMessage,
  PROTOCOL_VERSION,
  parseClientMessage,
} from '@clawroll/protocol';
import { randomBytes } from 'node:crypto';
import type { AgentOptions, Decision, Situation } from './types.js';

export class ClawrollAgent {
  private socket: WebSocket | null = null;
  private agentId = '';
  private holeCards = '';
  private board = '';
  private street = 'preflop';
  private seated = false;
  private joinPending = false;
  private rebuysLeft: number;
  /**
   * When the next join may be attempted, and how long to wait after the one after that.
   *
   * A refused join has to be retried — otherwise an agent that is briefly short of a buy-in
   * is stranded for good — but retrying on every `table_state` is a flood, because an active
   * table emits one on every state change. Nine agents doing that against a 120 msg/s budget
   * put the engine into overlapping ledger transactions until it was killed for memory. The
   * backoff resets the moment the agent is actually seated, so a normal re-buy after busting
   * is still immediate; only repeated refusals slow down.
   */
  private rejoinBackoffMs = 0;
  private nextRejoinAt = 0;
  private rejoinTimer: ReturnType<typeof setTimeout> | null = null;
  private stackAtHandStart = 0;
  private closing = false;
  private reconnectAttempts = 0;
  /** Learned from the first action request; `hand_end` reports stacks by seat. */
  private seat: number | null = null;

  constructor(private readonly options: AgentOptions) {
    this.rebuysLeft = options.rebuys ?? 0;
  }

  async connect(): Promise<void> {
    const socket = this.dial();
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        this.reconnectAttempts = 0;
        resolve();
      });
      socket.once('error', reject);
    });
  }

  /** Open a socket and wire it up. Every connection, first or re-, comes through here. */
  private dial(): WebSocket {
    const socket = new WebSocket(`${this.options.url}/agent?key=${this.options.apiKey}`);
    this.socket = socket;

    // Subscribe BEFORE awaiting `open`. The server sends `welcome` the instant it accepts
    // the connection, and `welcome` is what triggers `join_table` — subscribing afterwards
    // leaves a window where that frame arrives with nobody listening, and the agent then
    // sits connected and silent forever. It looks exactly like a server bug and is not.
    socket.on('message', (data) => void this.onMessage(data.toString()));
    // The close carries its own socket so `onClose` can tell whether it is still the one in
    // use. A stale socket's close must be ignored — see there for what happens otherwise.
    socket.on('close', () => this.onClose(socket));
    socket.on('error', (error) => this.warn(`socket error: ${error.message}`));
    return socket;
  }

  /** Leave the table and stop reconnecting. */
  close(): void {
    this.closing = true;
    this.clearRejoinTimer();
    this.socket?.close();
  }

  private onClose(socket: WebSocket): void {
    // Only the socket currently in use gets a say in what happens next.
    //
    // Two things used to get through here that should not have. A failed reconnect reported
    // itself twice — once through the socket's own `close` and once from the rejected
    // `connect()` — and each report scheduled its own attempt, so one failure became two
    // sockets, then four. And the server closes an agent's *previous* socket the moment a
    // newer one connects; with no way to tell that close from a live one, the agent
    // reconnected in reply, the server closed the other, and the two chased each other
    // indefinitely — every lap a fresh buy-in against the ledger. Ten bots doing that put
    // the engine at eleven ledger round-trips a second with no hand completing.
    if (socket !== this.socket) return;
    this.socket = null;
    this.seated = false;
    this.joinPending = false;
    this.clearRejoinTimer();
    if (this.closing || this.options.reconnect === false) return;

    // Exponential backoff, capped. A tight reconnect loop against a server that is down is
    // indistinguishable from an attack, and it is the agent that gets rate-limited for it.
    const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempts++);
    this.warn(`disconnected, reconnecting in ${delay}ms`);
    setTimeout(() => {
      if (this.closing) return;
      // A failed attempt lands back here through its own `close`, exactly once. Nothing
      // else may schedule the next try.
      try {
        this.dial();
      } catch (error) {
        // Only a malformed URL throws synchronously, and that will never succeed.
        this.warn(`giving up: ${(error as Error).message}`);
      }
    }, delay).unref();
  }

  private async onMessage(raw: string): Promise<void> {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      this.warn('server sent something that is not JSON');
      return;
    }

    switch (message.type) {
      case 'welcome':
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          this.warn(
            `server speaks protocol v${message.protocolVersion}, this SDK speaks ` +
              `v${PROTOCOL_VERSION} — upgrade the SDK`,
          );
        }
        this.agentId = message.agentId;
        this.buyIn();
        break;

      case 'table_state': {
        const mine = message.seats.find((s) => s.playerId === this.agentId);
        this.seated = mine !== undefined;
        if (this.seated) {
          this.joinPending = false;
          this.stackAtHandStart = mine!.stack;
          // Being seated is the only proof the refusals have stopped.
          this.clearRejoinTimer();
          this.rejoinBackoffMs = 0;
          this.nextRejoinAt = 0;
        } else if (!this.joinPending && this.rebuysLeft > 0 && Date.now() >= this.nextRejoinAt) {
          // Busting removes the seat. Without this the agent silently stops playing.
          this.rebuysLeft--;
          this.buyIn();
        }
        break;
      }

      case 'hand_start': {
        this.holeCards = '';
        this.board = '';
        this.street = 'preflop';

        const mine = message.seats.find((s) => s.playerId === this.agentId);
        if (!mine) break; // Broadcast reaches agents who are not in this hand.
        this.stackAtHandStart = mine.stack;

        // Entropy is chosen *after* seeing the server's commitment — that ordering is the
        // fairness guarantee, and the SDK supplies a fresh random seed so an author cannot
        // accidentally weaken it by reusing one.
        this.send({
          type: 'client_seed',
          handId: message.handId,
          seed: randomBytes(32).toString('hex'),
        });
        break;
      }

      case 'your_cards':
        this.holeCards = message.cards;
        break;

      case 'street':
        this.board = message.board;
        this.street = message.street;
        break;

      case 'action_request':
        await this.decide(message);
        break;

      case 'hand_end': {
        const mine = message.stacks.find((s) => s.seat === this.seat);
        if (mine && this.options.onHandEnd) {
          this.options.onHandEnd({
            handId: message.handId,
            net: mine.stack - this.stackAtHandStart,
            stack: mine.stack,
          });
        }
        break;
      }

      case 'error':
        this.warn(`${message.code}: ${message.message}`);
        // A refused join otherwise wedges the agent for good. `buyIn()` sets `joinPending`,
        // and only a `table_state` showing us seated clears it — which is exactly the
        // message a refused join never produces. The agent would then sit connected and
        // idle forever, ignoring every later `table_state` because the flag says a join is
        // still in flight. Clearing it while unseated lets the next one retry, which is what
        // makes an agent recoverable after the balance that caused the refusal is topped up.
        if (!this.seated) {
          this.joinPending = false;
          this.rejoinBackoffMs = Math.min(Math.max(this.rejoinBackoffMs * 2, 1_000), 60_000);
          this.nextRejoinAt = Date.now() + this.rejoinBackoffMs;
          this.scheduleRejoin(this.rejoinBackoffMs);
        }
        break;

      default:
        break;
    }
  }

  private async decide(request: Extract<ServerMessage, { type: 'action_request' }>): Promise<void> {
    this.seat = request.seat;

    const situation: Situation = {
      holeCards: this.holeCards,
      board: request.board || this.board,
      street: request.street,
      pot: request.pot,
      betToCall: request.betToCall,
      legal: request.legal,
      seat: request.seat,
      seats: [],
      msRemaining: Math.max(0, request.deadline - Date.now()),
    };

    let decision: Decision;
    try {
      decision = await this.options.act(situation);
    } catch (error) {
      // An author's bug must not cost the hand by timeout. Fold if folding is legal,
      // otherwise check — the same fallback the server would apply, but immediately.
      this.warn(`act() threw: ${(error as Error).message}`);
      decision = request.legal.canFold ? { action: 'fold' } : { action: 'check' };
    }

    const safe = this.validate(decision, request.legal);

    this.send({
      type: 'action',
      handId: request.handId,
      // Echoed, always. An agent that omits or invents this works perfectly in testing and
      // starts applying stale actions the first time it is slow.
      requestId: request.requestId,
      action: safe.action,
      ...(safe.amount !== undefined ? { amount: safe.amount } : {}),
    });
  }

  /**
   * Check a decision against what the server said is legal, before sending it.
   *
   * The author gets a warning naming their bug, rather than an `illegal_action` from the
   * server that reads like a server fault — and the agent keeps playing instead of stalling
   * on a rejected action until the clock runs out.
   */
  private validate(decision: Decision, legal: Situation['legal']): Decision {
    const allowed: Record<string, boolean> = {
      fold: legal.canFold,
      check: legal.canCheck,
      call: legal.canCall,
      bet: legal.canBet,
      raise: legal.canRaise,
    };

    if (!allowed[decision.action]) {
      const fallback = legal.canCheck ? 'check' : legal.canFold ? 'fold' : 'call';
      this.warn(`${decision.action} is not legal here — playing ${fallback} instead`);
      return { action: fallback as Decision['action'] };
    }

    if (decision.action === 'bet' || decision.action === 'raise') {
      const target = decision.amount ?? legal.minRaiseTo;
      const clamped = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Math.round(target)));
      if (clamped !== target) {
        this.warn(
          `${decision.action} to ${target} is outside [${legal.minRaiseTo}, ${legal.maxRaiseTo}] ` +
            `— clamped to ${clamped}`,
        );
      }
      return { action: decision.action, amount: clamped };
    }

    return { action: decision.action };
  }

  /**
   * Try again once the backoff expires, without waiting to be asked.
   *
   * Retrying only when a `table_state` happens to arrive makes recovery depend on the table
   * still being busy — and a table that refused an agent may be about to go quiet, which is
   * precisely when nothing further will arrive. The agent would then hold a backoff that
   * never elapses against a trigger that never fires. Owning the timer keeps recovery a
   * property of the agent rather than of the room's traffic.
   */
  private scheduleRejoin(delayMs: number): void {
    this.clearRejoinTimer();
    this.rejoinTimer = setTimeout(() => {
      this.rejoinTimer = null;
      if (this.closing || this.seated || this.joinPending || this.rebuysLeft <= 0) return;
      this.rebuysLeft--;
      this.buyIn();
    }, delayMs);
    // Never hold a short-lived script open just because a retry is pending.
    this.rejoinTimer.unref?.();
  }

  private clearRejoinTimer(): void {
    if (this.rejoinTimer !== null) clearTimeout(this.rejoinTimer);
    this.rejoinTimer = null;
  }

  private buyIn(): void {
    this.joinPending = true;
    this.send({ type: 'join_table', tableId: this.options.tableId, buyIn: this.options.buyIn });
  }

  private send(message: unknown): void {
    // Validate our own outbound frames. A bug in the SDK should surface here, named, rather
    // than as a `malformed_message` the author has to reverse-engineer.
    const encoded = JSON.stringify(message);
    const check = parseClientMessage(encoded);
    if (!check.ok) {
      this.warn(`refusing to send an invalid frame: ${check.error}`);
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encoded);
  }

  private warn(message: string): void {
    if (this.options.onWarning) this.options.onWarning(message);
    else console.warn(`[clawroll] ${message}`);
  }
}

/**
 * Connect and play until stopped.
 *
 * Returns the agent so it can be closed; most bots never need to.
 */
export async function play(options: AgentOptions): Promise<ClawrollAgent> {
  const agent = new ClawrollAgent(options);
  await agent.connect();
  return agent;
}
