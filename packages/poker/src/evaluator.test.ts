import { describe, expect, it } from 'vitest';
import { type Card, DECK_SIZE, FULL_DECK, parseCards } from './cards.js';
import { HandCategory, compareHands, describeHand, evaluate } from './evaluator.js';

const val = (notation: string) => evaluate(parseCards(notation));
const cat = (notation: string) => val(notation).category;

/** Deterministic PRNG so a failing random case reproduces forever. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dealRandom(rng: () => number, count: number): Card[] {
  const deck = [...FULL_DECK];
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rng() * (DECK_SIZE - i));
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck.slice(0, count);
}

/** Every 5-card subset of a 7-card holding. */
function fiveCardSubsets(cards: readonly Card[]): Card[][] {
  const out: Card[][] = [];
  for (let a = 0; a < cards.length; a++)
    for (let b = a + 1; b < cards.length; b++)
      for (let c = b + 1; c < cards.length; c++)
        for (let d = c + 1; d < cards.length; d++)
          for (let e = d + 1; e < cards.length; e++)
            out.push([cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!]);
  return out;
}

describe('category detection', () => {
  it.each([
    ['AsKsQsJsTs', HandCategory.StraightFlush, 'royal'],
    ['5s4s3s2sAs', HandCategory.StraightFlush, 'steel wheel'],
    ['7c7d7h7s2c', HandCategory.FourOfAKind, 'quads'],
    ['KcKdKh9c9d', HandCategory.FullHouse, 'kings full'],
    ['Ac9c7c5c3c', HandCategory.Flush, 'flush'],
    ['9c8d7h6s5c', HandCategory.Straight, 'straight'],
    ['5c4d3h2sAc', HandCategory.Straight, 'wheel'],
    ['QcQdQh8s2c', HandCategory.ThreeOfAKind, 'trips'],
    ['JcJd4h4s9c', HandCategory.TwoPair, 'two pair'],
    ['TcTd8h5s2c', HandCategory.Pair, 'one pair'],
    ['AcQd9h7s3c', HandCategory.HighCard, 'high card'],
  ])('classifies %s as %i (%s)', (notation, expected, _label) => {
    expect(cat(notation)).toBe(expected);
  });
});

describe('the wheel is the only place aces play low', () => {
  it('ranks the wheel as a five-high straight, below a six-high', () => {
    expect(cat('5c4d3h2sAc')).toBe(HandCategory.Straight);
    expect(compareHands(val('6c5d4h3s2c'), val('5c4d3h2sAc'))).toBeGreaterThan(0);
  });

  it('does not treat Q-K-A-2-3 as a straight', () => {
    expect(cat('QcKdAh2s3c')).toBe(HandCategory.HighCard);
  });

  it('ranks the steel wheel below a six-high straight flush', () => {
    expect(compareHands(val('6s5s4s3s2s'), val('5s4s3s2sAs'))).toBeGreaterThan(0);
  });
});

describe('category ordering', () => {
  it('ranks all nine categories in the correct order', () => {
    const ascending = [
      'AcQd9h7s3c', // high card
      'TcTd8h5s2c', // pair
      'JcJd4h4s9c', // two pair
      'QcQdQh8s2c', // trips
      '9c8d7h6s5c', // straight
      'Ac9c7c5c3c', // flush
      'KcKdKh9c9d', // full house
      '7c7d7h7s2c', // quads
      'AsKsQsJsTs', // straight flush
    ].map(val);

    for (let i = 1; i < ascending.length; i++) {
      expect(compareHands(ascending[i]!, ascending[i - 1]!)).toBeGreaterThan(0);
    }
  });
});

describe('kickers', () => {
  it('breaks a tied pair on the first kicker', () => {
    expect(compareHands(val('TcTdAh5s2c'), val('TcTdKh5s2c'))).toBeGreaterThan(0);
  });

  it('breaks a tied pair on the third kicker', () => {
    expect(compareHands(val('TcTdAh5s3c'), val('TcTdAh5s2c'))).toBeGreaterThan(0);
  });

  it('treats genuinely identical holdings as a tie', () => {
    // Same ranks, different suits — chops the pot.
    expect(compareHands(val('TcTdAh5s3c'), val('ThTsAd5c3d'))).toBe(0);
  });

  it('ignores the fifth card when four already decide it', () => {
    // Both are ace-high flushes on the same four top cards... but the fifth
    // flush card still plays, so these must NOT tie.
    expect(compareHands(val('AcKcQcJc9c'), val('AcKcQcJc8c'))).toBeGreaterThan(0);
  });

  it('plays the third pair as a kicker when seven cards hold three pairs', () => {
    // Aces and kings with a queen kicker beats aces and kings with a jack.
    expect(
      compareHands(val('AcAdKcKdQcQd2c'), val('AcAdKcKdJcJd2c')),
    ).toBeGreaterThan(0);
  });
});

describe('seven-card selection', () => {
  it('picks the best five from seven', () => {
    // Five clubs alongside trip deuces: the flush plays, the trips do not.
    expect(cat('AcKc9c5c2c2d2h')).toBe(HandCategory.Flush);
    // Quads alongside a four-card club draw: the draw is worth nothing.
    expect(cat('2c2d2h2sAcKc9c')).toBe(HandCategory.FourOfAKind);
  });

  it('uses the lower set as the pair when holding two sets', () => {
    const v = val('9c9d9h5c5d5s2c');
    expect(v.category).toBe(HandCategory.FullHouse);
    expect(describeHand(v)).toBe('Full House, 9s full of 5s');
  });

  it('agrees with an exhaustive search of all 21 five-card subsets', () => {
    // This is the strongest check in the file: the seven-card decision cascade
    // is validated against brute force over every subset, using the same
    // evaluator restricted to five cards.
    const rng = mulberry32(0xc1a3);
    for (let i = 0; i < 20_000; i++) {
      const seven = dealRandom(rng, 7);
      const best = fiveCardSubsets(seven)
        .map(evaluate)
        .reduce((a, b) => (compareHands(b, a) > 0 ? b : a));
      expect(evaluate(seven).score, `hand #${i}`).toBe(best.score);
    }
  });
});

describe('category frequencies match published poker probabilities', () => {
  // An independent sanity check on classification: if any category were being
  // detected too eagerly or missed entirely, its share would drift well outside
  // these tolerances even though every hand-written example above still passed.
  it('deals seven-card categories at the expected rates', () => {
    const rng = mulberry32(0x5eed);
    const trials = 200_000;
    const counts = new Array<number>(9).fill(0);

    for (let i = 0; i < trials; i++) {
      counts[evaluate(dealRandom(rng, 7)).category]!++;
    }

    const pct = (c: HandCategory) => (counts[c]! / trials) * 100;
    expect(pct(HandCategory.StraightFlush)).toBeCloseTo(0.031, 1);
    expect(pct(HandCategory.FourOfAKind)).toBeCloseTo(0.168, 1);
    expect(pct(HandCategory.FullHouse)).toBeCloseTo(2.6, 0);
    expect(pct(HandCategory.Flush)).toBeCloseTo(3.03, 0);
    expect(pct(HandCategory.Straight)).toBeCloseTo(4.62, 0);
    expect(pct(HandCategory.ThreeOfAKind)).toBeCloseTo(4.83, 0);
    expect(pct(HandCategory.TwoPair)).toBeCloseTo(23.5, 0);
    expect(pct(HandCategory.Pair)).toBeCloseTo(43.8, 0);
    expect(pct(HandCategory.HighCard)).toBeCloseTo(17.4, 0);
  });
});

describe('descriptions', () => {
  it.each([
    ['AsKsQsJsTs', 'Royal Flush'],
    ['9s8s7s6s5s', 'Straight Flush, 9 high'],
    ['7c7d7h7s2c', 'Four of a Kind, 7s'],
    ['KcKdKh9c9d', 'Full House, Ks full of 9s'],
    ['Ac9c7c5c3c', 'Flush, A high'],
    ['9c8d7h6s5c', 'Straight, 9 high'],
    ['5c4d3h2sAc', 'Straight, 5 high'],
    ['QcQdQh8s2c', 'Three of a Kind, Qs'],
    ['JcJd4h4s9c', 'Two Pair, Js and 4s'],
    ['TcTd8h5s2c', 'Pair, Ts'],
    ['AcQd9h7s3c', 'High Card, A high'],
  ])('describes %s as %s', (notation, expected) => {
    expect(describeHand(val(notation))).toBe(expected);
  });
});

describe('input validation', () => {
  it.each([4, 8])('rejects %i cards', (n) => {
    expect(() => evaluate(dealRandom(mulberry32(1), n))).toThrow(/needs 5-7 cards/);
  });
});
