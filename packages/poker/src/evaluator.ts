/**
 * Hand evaluator — ranks any 5, 6, or 7 card holding.
 *
 * ## The output is a single comparable integer
 *
 * `evaluate()` returns a `HandValue` whose `score` packs the hand into 24 bits:
 *
 * ```
 *   bits 23..20   category (0 = high card … 8 = straight flush)
 *   bits 19..16   most significant rank
 *   bits 15..12   next rank
 *   bits 11.. 8   next rank
 *   bits  7.. 4   next rank
 *   bits  3.. 0   least significant rank
 * ```
 *
 * Two hands compare correctly with a plain `a.score - b.score`, and equal scores
 * mean a genuine tie that must chop the pot. Collapsing ranking to one integer is
 * what lets the showdown code stay trivial: it sorts by score and splits on
 * equality, with no poker knowledge of its own.
 *
 * Unused rank slots are padded with `0`. That is safe even though `0` is a real
 * rank (a deuce), because the number of meaningful slots is fixed per category —
 * two flushes always compare five slots, two full houses always compare two — so
 * a padded slot is only ever compared against another padded slot.
 *
 * ## Why counting rather than lookup tables
 *
 * The classic fast evaluators (Cactus Kev, Two-Plus-Two) trade a multi-megabyte
 * generated table for a handful of array reads. We do not need that. This
 * implementation is a single pass building rank counts and per-suit bitmasks,
 * then a decision cascade — a few hundred nanoseconds, which is thousands of
 * times faster than the network round-trip to an agent that precedes it. In
 * exchange the code is readable, has no build step, and can be checked against a
 * brute-force reference. If profiling ever shows this mattering, swapping in a
 * table-driven core behind the same signature is a contained change.
 */

import { type Card, type Rank, RANK_CHARS, rankOf, suitOf } from './cards.js';

/** Hand categories, ordered so a larger value always beats a smaller one. */
export const HandCategory = {
  HighCard: 0,
  Pair: 1,
  TwoPair: 2,
  ThreeOfAKind: 3,
  Straight: 4,
  Flush: 5,
  FullHouse: 6,
  FourOfAKind: 7,
  StraightFlush: 8,
} as const;

export type HandCategory = (typeof HandCategory)[keyof typeof HandCategory];

const CATEGORY_NAMES: Record<HandCategory, string> = {
  [HandCategory.HighCard]: 'High Card',
  [HandCategory.Pair]: 'Pair',
  [HandCategory.TwoPair]: 'Two Pair',
  [HandCategory.ThreeOfAKind]: 'Three of a Kind',
  [HandCategory.Straight]: 'Straight',
  [HandCategory.Flush]: 'Flush',
  [HandCategory.FullHouse]: 'Full House',
  [HandCategory.FourOfAKind]: 'Four of a Kind',
  [HandCategory.StraightFlush]: 'Straight Flush',
};

export interface HandValue {
  /** Packed comparable score. Higher is better; equal means a true tie. */
  readonly score: number;
  readonly category: HandCategory;
  /** The significant ranks in descending order of importance. */
  readonly ranks: readonly Rank[];
}

const CATEGORY_SHIFT = 20;
const MAX_SIGNIFICANT_RANKS = 5;

function makeValue(category: HandCategory, ranks: readonly Rank[]): HandValue {
  let score = category << CATEGORY_SHIFT;
  for (let i = 0; i < MAX_SIGNIFICANT_RANKS; i++) {
    score |= (ranks[i] ?? 0) << (16 - i * 4);
  }
  return { score, category, ranks };
}

/**
 * Highest rank completing a 5-card straight in `rankMask`, or `null` for none.
 *
 * The wheel (A-2-3-4-5) is the one place aces are low. Rather than special-casing
 * it in the scan, we widen the 13-bit rank mask into a 14-bit mask where bit 0 is
 * "ace playing low" and bits 1..13 are the ordinary ranks. The same window scan
 * then finds the wheel for free, reporting its high card as a five.
 *
 * Returns `null` rather than `-1` because TypeScript narrows numeric literal
 * unions only through equality, not through `>= 0` — so a `-1` sentinel would
 * silently stay inside the `Rank` type at every call site.
 */
function straightHigh(rankMask: number): Rank | null {
  const ACE_BIT = 1 << 12;
  const extended = ((rankMask << 1) | (rankMask & ACE_BIT ? 1 : 0)) & 0x3fff;

  for (let top = 13; top >= 4; top--) {
    const window = 0b11111 << (top - 4);
    if ((extended & window) === window) return (top - 1) as Rank;
  }
  return null;
}

/** The `count` highest ranks present in `mask`, skipping anything in `excludeMask`. */
function topRanks(mask: number, count: number, excludeMask = 0): Rank[] {
  const available = mask & ~excludeMask;
  const out: Rank[] = [];
  for (let r = 12; r >= 0 && out.length < count; r--) {
    if (available & (1 << r)) out.push(r as Rank);
  }
  return out;
}

/**
 * Rank a holding of 5 to 7 cards, returning the value of its best five.
 *
 * Throws on the wrong number of cards. Duplicate cards are *not* checked here —
 * `parseCards` and the dealing code guarantee uniqueness upstream, and re-checking
 * on every evaluation would cost more than the bug it defends against.
 */
export function evaluate(cards: readonly Card[]): HandValue {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`evaluate() needs 5-7 cards, got ${cards.length}`);
  }

  const rankCounts = new Array<number>(13).fill(0);
  const suitMasks = [0, 0, 0, 0];
  const suitCounts = [0, 0, 0, 0];
  let rankMask = 0;

  for (const card of cards) {
    const rank = rankOf(card);
    const suit = suitOf(card);
    rankCounts[rank]!++;
    rankMask |= 1 << rank;
    suitMasks[suit]! |= 1 << rank;
    suitCounts[suit]!++;
  }

  // At most one suit can reach five cards out of seven, so the first hit is the
  // only candidate — no need to keep looking for a "better" flush suit.
  let flushSuit = -1;
  for (let s = 0; s < 4; s++) {
    if (suitCounts[s]! >= 5) {
      flushSuit = s;
      break;
    }
  }

  if (flushSuit >= 0) {
    const straightFlushHigh = straightHigh(suitMasks[flushSuit]!);
    if (straightFlushHigh !== null) {
      return makeValue(HandCategory.StraightFlush, [straightFlushHigh]);
    }
  }

  // Collected high-to-low so index 0 is always the best of each kind.
  const quads: Rank[] = [];
  const trips: Rank[] = [];
  const pairs: Rank[] = [];
  for (let r = 12; r >= 0; r--) {
    switch (rankCounts[r]) {
      case 4:
        quads.push(r as Rank);
        break;
      case 3:
        trips.push(r as Rank);
        break;
      case 2:
        pairs.push(r as Rank);
        break;
      default:
        break;
    }
  }

  if (quads.length > 0) {
    const quad = quads[0]!;
    return makeValue(HandCategory.FourOfAKind, [quad, ...topRanks(rankMask, 1, 1 << quad)]);
  }

  // Seven cards can hold two separate sets; the lower one plays as the pair.
  if (trips.length >= 2) {
    return makeValue(HandCategory.FullHouse, [trips[0]!, trips[1]!]);
  }
  if (trips.length === 1 && pairs.length >= 1) {
    return makeValue(HandCategory.FullHouse, [trips[0]!, pairs[0]!]);
  }

  if (flushSuit >= 0) {
    return makeValue(HandCategory.Flush, topRanks(suitMasks[flushSuit]!, 5));
  }

  const high = straightHigh(rankMask);
  if (high !== null) return makeValue(HandCategory.Straight, [high]);

  if (trips.length === 1) {
    const trip = trips[0]!;
    return makeValue(HandCategory.ThreeOfAKind, [trip, ...topRanks(rankMask, 2, 1 << trip)]);
  }

  // With three pairs the third pair's rank is still a legal kicker, which falls
  // out of excluding only the top two from the mask.
  if (pairs.length >= 2) {
    const [hi, lo] = [pairs[0]!, pairs[1]!];
    return makeValue(HandCategory.TwoPair, [hi, lo, ...topRanks(rankMask, 1, (1 << hi) | (1 << lo))]);
  }

  if (pairs.length === 1) {
    const pair = pairs[0]!;
    return makeValue(HandCategory.Pair, [pair, ...topRanks(rankMask, 3, 1 << pair)]);
  }

  return makeValue(HandCategory.HighCard, topRanks(rankMask, 5));
}

/** Compare two hands. Negative if `a` loses, positive if `a` wins, `0` for a tie. */
export function compareHands(a: HandValue, b: HandValue): number {
  return a.score - b.score;
}

/** Human-readable description for hand histories and the spectator UI. */
export function describeHand(value: HandValue): string {
  const name = CATEGORY_NAMES[value.category];
  const [first, second] = value.ranks;
  const label = (r: Rank | undefined) => (r === undefined ? '' : RANK_CHARS[r]);

  switch (value.category) {
    case HandCategory.StraightFlush:
      return first === 12 ? 'Royal Flush' : `${name}, ${label(first)} high`;
    case HandCategory.Straight:
      return `${name}, ${label(first)} high`;
    case HandCategory.FullHouse:
      return `${name}, ${label(first)}s full of ${label(second)}s`;
    case HandCategory.FourOfAKind:
    case HandCategory.ThreeOfAKind:
    case HandCategory.Pair:
      return `${name}, ${label(first)}s`;
    case HandCategory.TwoPair:
      return `${name}, ${label(first)}s and ${label(second)}s`;
    case HandCategory.Flush:
    case HandCategory.HighCard:
      return `${name}, ${label(first)} high`;
  }
}
