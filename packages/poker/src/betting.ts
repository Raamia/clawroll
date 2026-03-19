/**
 * The betting state machine.
 *
 * `applyAction(state, action)` is a pure reducer: it returns a brand new `HandState`
 * plus the events that transition produced, and never mutates its input. The engine
 * supplies the clock, the network, and persistence; every actual rule of poker lives
 * here.
 *
 * ## Bets and raises are expressed as "raise TO", not "raise BY"
 *
 * `amount` on a bet or raise is the **total this seat will have committed on the
 * current street** once the action is applied — not the additional chips being put
 * in. This matches hand-history notation and, more importantly, it is unambiguous
 * when the actor has already put money in this street. "Raise by 100" facing a bet
 * of 300 with 100 already committed has at least three plausible readings; "raise to
 * 400" has exactly one.
 *
 * ## How the "all-in short of a full raise" rule is expressed
 *
 * A raise that is smaller than the previous raise increment — only possible when a
 * player is all-in — does **not** reopen the betting for players who have already
 * acted. They may call or fold, but not re-raise. Players yet to act this street are
 * unaffected and retain a full raise.
 *
 * This falls out of `SeatState.hasActedThisStreet`, which really means *"has acted
 * since the betting was last reopened"*:
 *
 * - A **full** raise clears the flag on every other active seat, so they may raise again.
 * - An **under-sized all-in** leaves the flags alone. A seat that already acted still
 *   has `hasActedThisStreet === true`, and `legalActions` refuses it a raise — while a
 *   seat that has not yet acted still has `false` and keeps its full options.
 *
 * One flag, no special cases, and the rule reads directly off the state.
 *
 * ## Burn cards
 *
 * One card is burned before the flop, the turn, and the river, as in live poker. This
 * is part of the verification contract: a verifier reconstructing the deck has to
 * consume it in exactly the same order to arrive at the same board.
 */

import type { Card } from './cards.js';
import {
  type Chips,
  type HandState,
  type SeatState,
  type Street,
  activeSeats,
  liveSeats,
  nextSeatWhere,
  seatAt,
} from './handState.js';

export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise';

export interface Action {
  readonly type: ActionType;
  readonly seat: number;
  /**
   * For `bet` and `raise` only: the total this seat will have committed on the
   * current street once applied. Ignored for fold, check, and call.
   */
  readonly amount?: Chips;
}

export type HandEvent =
  | { readonly type: 'action'; readonly seat: number; readonly action: ActionType; readonly amount: Chips }
  | { readonly type: 'street'; readonly street: Street; readonly board: readonly Card[] }
  | { readonly type: 'hand_complete'; readonly reason: 'fold' | 'showdown' };

export interface LegalActions {
  readonly seat: number;
  readonly canFold: boolean;
  readonly canCheck: boolean;
  readonly canCall: boolean;
  /** Additional chips needed to call, already capped at the seat's stack. */
  readonly callAmount: Chips;
  readonly canBet: boolean;
  readonly canRaise: boolean;
  /**
   * Smallest legal `amount` for a bet or raise. When a seat is too short to make a
   * full raise this is clamped to `maxRaiseTo`, so shoving is always legal.
   */
  readonly minRaiseTo: Chips;
  /** Largest legal `amount` — the seat's entire stack, i.e. all-in. */
  readonly maxRaiseTo: Chips;
}

/**
 * What the seat to act may legally do, or `null` when nobody can act.
 *
 * The engine sends this to the agent with every action request, so a correct agent
 * never has to reimplement the betting rules to know its options.
 */
export function legalActions(state: HandState): LegalActions | null {
  if (state.actingSeat === null) return null;

  const seat = seatAt(state, state.actingSeat);
  if (seat.status !== 'active') return null;

  const toCall = Math.min(state.betToCall - seat.committedThisStreet, seat.stack);
  const facingBet = state.betToCall > seat.committedThisStreet;
  const maxRaiseTo = seat.committedThisStreet + seat.stack;

  // "Facing a bet" governs checking and calling, but NOT raising. The big blind
  // preflop has already matched betToCall and so is not facing a bet, yet must
  // still get its option to raise. Raising is therefore gated on there being a
  // bet on the street at all, not on this seat owing chips to it.
  //
  // A seat that has already acted since the betting was last reopened may not
  // raise — this is what makes an under-sized all-in fail to reopen the action.
  const canRaise =
    state.betToCall > 0 && !seat.hasActedThisStreet && maxRaiseTo > state.betToCall;
  const canBet = state.betToCall === 0 && seat.stack > 0;

  // A minimum bet is one big blind; a minimum raise is the last full increment on
  // top of the current bet. Either way, a seat too short for that may still shove.
  const desiredMin = canBet ? state.bigBlind : state.betToCall + state.lastRaiseIncrement;
  const minRaiseTo = Math.min(desiredMin, maxRaiseTo);

  return {
    seat: seat.seat,
    canFold: true,
    canCheck: !facingBet,
    canCall: facingBet && seat.stack > 0,
    callAmount: toCall,
    canBet,
    canRaise,
    minRaiseTo,
    maxRaiseTo,
  };
}

function commitChips(seat: SeatState, amount: Chips): SeatState {
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

function updateSeat(
  state: HandState,
  seatNumber: number,
  fn: (seat: SeatState) => SeatState,
): SeatState[] {
  return state.seats.map((s) => (s.seat === seatNumber ? fn(s) : s));
}

/** A betting round ends once every seat still able to act has acted and matched. */
function bettingRoundComplete(seats: readonly SeatState[], betToCall: Chips): boolean {
  return seats
    .filter((s) => s.status === 'active')
    .every((s) => s.hasActedThisStreet && s.committedThisStreet === betToCall);
}

const NEXT_STREET: Record<Street, Street> = {
  preflop: 'flop',
  flop: 'turn',
  turn: 'river',
  river: 'showdown',
  showdown: 'complete',
  complete: 'complete',
};

const CARDS_PER_STREET: Partial<Record<Street, number>> = { flop: 3, turn: 1, river: 1 };

/**
 * Sweep the street's bets into the pot, deal the next community cards, and hand the
 * action to the first live seat left of the button.
 *
 * Streets keep advancing on their own while nobody can act — which is what runs the
 * board out after everyone is all-in.
 */
function advanceStreet(state: HandState): { state: HandState; events: HandEvent[] } {
  const events: HandEvent[] = [];
  let next: HandState = state;

  for (;;) {
    const collected = next.seats.reduce((sum, s) => sum + s.committedThisStreet, next.pot);
    const street = NEXT_STREET[next.street];
    const cardCount = CARDS_PER_STREET[street] ?? 0;

    // Burn one card before each community deal, as in live poker.
    const burnt = cardCount > 0 ? next.deckIndex + 1 : next.deckIndex;
    const board = cardCount > 0 ? [...next.board, ...next.deck.slice(burnt, burnt + cardCount)] : next.board;

    next = {
      ...next,
      street,
      board,
      deckIndex: burnt + cardCount,
      pot: collected,
      seats: next.seats.map((s) => ({
        ...s,
        committedThisStreet: 0,
        hasActedThisStreet: false,
      })),
      betToCall: 0,
      lastRaiseIncrement: next.bigBlind,
      actingSeat: null,
    };

    events.push({ type: 'street', street, board });

    if (street === 'showdown') {
      events.push({ type: 'hand_complete', reason: 'showdown' });
      return { state: next, events };
    }

    // Postflop the action starts left of the button — including heads-up, where the
    // button acts last on every street after the preflop.
    const first = nextSeatWhere(next.seats, next.buttonSeat, (s) => s.status === 'active');
    const buttonCanAct = seatAtOrNull(next, next.buttonSeat)?.status === 'active';
    const firstToAct = first ?? (buttonCanAct ? seatAt(next, next.buttonSeat) : null);

    // With fewer than two seats able to act there is no betting left to do, so keep
    // dealing until the board is complete.
    if (firstToAct && activeSeats(next).length >= 2) {
      return { state: { ...next, actingSeat: firstToAct.seat }, events };
    }
  }
}

function seatAtOrNull(state: HandState, seat: number): SeatState | null {
  return state.seats.find((s) => s.seat === seat) ?? null;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Apply one action and return the resulting state plus the events it produced.
 *
 * Throws on any illegal action rather than ignoring it or coercing it to something
 * legal. An agent sending an illegal action has a bug, and silently reinterpreting
 * it would make that bug invisible while corrupting the hand.
 */
export function applyAction(state: HandState, action: Action): { state: HandState; events: HandEvent[] } {
  assert(state.street !== 'complete' && state.street !== 'showdown', `Hand ${state.handId} is already over`);
  assert(state.actingSeat !== null, `Nobody is to act in hand ${state.handId}`);
  assert(
    action.seat === state.actingSeat,
    `Out of turn: seat ${action.seat} acted but seat ${state.actingSeat} is to act`,
  );

  const legal = legalActions(state);
  assert(legal !== null, `Seat ${action.seat} cannot act`);

  const seat = seatAt(state, action.seat);
  const events: HandEvent[] = [];
  let seats: SeatState[];
  let betToCall = state.betToCall;
  let lastRaiseIncrement = state.lastRaiseIncrement;
  let amountApplied = 0;

  switch (action.type) {
    case 'fold': {
      seats = updateSeat(state, seat.seat, (s) => ({ ...s, status: 'folded', hasActedThisStreet: true }));
      break;
    }

    case 'check': {
      assert(legal.canCheck, `Seat ${seat.seat} cannot check facing a bet of ${state.betToCall}`);
      seats = updateSeat(state, seat.seat, (s) => ({ ...s, hasActedThisStreet: true }));
      break;
    }

    case 'call': {
      assert(legal.canCall, `Seat ${seat.seat} has nothing to call`);
      amountApplied = legal.callAmount;
      seats = updateSeat(state, seat.seat, (s) => ({
        ...commitChips(s, legal.callAmount),
        hasActedThisStreet: true,
      }));
      break;
    }

    case 'bet':
    case 'raise': {
      const isBet = action.type === 'bet';
      assert(isBet ? legal.canBet : legal.canRaise, `Seat ${seat.seat} cannot ${action.type} right now`);

      const target = action.amount;
      assert(target !== undefined, `A ${action.type} needs an amount`);
      assert(Number.isSafeInteger(target), `Amount must be an integer, got ${target}`);
      assert(
        target >= legal.minRaiseTo && target <= legal.maxRaiseTo,
        `${action.type} to ${target} is outside the legal range ` +
          `[${legal.minRaiseTo}, ${legal.maxRaiseTo}] for seat ${seat.seat}`,
      );

      const increment = target - state.betToCall;
      amountApplied = target - seat.committedThisStreet;

      // Only a full-sized raise reopens the betting. An all-in for less leaves every
      // other seat's hasActedThisStreet untouched, so those who already acted are
      // held to calling or folding.
      const isFullRaise = increment >= lastRaiseIncrement;
      if (isFullRaise) lastRaiseIncrement = increment;
      betToCall = Math.max(betToCall, target);

      seats = state.seats.map((s) => {
        if (s.seat === seat.seat) {
          return { ...commitChips(s, amountApplied), hasActedThisStreet: true };
        }
        if (isFullRaise && s.status === 'active') {
          return { ...s, hasActedThisStreet: false };
        }
        return s;
      });
      break;
    }
  }

  events.push({ type: 'action', seat: seat.seat, action: action.type, amount: amountApplied });

  const afterAction: HandState = { ...state, seats, betToCall, lastRaiseIncrement };

  // Everyone folded to one player: the hand is over without a showdown, and the
  // remaining bets stay collectible for the payout step.
  if (liveSeats(afterAction).length === 1) {
    const pot = afterAction.seats.reduce((sum, s) => sum + s.committedThisStreet, afterAction.pot);
    events.push({ type: 'hand_complete', reason: 'fold' });
    return {
      state: {
        ...afterAction,
        street: 'complete',
        actingSeat: null,
        pot,
        seats: afterAction.seats.map((s) => ({ ...s, committedThisStreet: 0 })),
      },
      events,
    };
  }

  if (bettingRoundComplete(afterAction.seats, betToCall)) {
    const advanced = advanceStreet(afterAction);
    return { state: advanced.state, events: [...events, ...advanced.events] };
  }

  const next = nextSeatWhere(afterAction.seats, seat.seat, (s) => s.status === 'active');
  return { state: { ...afterAction, actingSeat: next?.seat ?? null }, events };
}
