/**
 * Hand state model and hand initialisation.
 *
 * ## Chips are integers, always
 *
 * Every chip amount in this package is a non-negative safe integer denominated in
 * **micro-USDC** (1 USDC = 1,000,000). Table stakes are stored in the same unit the
 * ledger uses, so a buy-in, a bet, and a ledger entry are all the same number with
 * no conversion and therefore no rounding anywhere in the system.
 *
 * Postgres stores these as `BIGINT`; TypeScript handles them as `number`, which is
 * exact below 2^53 — about 9 billion USDC. A poker table will not get near that.
 *
 * ## Dealing order is part of the verification contract
 *
 * Hole cards are dealt **one card at a time, going around the table starting from
 * the small blind, for two passes** — exactly as a live dealer would. Then the board
 * is burned and dealt from the same deck in order.
 *
 * This is not cosmetic. A verifier reconstructs the shuffled deck from the revealed
 * seed and must arrive at the same hole cards the hand history claims. Dealing two
 * cards to each player in turn instead of one-at-a-time produces a completely
 * different assignment from the identical deck. Like the card ordering in `cards.ts`,
 * treat this as frozen.
 */

import type { Card } from './cards.js';

/** A non-negative integer amount of micro-USDC. */
export type Chips = number;

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'complete';

/**
 * `active` — can still act. `folded` — out of the hand. `allin` — has chips in the
 * pot but no chips behind, so cannot act again while remaining eligible to win.
 */
export type SeatStatus = 'active' | 'folded' | 'allin';

export interface SeatState {
  /** Physical seat index at the table. Stable across hands. */
  readonly seat: number;
  readonly playerId: string;
  /** Chips behind — not yet committed to the pot. */
  readonly stack: Chips;
  /** Committed on the current street only. Reset to 0 at each new street. */
  readonly committedThisStreet: Chips;
  /** Committed across the whole hand. This is what side pots are derived from. */
  readonly committedTotal: Chips;
  readonly holeCards: readonly [Card, Card] | null;
  readonly status: SeatStatus;
  /**
   * Whether this seat has acted since the last time the betting was reopened.
   * A full raise clears this for everyone else; an under-sized all-in does not.
   */
  readonly hasActedThisStreet: boolean;
}

export interface HandState {
  readonly handId: string;
  readonly street: Street;
  readonly buttonSeat: number;
  readonly smallBlind: Chips;
  readonly bigBlind: Chips;
  readonly ante: Chips;
  readonly seats: readonly SeatState[];
  readonly board: readonly Card[];
  /** The shuffled deck for this hand, in full. Never mutated. */
  readonly deck: readonly Card[];
  /** Index of the next undealt card in `deck`. */
  readonly deckIndex: number;
  /** Seat to act, or `null` when no one can act (street or hand is over). */
  readonly actingSeat: number | null;
  /** Highest `committedThisStreet` at the table — the amount players must match. */
  readonly betToCall: Chips;
  /**
   * Size of the last full raise increment, which sets the minimum legal raise.
   * Preflop this starts at the big blind, so the first raise must be to at least 2BB.
   */
  readonly lastRaiseIncrement: Chips;
  /** Chips already collected from completed streets. */
  readonly pot: Chips;
}

export interface HandPlayer {
  readonly seat: number;
  readonly playerId: string;
  readonly stack: Chips;
}

export interface HandConfig {
  readonly handId: string;
  readonly buttonSeat: number;
  readonly smallBlind: Chips;
  readonly bigBlind: Chips;
  readonly ante?: Chips;
  readonly players: readonly HandPlayer[];
  /** Pre-shuffled deck, supplied by `packages/shuffle`. */
  readonly deck: readonly Card[];
}

/** Seats that can still voluntarily act (not folded, not all-in). */
export function activeSeats(state: HandState): readonly SeatState[] {
  return state.seats.filter((s) => s.status === 'active');
}

/** Seats still eligible to win a pot (everyone who has not folded). */
export function liveSeats(state: HandState): readonly SeatState[] {
  return state.seats.filter((s) => s.status !== 'folded');
}

export function seatAt(state: HandState, seat: number): SeatState {
  const found = state.seats.find((s) => s.seat === seat);
  if (!found) throw new Error(`No seat ${seat} in hand ${state.handId}`);
  return found;
}

/**
 * Next seat clockwise from `fromSeat` matching `predicate`, or `null` if none.
 *
 * Seats are ordered by index and wrap around. `fromSeat` itself is never returned,
 * so this always means "somebody else".
 */
export function nextSeatWhere(
  seats: readonly SeatState[],
  fromSeat: number,
  predicate: (seat: SeatState) => boolean,
): SeatState | null {
  const ordered = [...seats].sort((a, b) => a.seat - b.seat);
  const startIdx = ordered.findIndex((s) => s.seat > fromSeat);
  const offset = startIdx === -1 ? 0 : startIdx;

  for (let i = 0; i < ordered.length; i++) {
    const candidate = ordered[(offset + i) % ordered.length]!;
    if (candidate.seat === fromSeat) continue;
    if (predicate(candidate)) return candidate;
  }
  return null;
}

/** Move up to `amount` from a seat's stack into the pot, capped by the stack. */
function commit(seat: SeatState, amount: Chips): SeatState {
  const paid = Math.min(amount, seat.stack);
  const stack = seat.stack - paid;
  return {
    ...seat,
    stack,
    committedThisStreet: seat.committedThisStreet + paid,
    committedTotal: seat.committedTotal + paid,
    status: stack === 0 ? 'allin' : seat.status,
  };
}

function validateConfig(config: HandConfig): void {
  const { players, smallBlind, bigBlind, deck } = config;

  if (players.length < 2) {
    throw new Error(`A hand needs at least 2 players, got ${players.length}`);
  }
  if (new Set(players.map((p) => p.seat)).size !== players.length) {
    throw new Error('Duplicate seat numbers in hand config');
  }
  if (new Set(players.map((p) => p.playerId)).size !== players.length) {
    throw new Error('Duplicate player IDs in hand config');
  }
  for (const p of players) {
    if (!Number.isSafeInteger(p.stack) || p.stack <= 0) {
      throw new Error(`Seat ${p.seat} has a non-positive or non-integer stack: ${p.stack}`);
    }
  }
  if (!Number.isSafeInteger(smallBlind) || !Number.isSafeInteger(bigBlind)) {
    throw new Error('Blinds must be integers');
  }
  if (smallBlind <= 0 || bigBlind < smallBlind) {
    throw new Error(`Invalid blinds: sb=${smallBlind} bb=${bigBlind}`);
  }
  // 2 hole cards each, plus a 5-card board.
  const needed = players.length * 2 + 5;
  if (deck.length < needed) {
    throw new Error(`Deck has ${deck.length} cards, need at least ${needed}`);
  }
}

/**
 * Deal a hand: post antes and blinds, deal hole cards, and set the first player
 * to act.
 *
 * Blind positions follow standard rules, including the heads-up inversion where
 * the button posts the small blind and acts first preflop.
 */
export function startHand(config: HandConfig): HandState {
  validateConfig(config);

  const ante = config.ante ?? 0;
  const ordered = [...config.players].sort((a, b) => a.seat - b.seat);

  let seats: SeatState[] = ordered.map((p) => ({
    seat: p.seat,
    playerId: p.playerId,
    stack: p.stack,
    committedThisStreet: 0,
    committedTotal: 0,
    holeCards: null,
    status: 'active',
    hasActedThisStreet: false,
  }));

  // Antes go straight into the pot rather than into the current street's betting:
  // paying an ante does not count toward matching a later bet. They must be added
  // to `pot` here, because zeroing `committedThisStreet` would otherwise drop them
  // out of every pot total in the hand.
  let antePot = 0;
  if (ante > 0) {
    seats = seats.map((s) => {
      const paid = commit(s, ante);
      antePot += paid.committedThisStreet;
      return { ...paid, committedThisStreet: 0 };
    });
  }

  const headsUp = seats.length === 2;
  const button = config.buttonSeat;
  if (!seats.some((s) => s.seat === button)) {
    throw new Error(`Button seat ${button} is not occupied`);
  }

  // Heads-up: the button *is* the small blind. Otherwise blinds run clockwise
  // from the button. This inversion is the single most commonly mis-implemented
  // rule in Hold'em, which is why it is stated explicitly rather than derived.
  const sbSeat = headsUp ? button : nextSeatWhere(seats, button, () => true)!.seat;
  const bbSeat = nextSeatWhere(seats, sbSeat, () => true)!.seat;

  seats = seats.map((s) => {
    if (s.seat === sbSeat) return commit(s, config.smallBlind);
    if (s.seat === bbSeat) return commit(s, config.bigBlind);
    return s;
  });

  // Hole cards: one at a time around the table from the small blind, two passes.
  // See the file header — this order is part of the verification contract.
  const dealOrder: number[] = [];
  let cursor = sbSeat;
  for (let i = 0; i < seats.length; i++) {
    dealOrder.push(cursor);
    cursor = nextSeatWhere(seats, cursor, () => true)!.seat;
  }

  const holeCards = new Map<number, Card[]>(dealOrder.map((s) => [s, []]));
  let deckIndex = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (const seat of dealOrder) {
      holeCards.get(seat)!.push(config.deck[deckIndex++]!);
    }
  }

  seats = seats.map((s) => {
    const cards = holeCards.get(s.seat)!;
    return { ...s, holeCards: [cards[0]!, cards[1]!] as const };
  });

  // Preflop, first action is left of the big blind. Heads-up that wraps back to
  // the button/small blind, who acts first preflop and last on every later street.
  const firstToAct = nextSeatWhere(seats, bbSeat, (s) => s.status === 'active');

  const betToCall = Math.max(...seats.map((s) => s.committedThisStreet));

  return {
    handId: config.handId,
    street: 'preflop',
    buttonSeat: button,
    smallBlind: config.smallBlind,
    bigBlind: config.bigBlind,
    ante,
    seats,
    board: [],
    deck: config.deck,
    deckIndex,
    actingSeat: firstToAct?.seat ?? null,
    betToCall,
    // The big blind counts as the opening raise, so the first raise must be to 2BB.
    lastRaiseIncrement: config.bigBlind,
    pot: antePot,
  };
}

/** Total chips in the middle: collected pot plus everything committed this street. */
export function totalPot(state: HandState): Chips {
  return state.seats.reduce((sum, s) => sum + s.committedThisStreet, state.pot);
}
