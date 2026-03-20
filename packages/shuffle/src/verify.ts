/**
 * Standalone hand verifier.
 *
 * Given the facts Clawroll publishes for a finished hand, this recomputes the deck
 * from scratch and checks it against what was actually dealt. It answers one question:
 * *did the server deal the cards it committed to, before it knew anything?*
 *
 * ## This file deliberately does not reuse the engine's dealing code
 *
 * `reconstructDeal` below re-implements the dealing contract — one card at a time from
 * the small blind for two passes, then burn-one-deal-three / burn-one-deal-one twice —
 * rather than importing `startHand` from `@clawroll/poker`.
 *
 * That looks like duplication, and it is deliberate. A verifier that calls the same
 * function the dealer called cannot detect a change in that function; it would agree
 * with the engine by construction, including when the engine is wrong. Two independent
 * implementations plus `verify.test.ts` asserting they agree is a materially stronger
 * guarantee than one shared helper.
 *
 * It also means this file, on its own, is a complete and readable statement of the
 * dealing spec for anyone porting the verifier to another language.
 */

import {
  type Card,
  DECK_SIZE,
  cardToString,
  cardsToString,
  parseCards,
} from '@clawroll/poker';
import { type ClientSeed, commitmentFor, shuffleDeck } from './shuffle.js';

export interface HandProof {
  readonly handId: string;
  /** The commitment published in `hand_start`, before any card was dealt. */
  readonly commit: string;
  /** The seed revealed at hand end. */
  readonly serverSeed: string;
  readonly clientSeeds: readonly ClientSeed[];
  /** Seats dealt in, ascending. Required to check hole cards. */
  readonly seats?: readonly number[];
  readonly buttonSeat?: number;
  /** Published hole cards per seat, e.g. `{ seat: 0, cards: 'AsKd' }`. */
  readonly holeCards?: readonly { readonly seat: number; readonly cards: string }[];
  /** Published board, e.g. `'2h5s9c Jd Th'`. Any prefix length is accepted. */
  readonly board?: string;
}

export interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface VerificationResult {
  readonly ok: boolean;
  readonly checks: readonly Check[];
  /** The deck recomputed from the published seeds. */
  readonly deck: readonly Card[];
}

/**
 * Re-derive hole cards and board from a shuffled deck.
 *
 * The dealing contract, stated in full:
 * - The small blind is the seat left of the button, except heads-up where the button
 *   *is* the small blind.
 * - Hole cards go one at a time clockwise from the small blind, for two passes.
 * - One card is burned before the flop, the turn, and the river.
 */
export function reconstructDeal(
  deck: readonly Card[],
  seats: readonly number[],
  buttonSeat: number,
): { holeCards: Map<number, [Card, Card]>; board: Card[] } {
  const ordered = [...seats].sort((a, b) => a - b);
  if (ordered.length < 2) throw new Error('A hand needs at least 2 seats');
  if (!ordered.includes(buttonSeat)) throw new Error(`Button seat ${buttonSeat} is not seated`);

  const after = (seat: number): number => {
    const idx = ordered.indexOf(seat);
    return ordered[(idx + 1) % ordered.length]!;
  };

  const smallBlind = ordered.length === 2 ? buttonSeat : after(buttonSeat);

  const dealOrder: number[] = [];
  let cursor = smallBlind;
  for (let i = 0; i < ordered.length; i++) {
    dealOrder.push(cursor);
    cursor = after(cursor);
  }

  const holeCards = new Map<number, [Card, Card]>();
  let index = 0;
  const firstPass = new Map<number, Card>();
  for (const seat of dealOrder) firstPass.set(seat, deck[index++]!);
  for (const seat of dealOrder) holeCards.set(seat, [firstPass.get(seat)!, deck[index++]!]);

  index += 1; // burn
  const board = [deck[index++]!, deck[index++]!, deck[index++]!];
  index += 1; // burn
  board.push(deck[index++]!);
  index += 1; // burn
  board.push(deck[index++]!);

  return { holeCards, board };
}

function check(name: string, passed: boolean, detail: string): Check {
  return { name, passed, detail };
}

/**
 * Verify a published hand.
 *
 * The commitment check is the one that matters: it proves the revealed `serverSeed`
 * is the one committed to before the deal, so the server could not have chosen it
 * after seeing client entropy. Everything else confirms the deck was then used as
 * claimed.
 *
 * Checks against hole cards and board only run when those facts are supplied; a proof
 * carrying just seeds and a commitment still verifies the binding.
 */
export function verifyHand(proof: HandProof): VerificationResult {
  const checks: Check[] = [];

  let commitOk = false;
  try {
    const recomputed = commitmentFor(proof.serverSeed);
    commitOk = recomputed === proof.commit.toLowerCase();
    checks.push(
      check(
        'commitment',
        commitOk,
        commitOk
          ? 'revealed seed matches the commitment published before the deal'
          : `commitment mismatch: published ${proof.commit}, seed hashes to ${recomputed}`,
      ),
    );
  } catch (error) {
    checks.push(check('commitment', false, `invalid server seed: ${(error as Error).message}`));
    return { ok: false, checks, deck: [] };
  }

  const deck = shuffleDeck({
    handId: proof.handId,
    serverSeed: proof.serverSeed,
    clientSeeds: proof.clientSeeds,
  });

  checks.push(
    check(
      'deck',
      new Set(deck).size === DECK_SIZE,
      `recomputed a ${deck.length}-card deck, first five ${cardsToString(deck.slice(0, 5))}`,
    ),
  );

  const wantsDealChecks = proof.holeCards !== undefined || proof.board !== undefined;
  if (wantsDealChecks) {
    if (proof.seats === undefined || proof.buttonSeat === undefined) {
      checks.push(
        check('deal', false, 'seats and buttonSeat are required to check hole cards or board'),
      );
      return { ok: false, checks, deck };
    }

    const dealt = reconstructDeal(deck, proof.seats, proof.buttonSeat);

    for (const claim of proof.holeCards ?? []) {
      const expected = dealt.holeCards.get(claim.seat);
      if (!expected) {
        checks.push(check(`hole:seat${claim.seat}`, false, 'seat was not dealt in'));
        continue;
      }
      const actual = parseCards(claim.cards);
      const matches =
        actual.length === 2 && actual[0] === expected[0] && actual[1] === expected[1];
      checks.push(
        check(
          `hole:seat${claim.seat}`,
          matches,
          matches
            ? `${cardsToString(expected)} as published`
            : `published ${cardsToString(actual)} but deck yields ${cardsToString(expected)}`,
        ),
      );
    }

    if (proof.board !== undefined) {
      const claimed = parseCards(proof.board);
      const expected = dealt.board.slice(0, claimed.length);
      const matches = claimed.every((card, i) => card === expected[i]);
      checks.push(
        check(
          'board',
          matches,
          matches
            ? `${cardsToString(expected)} as published`
            : `published ${cardsToString(claimed)} but deck yields ${cardsToString(expected)}`,
        ),
      );
    }
  }

  return { ok: checks.every((c) => c.passed), checks, deck };
}

/** Render a result as human-readable lines, for the CLI and for logs. */
export function formatResult(result: VerificationResult): string {
  const lines = result.checks.map((c) => `  ${c.passed ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
  const headline = result.ok
    ? 'VERIFIED — this hand was dealt from the committed seed'
    : 'FAILED — this hand does not match its published commitment';
  return [headline, '', ...lines].join('\n');
}

/** First `count` cards of the recomputed deck, as notation. Handy when debugging a proof. */
export function deckPreview(deck: readonly Card[], count = DECK_SIZE): string {
  return deck.slice(0, count).map(cardToString).join(' ');
}
