import { describe, expect, it } from 'vitest';
import {
  DECK_SIZE,
  FULL_DECK,
  type Card,
  type Rank,
  type Suit,
  cardToString,
  cardsToString,
  isCard,
  makeCard,
  parseCard,
  parseCards,
  rankOf,
  suitOf,
} from './cards.js';

describe('canonical ordering', () => {
  // These four assertions pin the published fairness contract. If any of them
  // fails, every previously published hand history has become unverifiable —
  // so this is deliberately spelled out rather than derived from the constants.
  it('places 2c at index 0 and As at index 51', () => {
    expect(cardToString(0 as Card)).toBe('2c');
    expect(cardToString(51 as Card)).toBe('As');
  });

  it('orders suits c,d,h,s within a rank', () => {
    expect(cardsToString(FULL_DECK.slice(0, 4))).toBe('2c 2d 2h 2s');
  });

  it('orders ranks 2..A ascending', () => {
    const acesLow = FULL_DECK.filter((c) => suitOf(c) === 0).map(cardToString);
    expect(acesLow.join(' ')).toBe('2c 3c 4c 5c 6c 7c 8c 9c Tc Jc Qc Kc Ac');
  });

  it('is a complete 52-card deck with no duplicates', () => {
    expect(FULL_DECK).toHaveLength(DECK_SIZE);
    expect(new Set(FULL_DECK).size).toBe(DECK_SIZE);
  });
});

describe('rank/suit encoding', () => {
  it('round-trips every (rank, suit) pair', () => {
    for (let r = 0; r < 13; r++) {
      for (let s = 0; s < 4; s++) {
        const card = makeCard(r as Rank, s as Suit);
        expect(rankOf(card)).toBe(r);
        expect(suitOf(card)).toBe(s);
      }
    }
  });

  it('assigns a distinct integer to each of the 52 cards', () => {
    const encoded = new Set<number>();
    for (let r = 0; r < 13; r++) {
      for (let s = 0; s < 4; s++) encoded.add(makeCard(r as Rank, s as Suit));
    }
    expect(encoded.size).toBe(DECK_SIZE);
  });
});

describe('isCard', () => {
  it('accepts the valid range and rejects everything else', () => {
    expect(isCard(0)).toBe(true);
    expect(isCard(51)).toBe(true);
    expect(isCard(-1)).toBe(false);
    expect(isCard(52)).toBe(false);
    expect(isCard(1.5)).toBe(false);
    expect(isCard(Number.NaN)).toBe(false);
  });
});

describe('parse/format round-trip', () => {
  it('survives a round-trip for all 52 cards', () => {
    for (const card of FULL_DECK) {
      expect(parseCard(cardToString(card))).toBe(card);
    }
  });

  it('accepts mixed case', () => {
    expect(parseCard('as')).toBe(parseCard('As'));
    expect(parseCard('AS')).toBe(parseCard('As'));
    expect(parseCard('tD')).toBe(parseCard('Td'));
  });

  it('parses compact and spaced card lists identically', () => {
    expect(parseCards('AsKdQh')).toEqual(parseCards('As Kd Qh'));
    expect(cardsToString(parseCards('AsKdQh'))).toBe('As Kd Qh');
  });

  it('parses an empty list', () => {
    expect(parseCards('')).toEqual([]);
  });
});

describe('parse failures are loud', () => {
  // A card that silently parses to the wrong value is far more dangerous at a
  // poker table than one that throws, so every malformed input must throw.
  it.each([
    ['A', 'too short'],
    ['Ass', 'too long'],
    ['Xs', 'unknown rank'],
    ['Ax', 'unknown suit'],
    ['1s', 'ranks start at 2'],
    ['10s', 'ten is T, not 10'],
  ])('rejects %s (%s)', (input) => {
    expect(() => parseCard(input)).toThrow();
  });

  it('rejects an odd-length card list', () => {
    expect(() => parseCards('AsK')).toThrow(/odd number/);
  });

  it('rejects duplicate cards in a list', () => {
    expect(() => parseCards('AsAs')).toThrow(/duplicate As/);
    expect(() => parseCards('AsKd As')).toThrow(/duplicate As/);
  });
});

describe('FULL_DECK immutability', () => {
  // Shared across every hand in the process; mutation would corrupt shuffles
  // on unrelated tables in a way that would be extremely hard to trace back.
  it('is frozen', () => {
    expect(Object.isFrozen(FULL_DECK)).toBe(true);
    expect(() => {
      (FULL_DECK as Card[])[0] = 51 as Card;
    }).toThrow();
  });
});
