/**
 * Card primitives.
 *
 * ## The canonical ordering is a published specification
 *
 * A card is a plain integer in `[0, 51]`, defined as:
 *
 * ```
 * card = rank * 4 + suit
 * ```
 *
 * where `rank` runs `0..12` as `2,3,4,5,6,7,8,9,T,J,Q,K,A` and `suit` runs
 * `0..3` as `c,d,h,s`. So card `0` is `2c` and card `51` is `As`.
 *
 * This ordering is **not an implementation detail** — it is part of Clawroll's
 * public fairness contract. The provable shuffle works by seeding a Fisher-Yates
 * permutation of `FULL_DECK`, and a third party verifying a hand must be able to
 * reconstruct the exact same starting deck before shuffling it. If this ordering
 * ever changes, every previously published hand becomes unverifiable. Treat it as
 * frozen.
 *
 * ## Why integers rather than `{ rank, suit }` objects
 *
 * The evaluator ranks a 7-card hand by examining 21 five-card subsets, and the
 * engine deals thousands of hands. Integer cards let the hot path work with
 * bitmasks and array lookups instead of allocating and dereferencing objects.
 * The ergonomic cost is paid back by the helpers below and by `parseCards`,
 * which lets tests read in ordinary poker notation.
 */

/** Suit index. `0=c (clubs), 1=d (diamonds), 2=h (hearts), 3=s (spades)`. */
export type Suit = 0 | 1 | 2 | 3;

/** Rank index. `0` is a deuce and `12` is an ace. Aces are high here; the wheel
 *  straight (A-2-3-4-5) is handled in the evaluator, not in the encoding. */
export type Rank = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

declare const CARD_BRAND: unique symbol;

/**
 * A single playing card as an integer in `[0, 51]`.
 *
 * Branded so it cannot be confused with a `Rank`, a seat index, or a chip
 * amount — all of which are also small numbers and all of which would produce a
 * plausible-looking wrong answer if swapped in by mistake.
 */
export type Card = number & { readonly [CARD_BRAND]: true };

/** Suit characters in canonical order. Index is the `Suit`. */
export const SUIT_CHARS = ['c', 'd', 'h', 's'] as const;

/** Rank characters in canonical order. Index is the `Rank`. */
export const RANK_CHARS = [
  '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A',
] as const;

export const NUM_RANKS = 13;
export const NUM_SUITS = 4;
export const DECK_SIZE = NUM_RANKS * NUM_SUITS;

/** Build a card from its rank and suit. */
export function makeCard(rank: Rank, suit: Suit): Card {
  return (rank * NUM_SUITS + suit) as Card;
}

/** Extract the rank of a card. */
export function rankOf(card: Card): Rank {
  return Math.floor(card / NUM_SUITS) as Rank;
}

/** Extract the suit of a card. */
export function suitOf(card: Card): Suit {
  return (card % NUM_SUITS) as Suit;
}

/** Narrow an arbitrary number to a `Card`. */
export function isCard(value: number): value is Card {
  return Number.isInteger(value) && value >= 0 && value < DECK_SIZE;
}

/**
 * The full 52-card deck in canonical order, unshuffled.
 *
 * Frozen because it is shared by every hand in the process and mutating it
 * would silently corrupt shuffles across unrelated tables.
 */
export const FULL_DECK: readonly Card[] = Object.freeze(
  Array.from({ length: DECK_SIZE }, (_, i) => i as Card),
);

/** Render a card in standard poker notation, e.g. `As`, `Td`, `2c`. */
export function cardToString(card: Card): string {
  return `${RANK_CHARS[rankOf(card)]}${SUIT_CHARS[suitOf(card)]}`;
}

/** Render a list of cards, space-separated: `As Kd Qh`. */
export function cardsToString(cards: readonly Card[]): string {
  return cards.map(cardToString).join(' ');
}

/**
 * Parse a single card in standard poker notation.
 *
 * Rank is case-insensitive (`as` and `AS` both work); suit is too. Throws on
 * anything malformed rather than returning a sentinel — a card that silently
 * parses to the wrong value is far worse at a poker table than a loud failure.
 */
export function parseCard(text: string): Card {
  if (text.length !== 2) {
    throw new Error(`Invalid card ${JSON.stringify(text)}: expected 2 characters`);
  }
  const rankChar = text[0]!.toUpperCase();
  const suitChar = text[1]!.toLowerCase();

  const rank = RANK_CHARS.indexOf(rankChar as (typeof RANK_CHARS)[number]);
  const suit = SUIT_CHARS.indexOf(suitChar as (typeof SUIT_CHARS)[number]);

  if (rank === -1) {
    throw new Error(`Invalid card ${JSON.stringify(text)}: unknown rank ${JSON.stringify(text[0])}`);
  }
  if (suit === -1) {
    throw new Error(`Invalid card ${JSON.stringify(text)}: unknown suit ${JSON.stringify(text[1])}`);
  }
  return makeCard(rank as Rank, suit as Suit);
}

/**
 * Parse several cards from one string. Whitespace between cards is optional, so
 * both `"AsKdQh"` and `"As Kd Qh"` work. Intended mainly for tests and for hand
 * histories, where compact notation is far more readable than integer arrays.
 *
 * Rejects duplicates: a hand containing two `As` is always a bug, and catching
 * it here means the evaluator and the betting engine never have to.
 */
export function parseCards(text: string): Card[] {
  const compact = text.replace(/\s+/g, '');
  if (compact.length % 2 !== 0) {
    throw new Error(`Invalid card list ${JSON.stringify(text)}: odd number of characters`);
  }

  const cards: Card[] = [];
  const seen = new Set<Card>();
  for (let i = 0; i < compact.length; i += 2) {
    const card = parseCard(compact.slice(i, i + 2));
    if (seen.has(card)) {
      throw new Error(`Invalid card list ${JSON.stringify(text)}: duplicate ${cardToString(card)}`);
    }
    seen.add(card);
    cards.push(card);
  }
  return cards;
}
