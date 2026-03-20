import { describe, expect, it } from 'vitest';
import { DECK_SIZE, cardsToString, parseCard, rankOf, suitOf } from '@clawroll/poker';
import {
  type ClientSeed,
  type ShuffleInputs,
  SEED_BYTES,
  SeedStream,
  commitmentFor,
  createCommitment,
  deriveFinalSeed,
  randomClientSeed,
  shuffleDeck,
} from './shuffle.js';

const SERVER = 'a'.repeat(64);
const seed = (ch: string) => ch.repeat(64);

function inputs(overrides: Partial<ShuffleInputs> = {}): ShuffleInputs {
  return {
    handId: 'hand-1',
    serverSeed: SERVER,
    clientSeeds: [
      { seat: 0, seed: seed('1') },
      { seat: 1, seed: seed('2') },
    ],
    ...overrides,
  };
}

describe('commitment', () => {
  it('binds the server to one seed', () => {
    const { commit, serverSeed } = createCommitment();
    expect(commitmentFor(serverSeed)).toBe(commit);
  });

  it('produces a different commitment for a different seed', () => {
    expect(commitmentFor(seed('a'))).not.toBe(commitmentFor(seed('b')));
  });

  it('is a deterministic SHA256 of the raw seed bytes', () => {
    // Pinned so a future refactor cannot change what `commit` means. Verifiers in
    // other languages hash the 32 seed BYTES, not the 64-character hex string.
    expect(commitmentFor('00'.repeat(32))).toBe(
      '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925',
    );
  });

  it('generates 32-byte seeds', () => {
    const { serverSeed } = createCommitment();
    expect(serverSeed).toHaveLength(SEED_BYTES * 2);
    expect(randomClientSeed()).toHaveLength(SEED_BYTES * 2);
  });

  it('never repeats a server seed', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => createCommitment().serverSeed));
    expect(seen.size).toBe(1000);
  });

  it.each([['too short', 'ab'], ['not hex', 'z'.repeat(64)], ['empty', '']])(
    'rejects a %s seed',
    (_label, bad) => {
      expect(() => commitmentFor(bad)).toThrow(/32 bytes of hex/);
    },
  );
});

describe('final seed derivation', () => {
  it('is deterministic', () => {
    expect(deriveFinalSeed(inputs())).toBe(deriveFinalSeed(inputs()));
  });

  it('does not depend on the order client seeds arrived in', () => {
    // Client seeds are sorted by seat before hashing. Without this, a verifier
    // could compute a different deck from the same published facts and wrongly
    // conclude the hand was rigged.
    const forward: ClientSeed[] = [
      { seat: 0, seed: seed('1') },
      { seat: 1, seed: seed('2') },
      { seat: 2, seed: seed('3') },
    ];
    const shuffledOrder = [forward[2]!, forward[0]!, forward[1]!];
    expect(deriveFinalSeed(inputs({ clientSeeds: shuffledOrder }))).toBe(
      deriveFinalSeed(inputs({ clientSeeds: forward })),
    );
  });

  it('changes when any single client seed changes', () => {
    const base = deriveFinalSeed(inputs());
    const altered = deriveFinalSeed(
      inputs({ clientSeeds: [{ seat: 0, seed: seed('1') }, { seat: 1, seed: seed('3') }] }),
    );
    expect(altered).not.toBe(base);
  });

  it('changes when the server seed changes', () => {
    expect(deriveFinalSeed(inputs({ serverSeed: seed('b') }))).not.toBe(deriveFinalSeed(inputs()));
  });

  it('changes with the hand id, so identical seeds never repeat a deck', () => {
    expect(deriveFinalSeed(inputs({ handId: 'hand-2' }))).not.toBe(deriveFinalSeed(inputs()));
  });

  it('distinguishes the same seed submitted from a different seat', () => {
    const atSeat0 = deriveFinalSeed(inputs({ clientSeeds: [{ seat: 0, seed: seed('1') }] }));
    const atSeat5 = deriveFinalSeed(inputs({ clientSeeds: [{ seat: 5, seed: seed('1') }] }));
    expect(atSeat0).not.toBe(atSeat5);
  });

  it('accepts a hand with no client seeds at all', () => {
    expect(deriveFinalSeed(inputs({ clientSeeds: [] }))).toHaveLength(64);
  });

  it('rejects two client seeds for the same seat', () => {
    expect(() =>
      deriveFinalSeed(
        inputs({ clientSeeds: [{ seat: 1, seed: seed('1') }, { seat: 1, seed: seed('2') }] }),
      ),
    ).toThrow(/Duplicate client seed for seat 1/);
  });
});

describe('deck production', () => {
  it('returns a permutation of all 52 distinct cards', () => {
    const deck = shuffleDeck(inputs());
    expect(deck).toHaveLength(DECK_SIZE);
    expect(new Set(deck).size).toBe(DECK_SIZE);
    expect([...deck].sort((a, b) => a - b)).toEqual(
      Array.from({ length: DECK_SIZE }, (_, i) => i),
    );
  });

  it('is reproducible from the same inputs', () => {
    expect(shuffleDeck(inputs())).toEqual(shuffleDeck(inputs()));
  });

  it('actually shuffles', () => {
    const deck = shuffleDeck(inputs());
    const unshuffled = Array.from({ length: DECK_SIZE }, (_, i) => i);
    expect(deck).not.toEqual(unshuffled);
  });

  it('produces a different deck for any changed input', () => {
    const base = cardsToString(shuffleDeck(inputs()));
    expect(cardsToString(shuffleDeck(inputs({ handId: 'other' })))).not.toBe(base);
    expect(cardsToString(shuffleDeck(inputs({ serverSeed: seed('b') })))).not.toBe(base);
    expect(
      cardsToString(shuffleDeck(inputs({ clientSeeds: [{ seat: 0, seed: seed('9') }] }))),
    ).not.toBe(base);
  });
});

describe('rejection sampling removes modulo bias', () => {
  /** Feeds `uniformBelow` chosen 32-bit values so the boundary can be tested exactly. */
  class RiggedStream extends SeedStream {
    constructor(private readonly values: number[]) {
      super(Buffer.alloc(32));
    }
    override nextUint32(): number {
      const next = this.values.shift();
      if (next === undefined) throw new Error('RiggedStream exhausted');
      return next;
    }
  }

  // For range 52: floor(2^32 / 52) * 52 = 4294967248. Draws at or above that must be
  // discarded — taking `% 52` on them would make indices 0..47 marginally likelier.
  const LIMIT = Math.floor(0x1_0000_0000 / 52) * 52;

  it('discards a draw at or above the acceptance limit', () => {
    const stream = new RiggedStream([LIMIT, 5]);
    expect(stream.uniformBelow(52)).toBe(5);
  });

  it('discards several consecutive out-of-range draws', () => {
    const stream = new RiggedStream([LIMIT, LIMIT + 10, 0xffffffff, 51]);
    expect(stream.uniformBelow(52)).toBe(51);
  });

  it('accepts the largest in-range draw', () => {
    const stream = new RiggedStream([LIMIT - 1]);
    expect(stream.uniformBelow(52)).toBe((LIMIT - 1) % 52);
  });

  it('rejects a non-positive range', () => {
    expect(() => new RiggedStream([1]).uniformBelow(0)).toThrow(/must be positive/);
  });
});

describe('statistical uniformity', () => {
  /**
   * Chi-square over 51 degrees of freedom. A fair shuffle lands near 51; the
   * threshold of 110 corresponds to roughly a one-in-a-million false failure, while
   * any structural bias in the shuffle blows far past it.
   */
  function chiSquare(counts: readonly number[], total: number): number {
    const expected = total / counts.length;
    return counts.reduce((sum, observed) => sum + (observed - expected) ** 2 / expected, 0);
  }

  const TRIALS = 50_000;
  const THRESHOLD = 110;

  it('deals every card into the first position equally often', () => {
    const counts = new Array<number>(DECK_SIZE).fill(0);
    for (let i = 0; i < TRIALS; i++) {
      counts[shuffleDeck(inputs({ handId: `h${i}` }))[0]!]!++;
    }
    expect(chiSquare(counts, TRIALS)).toBeLessThan(THRESHOLD);
  });

  it('places one specific card into every position equally often', () => {
    // Complementary to the test above: that one checks a position across all cards,
    // this checks one card across all positions. A shuffle biased toward leaving
    // cards near where they started fails this while passing the other.
    const aceOfSpades = parseCard('As');
    const counts = new Array<number>(DECK_SIZE).fill(0);
    for (let i = 0; i < TRIALS; i++) {
      counts[shuffleDeck(inputs({ handId: `p${i}` })).indexOf(aceOfSpades)]!++;
    }
    expect(chiSquare(counts, TRIALS)).toBeLessThan(THRESHOLD);
  });

  it('shows no rank or suit bias in the first dealt card', () => {
    const ranks = new Array<number>(13).fill(0);
    const suits = new Array<number>(4).fill(0);
    for (let i = 0; i < TRIALS; i++) {
      const first = shuffleDeck(inputs({ handId: `r${i}` }))[0]!;
      ranks[rankOf(first)]!++;
      suits[suitOf(first)]!++;
    }
    // 12 and 3 degrees of freedom respectively.
    expect(chiSquare(ranks, TRIALS)).toBeLessThan(40);
    expect(chiSquare(suits, TRIALS)).toBeLessThan(25);
  });
});
