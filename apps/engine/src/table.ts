/**
 * The table runtime — where the pure packages become a running game.
 *
 * `TableRuntime` owns seats and chips, drives the commit-reveal shuffle, runs the
 * betting loop, settles the pot, and emits protocol messages. It holds **no poker
 * rules of its own**: every decision comes from `@clawroll/poker`, every deck from
 * `@clawroll/shuffle`, every message shape from `@clawroll/protocol`.
 *
 * ## It is a state machine, not an async loop
 *
 * The obvious way to write this is `const action = await askAgent(seat)` inside a loop.
 * That is a trap. It leaves a promise dangling on every seat waiting to act, and those
 * promises outlive disconnects, timeouts, and the hand itself — so a reply arriving
 * late resolves a promise belonging to a hand that finished minutes ago.
 *
 * Instead every input is a method that advances the machine and returns:
 * `submitAction`, `submitSeed`, `tick`. There is no suspended execution anywhere, which
 * means the runtime can be driven by a test with a fake clock at whatever speed it
 * likes, and a late reply is just a message about a `requestId` that is no longer
 * current — rejected by the same check that catches everything else stale.
 *
 * ## Every effect goes through `TableIO`
 *
 * The runtime never touches a socket. It calls `io.send(agentId, …)` for private
 * messages and `io.broadcast(…)` for public ones. Clock and id generation are injected
 * too, so tests are exactly reproducible and the WebSocket layer (F10) is a thin
 * adapter rather than something tangled through the game loop.
 *
 * ## Live hole cards are never broadcast
 *
 * `seatViews` takes a perspective. Cards go to their owner over `send`, and to everyone
 * only at showdown. A spectator feed carrying live hole cards would let an operator
 * watch the public stream and feed their own bot — the single change that would quietly
 * invalidate every result on the site.
 */

import {
  type Card,
  type HandState,
  type SeatState,
  applyAction,
  cardsToString,
  describeHand,
  legalActions,
  parseCards,
  settleHand,
  startHand,
  assertChipsConserved,
} from '@clawroll/poker';
import {
  type ActionType,
  type ErrorCode,
  type SeatView,
  type ServerMessage,
  type Street,
} from '@clawroll/protocol';
import {
  type ClientSeed,
  type ShuffleCommitment,
  createCommitment as defaultCreateCommitment,
  randomClientSeed,
  shuffleDeck,
} from '@clawroll/shuffle';

export interface TableConfig {
  readonly tableId: string;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante?: number;
  readonly maxSeats: number;
  readonly minBuyIn: number;
  readonly maxBuyIn: number;
  /** How long an agent has to act before the server acts for it. */
  readonly actionTimeoutMs: number;
  /** How long agents have to contribute shuffle entropy before the server supplies it. */
  readonly seedTimeoutMs: number;
}

export interface TableIO {
  /** Private message to one agent. */
  send(agentId: string, message: ServerMessage): void;
  /** Public message to every agent at the table and every spectator. */
  broadcast(message: ServerMessage): void;
}

export interface TableDeps {
  readonly io: TableIO;
  readonly now: () => number;
  readonly nextId: (prefix: string) => string;
  /** Injected so tests can pin the deck; production uses the real CSPRNG. */
  readonly createCommitment?: () => ShuffleCommitment;
  readonly randomSeed?: () => string;
}

interface Occupant {
  readonly agentId: string;
  readonly displayName: string;
  stack: number;
  /** Set when the agent asks to leave mid-hand; honoured once the hand ends. */
  leaving: boolean;
}

type Phase = 'idle' | 'awaiting_seeds' | 'betting' | 'settled';

interface ActiveHand {
  readonly handId: string;
  readonly commitment: ShuffleCommitment;
  readonly clientSeeds: Map<number, string>;
  readonly seatToAgent: Map<number, string>;
  readonly seedDeadline: number;
  state: HandState | null;
  requestId: string | null;
  actionDeadline: number;
}

export class TableRuntime {
  private readonly seats: (Occupant | null)[];
  private buttonSeat = 0;
  private phase: Phase = 'idle';
  private hand: ActiveHand | null = null;
  private handsPlayed = 0;
  /** Every chip ever bought onto this table. */
  private chipsBoughtIn = 0;
  /** Every chip ever carried off it by a departing player. */
  private chipsCashedOut = 0;

  constructor(
    private readonly config: TableConfig,
    private readonly deps: TableDeps,
  ) {
    this.seats = new Array<Occupant | null>(config.maxSeats).fill(null);
  }

  // -------------------------------------------------------------------------
  // Seating
  // -------------------------------------------------------------------------

  /** Seat an agent. Returns the seat index, or an error code if it cannot be done. */
  seat(
    agentId: string,
    displayName: string,
    buyIn: number,
    preferred?: number,
  ): { ok: true; seat: number } | { ok: false; code: ErrorCode; message: string } {
    if (this.seatOf(agentId) !== null) {
      return { ok: false, code: 'not_seated', message: 'already seated at this table' };
    }
    if (!Number.isSafeInteger(buyIn) || buyIn < this.config.minBuyIn || buyIn > this.config.maxBuyIn) {
      return {
        ok: false,
        code: 'insufficient_funds',
        message: `buy-in must be between ${this.config.minBuyIn} and ${this.config.maxBuyIn}`,
      };
    }

    const index =
      preferred !== undefined && this.seats[preferred] === null
        ? preferred
        : this.seats.findIndex((s) => s === null);

    if (index === -1) return { ok: false, code: 'table_full', message: 'no seat available' };

    this.seats[index] = { agentId, displayName, stack: buyIn, leaving: false };
    this.chipsBoughtIn += buyIn;
    this.broadcastState();
    return { ok: true, seat: index };
  }

  /**
   * Remove an agent. Mid-hand this only marks them leaving: their chips are already
   * committed to a live pot and cannot walk away from it.
   */
  unseat(agentId: string): void {
    const seat = this.seatOf(agentId);
    if (seat === null) return;

    if (this.phase === 'betting' || this.phase === 'awaiting_seeds') {
      this.seats[seat]!.leaving = true;
      return;
    }
    this.chipsCashedOut += this.seats[seat]!.stack;
    this.seats[seat] = null;
    this.broadcastState();
  }

  seatOf(agentId: string): number | null {
    const index = this.seats.findIndex((s) => s?.agentId === agentId);
    return index === -1 ? null : index;
  }

  /** Seats with an occupant holding enough chips to post. */
  private playableSeats(): number[] {
    return this.seats
      .map((occupant, seat) => ({ occupant, seat }))
      .filter((x) => x.occupant !== null && x.occupant.stack > 0)
      .map((x) => x.seat);
  }

  // -------------------------------------------------------------------------
  // Hand lifecycle
  // -------------------------------------------------------------------------

  /**
   * Begin a hand if at least two seats can play.
   *
   * The commitment is generated and broadcast here, *before* any client seed is
   * collected. That ordering is the whole fairness guarantee: reverse it and the server
   * could pick a seed after seeing what the agents contributed.
   */
  startHand(): boolean {
    if (this.phase !== 'idle') return false;
    const playable = this.playableSeats();
    if (playable.length < 2) return false;

    this.buttonSeat = this.nextOccupiedFrom(this.buttonSeat, playable);

    const commitment = (this.deps.createCommitment ?? defaultCreateCommitment)();
    const handId = this.deps.nextId('hand');
    const seedDeadline = this.deps.now() + this.config.seedTimeoutMs;

    this.hand = {
      handId,
      commitment,
      clientSeeds: new Map(),
      seatToAgent: new Map(playable.map((s) => [s, this.seats[s]!.agentId])),
      seedDeadline,
      state: null,
      requestId: null,
      actionDeadline: 0,
    };
    this.phase = 'awaiting_seeds';

    this.deps.io.broadcast({
      type: 'hand_start',
      handId,
      tableId: this.config.tableId,
      buttonSeat: this.buttonSeat,
      smallBlind: this.config.smallBlind,
      bigBlind: this.config.bigBlind,
      ante: this.config.ante ?? 0,
      seats: this.seatViews(null, false),
      commit: commitment.commit,
      seedDeadline,
    });
    return true;
  }

  /** Accept an agent's shuffle entropy for the current hand. */
  submitSeed(agentId: string, handId: string, seed: string): void {
    if (this.phase !== 'awaiting_seeds' || this.hand?.handId !== handId) {
      this.fail(agentId, 'stale_request', 'no hand is currently collecting seeds');
      return;
    }
    const seat = this.seatOf(agentId);
    if (seat === null || !this.hand.seatToAgent.has(seat)) {
      this.fail(agentId, 'not_seated', 'you are not in this hand');
      return;
    }

    this.hand.clientSeeds.set(seat, seed);
    if (this.hand.clientSeeds.size === this.hand.seatToAgent.size) this.deal();
  }

  /**
   * Deal the hand.
   *
   * Seats that did not contribute entropy in time get a server-generated seed, recorded
   * alongside the rest so the published hand stays fully reproducible — a verifier
   * cannot tell, and does not need to, which seeds came from where.
   */
  private deal(): void {
    const hand = this.hand!;

    for (const seat of hand.seatToAgent.keys()) {
      if (!hand.clientSeeds.has(seat)) {
        hand.clientSeeds.set(seat, (this.deps.randomSeed ?? randomClientSeed)());
      }
    }

    const clientSeeds: ClientSeed[] = [...hand.clientSeeds.entries()]
      .map(([seat, seed]) => ({ seat, seed }))
      .sort((a, b) => a.seat - b.seat);

    const deck = shuffleDeck({
      handId: hand.handId,
      serverSeed: hand.commitment.serverSeed,
      clientSeeds,
    });

    hand.state = startHand({
      handId: hand.handId,
      buttonSeat: this.buttonSeat,
      smallBlind: this.config.smallBlind,
      bigBlind: this.config.bigBlind,
      ...(this.config.ante !== undefined ? { ante: this.config.ante } : {}),
      players: [...hand.seatToAgent.keys()]
        .sort((a, b) => a - b)
        .map((seat) => ({ seat, playerId: this.seats[seat]!.agentId, stack: this.seats[seat]!.stack })),
      deck,
    });

    this.phase = 'betting';

    for (const [seat, agentId] of hand.seatToAgent) {
      const cards = hand.state.seats.find((s) => s.seat === seat)?.holeCards;
      if (cards) {
        this.deps.io.send(agentId, {
          type: 'your_cards',
          handId: hand.handId,
          seat,
          cards: cardsToString(cards),
        });
      }
    }

    this.requestAction();
  }

  /** Ask the seat to act, or settle if the hand is over. */
  private requestAction(): void {
    const hand = this.hand!;
    const state = hand.state!;

    if (state.actingSeat === null) {
      this.settle();
      return;
    }

    const legal = legalActions(state);
    if (legal === null) {
      this.settle();
      return;
    }

    const requestId = this.deps.nextId('req');
    hand.requestId = requestId;
    hand.actionDeadline = this.deps.now() + this.config.actionTimeoutMs;

    const agentId = hand.seatToAgent.get(state.actingSeat)!;
    this.deps.io.send(agentId, {
      type: 'action_request',
      handId: hand.handId,
      requestId,
      seat: state.actingSeat,
      street: state.street as Street,
      board: cardsToString(state.board),
      pot: this.potOf(state),
      betToCall: state.betToCall,
      legal: {
        canFold: legal.canFold,
        canCheck: legal.canCheck,
        canCall: legal.canCall,
        callAmount: legal.callAmount,
        canBet: legal.canBet,
        canRaise: legal.canRaise,
        minRaiseTo: legal.minRaiseTo,
        maxRaiseTo: legal.maxRaiseTo,
      },
      deadline: hand.actionDeadline,
    });
  }

  /**
   * Apply an agent's action.
   *
   * The `requestId` check is what makes a late reply harmless: an agent answering the
   * previous decision is told the request is stale rather than having its call for a
   * 100-chip flop bet applied to a 4000-chip river shove.
   */
  submitAction(
    agentId: string,
    message: { handId: string; requestId: string; action: ActionType; amount?: number },
  ): void {
    if (this.phase !== 'betting' || this.hand === null || this.hand.handId !== message.handId) {
      this.fail(agentId, 'stale_request', 'no hand is awaiting an action', message.requestId);
      return;
    }
    const hand = this.hand;
    const state = hand.state!;

    if (hand.requestId !== message.requestId) {
      this.fail(agentId, 'stale_request', 'that request is no longer current', message.requestId);
      return;
    }
    if (state.actingSeat === null || hand.seatToAgent.get(state.actingSeat) !== agentId) {
      this.fail(agentId, 'illegal_action', 'it is not your turn', message.requestId);
      return;
    }

    this.applyAndAdvance(state.actingSeat, message.action, message.amount, false, message.requestId);
  }

  /**
   * Advance deadlines. Called by the server loop; tests call it with a fake clock.
   *
   * On an expired action the server acts for the seat: check when that is legal,
   * otherwise fold. Agents are code, so a missed deadline means a crashed or wedged bot
   * and the table must not stall behind it.
   */
  tick(): void {
    const now = this.deps.now();

    if (this.phase === 'awaiting_seeds' && this.hand && now >= this.hand.seedDeadline) {
      this.deal();
      return;
    }

    if (this.phase === 'betting' && this.hand?.state?.actingSeat !== undefined) {
      const hand = this.hand;
      const state = hand.state!;
      if (state.actingSeat !== null && now >= hand.actionDeadline) {
        const legal = legalActions(state)!;
        this.applyAndAdvance(
          state.actingSeat,
          legal.canCheck ? 'check' : 'fold',
          undefined,
          true,
          hand.requestId ?? undefined,
        );
      }
    }
  }

  private applyAndAdvance(
    seat: number,
    action: ActionType,
    amount: number | undefined,
    timedOut: boolean,
    requestId?: string,
  ): void {
    const hand = this.hand!;
    const before = hand.state!;

    let result;
    try {
      result = applyAction(before, {
        type: action,
        seat,
        ...(amount !== undefined ? { amount } : {}),
      });
    } catch (error) {
      // The engine refused the action. Tell the agent precisely why and re-ask, rather
      // than folding it — a rejected action is a bug in the agent, not a decision.
      const agentId = hand.seatToAgent.get(seat);
      if (agentId) this.fail(agentId, 'illegal_action', (error as Error).message, requestId);
      return;
    }

    hand.state = result.state;
    hand.requestId = null;

    for (const event of result.events) {
      if (event.type === 'action') {
        this.deps.io.broadcast({
          type: 'action_taken',
          handId: hand.handId,
          seat: event.seat,
          action: event.action,
          amount: event.amount,
          stack: hand.state.seats.find((s) => s.seat === event.seat)?.stack ?? 0,
          timedOut,
        });
      } else if (event.type === 'street') {
        this.deps.io.broadcast({
          type: 'street',
          handId: hand.handId,
          street: event.street as Street,
          board: cardsToString(event.board),
          pot: this.potOf(hand.state),
        });
      }
    }

    this.requestAction();
  }

  /** Resolve pots, pay winners, reveal the seed, and return the table to idle. */
  private settle(): void {
    const hand = this.hand!;
    const state = hand.state!;
    const result = settleHand(state);

    // The same invariant the tests fuzz, checked on every live hand.
    assertChipsConserved(state, result);

    const contested = state.seats.filter((s) => s.status !== 'folded').length > 1;
    if (contested && result.hands.size > 0) {
      this.deps.io.broadcast({
        type: 'showdown',
        handId: hand.handId,
        hands: [...result.hands.entries()].map(([seat, value]) => ({
          seat,
          cards: cardsToString(state.seats.find((s) => s.seat === seat)!.holeCards!),
          description: describeHand(value),
        })),
        pots: result.pots.map((p) => ({ amount: p.amount, eligibleSeats: [...p.eligibleSeats] })),
        awards: result.awards.map((a) => ({ seat: a.seat, amount: a.amount, potIndex: a.potIndex })),
      });
    }

    for (const seat of result.seats) {
      const occupant = this.seats[seat.seat];
      if (occupant) occupant.stack = seat.stack;
    }

    this.deps.io.broadcast({
      type: 'hand_end',
      handId: hand.handId,
      serverSeed: hand.commitment.serverSeed,
      clientSeeds: [...hand.clientSeeds.entries()]
        .map(([seat, seed]) => ({ seat, seed }))
        .sort((a, b) => a.seat - b.seat),
      stacks: result.seats.map((s) => ({ seat: s.seat, stack: s.stack })),
    });

    // Agents who asked to leave mid-hand, and anyone busted, go now. A departing player
    // carries their remaining chips off the table, which has to be recorded or the
    // conservation check below would read it as a leak.
    for (const [index, occupant] of this.seats.entries()) {
      if (occupant && (occupant.leaving || occupant.stack === 0)) {
        this.chipsCashedOut += occupant.stack;
        this.seats[index] = null;
      }
    }

    this.assertTableChipsConserved();

    this.phase = 'idle';
    this.hand = null;
    this.handsPlayed++;
    this.broadcastState();
  }

  // -------------------------------------------------------------------------
  // Views and helpers
  // -------------------------------------------------------------------------

  private potOf(state: HandState): number {
    return state.seats.reduce((sum, s) => sum + s.committedThisStreet, state.pot);
  }

  private nextOccupiedFrom(from: number, playable: readonly number[]): number {
    const ordered = [...playable].sort((a, b) => a - b);
    return ordered.find((s) => s > from) ?? ordered[0]!;
  }

  /**
   * Render seats for an observer.
   *
   * `forAgentId` sees its own hole cards; `reveal` shows everyone's, and is only ever
   * true at showdown. Both default to hiding, so the failure mode of forgetting an
   * argument is a missing card rather than a leaked one.
   */
  private seatViews(forAgentId: string | null, reveal: boolean): SeatView[] {
    const handState = this.hand?.state ?? null;

    return this.seats.map((occupant, index): SeatView => {
      const inHand: SeatState | undefined = handState?.seats.find((s) => s.seat === index);
      const visible = reveal || (occupant !== null && occupant.agentId === forAgentId);
      const cards: Card[] | null = inHand?.holeCards ? [...inHand.holeCards] : null;

      return {
        seat: index,
        playerId: occupant?.agentId ?? null,
        displayName: occupant?.displayName ?? null,
        stack: inHand?.stack ?? occupant?.stack ?? 0,
        committedThisStreet: inHand?.committedThisStreet ?? 0,
        status: occupant === null ? 'empty' : (inHand?.status ?? 'sitting_out'),
        holeCards: visible && cards ? cardsToString(cards) : null,
      };
    });
  }

  private broadcastState(): void {
    this.deps.io.broadcast(this.tableState());
  }

  tableState(): ServerMessage {
    const state = this.hand?.state ?? null;
    return {
      type: 'table_state',
      tableId: this.config.tableId,
      handId: this.hand?.handId ?? null,
      street: (state?.street ?? 'complete') as Street,
      board: state ? cardsToString(state.board) : '',
      pot: state ? this.potOf(state) : 0,
      buttonSeat: state ? this.buttonSeat : null,
      smallBlind: this.config.smallBlind,
      bigBlind: this.config.bigBlind,
      seats: this.seatViews(null, false),
    };
  }

  private fail(agentId: string, code: ErrorCode, message: string, requestId?: string): void {
    this.deps.io.send(agentId, {
      type: 'error',
      code,
      message,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }

  // Inspection hooks for tests and for the spectator API.
  get currentPhase(): Phase {
    return this.phase;
  }
  get currentHandId(): string | null {
    return this.hand?.handId ?? null;
  }
  get handCount(): number {
    return this.handsPlayed;
  }
  stackOf(agentId: string): number | null {
    const seat = this.seatOf(agentId);
    return seat === null ? null : this.seats[seat]!.stack;
  }
  /** Total chips currently sitting in stacks. */
  totalChips(): number {
    return this.seats.reduce((sum, s) => sum + (s?.stack ?? 0), 0);
  }

  /** Every chip ever bought onto this table. */
  get totalBoughtIn(): number {
    return this.chipsBoughtIn;
  }

  /** Every chip ever carried off it. */
  get totalCashedOut(): number {
    return this.chipsCashedOut;
  }

  /**
   * Table-level conservation: chips in equals chips on the felt plus chips taken away.
   *
   * This is the counterpart to `assertChipsConserved`, which only covers a single hand's
   * settlement. This one spans the whole life of the table and would catch a leak in
   * seating, cash-out, or the bust-out path that per-hand accounting cannot see. Run on
   * every settled hand in production, not just in tests.
   */
  assertTableChipsConserved(): void {
    const accounted = this.totalChips() + this.chipsCashedOut;
    if (accounted !== this.chipsBoughtIn) {
      throw new Error(
        `Table ${this.config.tableId} chip conservation violated: ` +
          `${this.chipsBoughtIn} bought in, ${accounted} accounted for ` +
          `(${this.totalChips()} on table + ${this.chipsCashedOut} cashed out)`,
      );
    }
  }
  /** Hole cards as dealt, for tests and for writing hand histories. */
  holeCardsFor(seat: number): string | null {
    const cards = this.hand?.state?.seats.find((s) => s.seat === seat)?.holeCards;
    return cards ? cardsToString(cards) : null;
  }
}

export { parseCards };
