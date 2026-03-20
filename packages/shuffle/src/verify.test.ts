import { describe, expect, it } from 'vitest';
import {
  type HandState,
  applyAction,
  cardsToString,
  legalActions,
  seatAt,
  startHand,
} from '@clawroll/poker';
import { createCommitment, shuffleDeck } from './shuffle.js';
import { type HandProof, formatResult, reconstructDeal, verifyHand } from './verify.js';

const SERVER = createCommitment();

function proofFor(overrides: Partial<HandProof> = {}): HandProof {
  return {
    handId: 'h-1',
    commit: SERVER.commit,
    serverSeed: SERVER.serverSeed,
    clientSeeds: [
      { seat: 0, seed: '1'.repeat(64) },
      { seat: 1, seed: '2'.repeat(64) },
    ],
    ...overrides,
  };
}

const deckFor = (proof: HandProof) =>
  shuffleDeck({
    handId: proof.handId,
    serverSeed: proof.serverSeed,
    clientSeeds: proof.clientSeeds,
  });

/** Everyone checks or calls until the hand reaches showdown. */
function runToShowdown(start: HandState): HandState {
  let state = start;
  let guard = 0;
  while (state.actingSeat !== null) {
    const legal = legalActions(state)!;
    state = applyAction(state, {
      type: legal.canCheck ? 'check' : 'call',
      seat: legal.seat,
    }).state;
    if (++guard > 200) throw new Error('hand did not terminate');
  }
  return state;
}

describe('the verifier agrees with the engine', () => {
  // This is the reason `reconstructDeal` is written independently rather than calling
  // startHand. A verifier that reuses the dealer's own code agrees with it by
  // construction — including when the dealer is wrong. These tests are what make the
  // duplication worth having: if the two implementations ever drift, this fails.
  it.each([2, 3, 4, 6, 9])('reproduces the hole cards dealt %i-handed', (seatCount) => {
    const deck = deckFor(proofFor());

    for (let button = 0; button < seatCount; button++) {
      const players = Array.from({ length: seatCount }, (_, i) => ({
        seat: i,
        playerId: `p${i}`,
        stack: 10_000,
      }));

      const engine = startHand({
        handId: 'h-1',
        buttonSeat: button,
        smallBlind: 50,
        bigBlind: 100,
        players,
        deck,
      });

      const rebuilt = reconstructDeal(deck, players.map((p) => p.seat), button);

      for (const player of players) {
        expect(
          cardsToString(rebuilt.holeCards.get(player.seat)!),
          `${seatCount}-handed, button ${button}, seat ${player.seat}`,
        ).toBe(cardsToString(seatAt(engine, player.seat).holeCards!));
      }
    }
  });

  it.each([2, 3, 6])('reproduces the board dealt %i-handed, burns included', (seatCount) => {
    const deck = deckFor(proofFor());
    const players = Array.from({ length: seatCount }, (_, i) => ({
      seat: i,
      playerId: `p${i}`,
      stack: 10_000,
    }));

    const finished = runToShowdown(
      startHand({
        handId: 'h-1',
        buttonSeat: 0,
        smallBlind: 50,
        bigBlind: 100,
        players,
        deck,
      }),
    );

    expect(finished.board).toHaveLength(5);
    const rebuilt = reconstructDeal(deck, players.map((p) => p.seat), 0);
    expect(cardsToString(rebuilt.board)).toBe(cardsToString(finished.board));
  });

  it('applies the heads-up small blind inversion', () => {
    const deck = deckFor(proofFor());
    // Heads-up the button IS the small blind, so it receives the first card.
    const rebuilt = reconstructDeal(deck, [0, 1], 0);
    expect(rebuilt.holeCards.get(0)![0]).toBe(deck[0]);
    expect(rebuilt.holeCards.get(1)![0]).toBe(deck[1]);
  });
});

describe('commitment verification', () => {
  it('accepts a seed matching its commitment', () => {
    const result = verifyHand(proofFor());
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.name === 'commitment')!.passed).toBe(true);
  });

  it('rejects a server seed that does not match the commitment', () => {
    // The attack this exists to catch: the server sees client entropy, then reveals a
    // different seed that produces a deck it prefers.
    const result = verifyHand(proofFor({ serverSeed: 'f'.repeat(64) }));
    expect(result.ok).toBe(false);
    expect(result.checks[0]!.detail).toMatch(/commitment mismatch/);
  });

  it('rejects a malformed server seed without throwing', () => {
    const result = verifyHand(proofFor({ serverSeed: 'nonsense' }));
    expect(result.ok).toBe(false);
    expect(result.checks[0]!.detail).toMatch(/invalid server seed/);
  });

  it('is case-insensitive about the published commitment', () => {
    expect(verifyHand(proofFor({ commit: SERVER.commit.toUpperCase() })).ok).toBe(true);
  });
});

describe('card verification', () => {
  const seats = [0, 1, 2];
  const buttonSeat = 0;

  function fullProof(overrides: Partial<HandProof> = {}): HandProof {
    const base = proofFor({ seats, buttonSeat });
    const dealt = reconstructDeal(deckFor(base), seats, buttonSeat);
    return {
      ...base,
      holeCards: seats.map((s) => ({ seat: s, cards: cardsToString(dealt.holeCards.get(s)!) })),
      board: cardsToString(dealt.board),
      ...overrides,
    };
  }

  it('verifies a complete published hand', () => {
    const result = verifyHand(fullProof());
    expect(result.ok).toBe(true);
    expect(result.checks.filter((c) => c.passed)).toHaveLength(result.checks.length);
  });

  it('catches hole cards that do not match the deck', () => {
    const proof = fullProof();
    const tampered = {
      ...proof,
      holeCards: [{ seat: 0, cards: 'AsKs' }, ...proof.holeCards!.slice(1)],
    };
    const result = verifyHand(tampered);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === 'hole:seat0')!.detail).toMatch(/but deck yields/);
  });

  it('catches a board that does not match the deck', () => {
    const result = verifyHand(fullProof({ board: '2c3c4c5c6c' }));
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === 'board')!.detail).toMatch(/but deck yields/);
  });

  it('accepts a partial board for a hand that ended early', () => {
    const proof = fullProof();
    const flopOnly = cardsToString(reconstructDeal(deckFor(proof), seats, buttonSeat).board.slice(0, 3));
    expect(verifyHand({ ...proof, board: flopOnly }).ok).toBe(true);
  });

  it('verifies seeds alone when no cards are published', () => {
    const result = verifyHand(proofFor());
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual(['commitment', 'deck']);
  });

  it('requires seats and button when cards are published', () => {
    const result = verifyHand(proofFor({ holeCards: [{ seat: 0, cards: 'AsKs' }] }));
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === 'deal')!.detail).toMatch(/required/);
  });

  it('flags a claim for a seat that was not dealt in', () => {
    const result = verifyHand(fullProof({ holeCards: [{ seat: 8, cards: 'AsKs' }] }));
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === 'hole:seat8')!.detail).toMatch(/not dealt in/);
  });
});

describe('reconstructDeal validation', () => {
  const deck = deckFor(proofFor());

  it('rejects fewer than two seats', () => {
    expect(() => reconstructDeal(deck, [0], 0)).toThrow(/at least 2 seats/);
  });

  it('rejects a button that is not seated', () => {
    expect(() => reconstructDeal(deck, [0, 1], 5)).toThrow(/not seated/);
  });

  it('deals distinct cards to every seat', () => {
    const { holeCards, board } = reconstructDeal(deck, [0, 1, 2, 3, 4, 5], 2);
    const all = [...[...holeCards.values()].flat(), ...board];
    expect(all).toHaveLength(17);
    expect(new Set(all).size).toBe(17);
  });
});

describe('result formatting', () => {
  it('leads with a verdict a human can read', () => {
    expect(formatResult(verifyHand(proofFor()))).toMatch(/^VERIFIED/);
    expect(formatResult(verifyHand(proofFor({ serverSeed: 'f'.repeat(64) })))).toMatch(/^FAILED/);
  });

  it('lists every check with its outcome', () => {
    const text = formatResult(verifyHand(proofFor()));
    expect(text).toContain('PASS  commitment');
    expect(text).toContain('PASS  deck');
  });
});
