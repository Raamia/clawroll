/**
 * Side pots and showdown settlement.
 *
 * This is where poker engines die. The failure mode is always the same: pots are
 * patched incrementally as bets come in — "someone went all-in, so split off a side
 * pot" — and the special cases (a player all-in for less than the blind, three
 * all-ins at three different amounts, a folded player who had already contributed
 * more than a live one) multiply until some combination is wrong.
 *
 * ## Pots are derived, never accumulated
 *
 * `derivePots` ignores the betting history entirely. It looks only at the final
 * `committedTotal` of every seat and slices the money into horizontal layers at each
 * distinct contribution amount:
 *
 * ```
 *   seat A all-in 200   ░░░░░░░░
 *   seat B all-in 500   ░░░░░░░░▒▒▒▒▒▒▒▒▒▒▒▒
 *   seat C      1000    ░░░░░░░░▒▒▒▒▒▒▒▒▒▒▒▒▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
 *                       └ 200×3 ┘└  300×2  ┘└    500×1     ┘
 *                        main      side 1        side 2
 * ```
 *
 * Each layer's size is `(tier - previousTier) × (number of seats who reached that
 * tier)`, and the seats eligible to win it are those who reached it **and did not
 * fold**. Folded players' chips stay in the pot; their seats do not.
 *
 * Because this is a pure function of the final contributions, there is no ordering
 * to get wrong and no incremental state to corrupt. Any betting sequence that
 * produces the same contributions produces the same pots.
 *
 * ## Odd chips
 *
 * A split pot rarely divides evenly. The remainder goes one chip at a time to the
 * players closest to the **left of the button**, which is the standard live rule and
 * the one that cannot be gamed by seat selection.
 */

import { type Card } from './cards.js';
import { type HandValue, compareHands, evaluate } from './evaluator.js';
import {
  type Chips,
  type HandState,
  type SeatState,
  liveSeats,
  totalPot,
} from './handState.js';

export interface Pot {
  readonly amount: Chips;
  /** Seats that may win this pot: reached its tier and have not folded. */
  readonly eligibleSeats: readonly number[];
}

export interface PotAward {
  readonly seat: number;
  readonly amount: Chips;
  /** Index into the `pots` array this award came from. */
  readonly potIndex: number;
}

export interface ShowdownResult {
  readonly pots: readonly Pot[];
  readonly awards: readonly PotAward[];
  /** Seats with winnings credited back to their stacks. */
  readonly seats: readonly SeatState[];
  /** Best hand per seat that reached showdown; empty when everyone folded. */
  readonly hands: ReadonlyMap<number, HandValue>;
}

/**
 * Slice the total contributed into main and side pots.
 *
 * Adjacent layers with identical eligibility are merged, so a hand with no all-ins
 * yields exactly one pot rather than one layer per distinct bet size.
 */
export function derivePots(seats: readonly SeatState[]): Pot[] {
  const contributors = seats.filter((s) => s.committedTotal > 0);
  if (contributors.length === 0) return [];

  const tiers = [...new Set(contributors.map((s) => s.committedTotal))].sort((a, b) => a - b);

  const layers: Pot[] = [];
  let previousTier = 0;

  for (const tier of tiers) {
    const reached = contributors.filter((s) => s.committedTotal >= tier);
    const amount = (tier - previousTier) * reached.length;
    previousTier = tier;
    if (amount === 0) continue;

    const eligibleSeats = reached
      .filter((s) => s.status !== 'folded')
      .map((s) => s.seat)
      .sort((a, b) => a - b);

    layers.push({ amount, eligibleSeats });
  }

  // Merge adjacent layers that the same players can win — without this, a hand
  // where two players simply bet different amounts would report several pots.
  const merged: Pot[] = [];
  for (const layer of layers) {
    const previous = merged[merged.length - 1];
    if (previous && sameSeats(previous.eligibleSeats, layer.eligibleSeats)) {
      merged[merged.length - 1] = {
        amount: previous.amount + layer.amount,
        eligibleSeats: previous.eligibleSeats,
      };
    } else {
      merged.push(layer);
    }
  }
  return merged;
}

function sameSeats(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((seat, i) => seat === b[i]);
}

/**
 * Order seats clockwise starting immediately left of the button.
 *
 * The button itself sorts last, which is what puts odd chips in the earliest
 * position after the button rather than on the button.
 */
function clockwiseFromButton(seatNumbers: readonly number[], buttonSeat: number, span: number): number[] {
  const distance = (seat: number) => (seat - buttonSeat - 1 + span * 2) % span;
  return [...seatNumbers].sort((a, b) => distance(a) - distance(b));
}

/**
 * Split `amount` among `winners`, distributing any remainder one chip at a time
 * starting left of the button.
 */
function splitPot(
  amount: Chips,
  winners: readonly number[],
  buttonSeat: number,
  span: number,
): Map<number, Chips> {
  const share = Math.floor(amount / winners.length);
  const remainder = amount - share * winners.length;
  const ordered = clockwiseFromButton(winners, buttonSeat, span);

  const result = new Map<number, Chips>();
  for (const [i, seat] of ordered.entries()) {
    result.set(seat, share + (i < remainder ? 1 : 0));
  }
  return result;
}

/**
 * Settle a finished hand: derive the pots, decide each one, and credit the winners.
 *
 * Handles both endings. If everyone folded to one player, that player takes
 * everything with no cards evaluated — their hole cards are never revealed, exactly
 * as in live poker. Otherwise every pot is resolved independently by evaluating the
 * eligible seats' best five from seven.
 *
 * A pot with a single eligible seat is returned uncontested. That covers the
 * uncalled portion of a bet, which is refunded rather than won.
 */
export function settleHand(state: HandState): ShowdownResult {
  if (state.street !== 'showdown' && state.street !== 'complete') {
    throw new Error(`Hand ${state.handId} is not finished (street ${state.street})`);
  }

  const pots = derivePots(state.seats);
  const span = Math.max(...state.seats.map((s) => s.seat)) + 1;
  const live = liveSeats(state);

  const hands = new Map<number, HandValue>();
  const contested = live.length > 1;
  if (contested) {
    for (const seat of live) {
      if (!seat.holeCards) continue;
      const cards: Card[] = [...seat.holeCards, ...state.board];
      // Fewer than five cards means the hand ended before enough board was dealt,
      // which can only happen if everyone but one player folded — handled above.
      if (cards.length >= 5) hands.set(seat.seat, evaluate(cards));
    }
  }

  const awards: PotAward[] = [];
  const credited = new Map<number, Chips>();

  for (const [potIndex, pot] of pots.entries()) {
    // A pot nobody can win means chips would vanish. `legalActions` makes this
    // unreachable by refusing a fold that is not facing a bet, which is the only
    // way every eligible seat can leave a pot. Kept as a loud assertion rather
    // than a skip: silently dropping the pot is precisely the bug being guarded.
    if (pot.eligibleSeats.length === 0) {
      throw new Error(
        `Hand ${state.handId}: pot ${potIndex} of ${pot.amount} has no eligible winner`,
      );
    }

    let winners: number[];
    if (pot.eligibleSeats.length === 1 || !contested) {
      winners = [...pot.eligibleSeats];
    } else {
      const ranked = pot.eligibleSeats
        .map((seat) => ({ seat, value: hands.get(seat) }))
        .filter((x): x is { seat: number; value: HandValue } => x.value !== undefined);

      if (ranked.length === 0) {
        // Unreachable given how hands end, but chopping among the eligible seats
        // keeps chips conserved rather than throwing from an empty reduce.
        winners = [...pot.eligibleSeats];
      } else {
        const best = ranked.reduce((a, b) => (compareHands(b.value, a.value) > 0 ? b : a));
        winners = ranked.filter((x) => compareHands(x.value, best.value) === 0).map((x) => x.seat);
      }
    }

    for (const [seat, amount] of splitPot(pot.amount, winners, state.buttonSeat, span)) {
      if (amount === 0) continue;
      awards.push({ seat, amount, potIndex });
      credited.set(seat, (credited.get(seat) ?? 0) + amount);
    }
  }

  const seats = state.seats.map((s) => {
    const won = credited.get(s.seat) ?? 0;
    return won > 0 ? { ...s, stack: s.stack + won } : s;
  });

  return { pots, awards, seats, hands };
}

/** Total across all derived pots. Must always equal `totalPot(state)`. */
export function potTotal(pots: readonly Pot[]): Chips {
  return pots.reduce((sum, p) => sum + p.amount, 0);
}

/**
 * Assert that settlement neither created nor destroyed chips.
 *
 * Exported so the engine can run it on every hand in production, not just in tests.
 * An invariant worth testing is worth monitoring.
 */
export function assertChipsConserved(before: HandState, result: ShowdownResult): void {
  const chipsBefore = before.seats.reduce((sum, s) => sum + s.stack, 0) + totalPot(before);
  const chipsAfter = result.seats.reduce((sum, s) => sum + s.stack, 0);
  if (chipsBefore !== chipsAfter) {
    throw new Error(
      `Chip conservation violated in hand ${before.handId}: ` +
        `${chipsBefore} before, ${chipsAfter} after settlement`,
    );
  }
}
