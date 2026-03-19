import { describe, expect, it } from 'vitest';
import { FULL_DECK, cardsToString, parseCards } from './cards.js';
import {
  type HandConfig,
  type HandPlayer,
  activeSeats,
  liveSeats,
  nextSeatWhere,
  seatAt,
  startHand,
  totalPot,
} from './handState.js';

const BB = 100;
const SB = 50;

function players(count: number, stack = 10_000): HandPlayer[] {
  return Array.from({ length: count }, (_, i) => ({
    seat: i,
    playerId: `p${i}`,
    stack,
  }));
}

function config(overrides: Partial<HandConfig> = {}): HandConfig {
  return {
    handId: 'h1',
    buttonSeat: 0,
    smallBlind: SB,
    bigBlind: BB,
    players: players(3),
    deck: FULL_DECK,
    ...overrides,
  };
}

describe('blind posting', () => {
  it('posts blinds clockwise from the button when three-handed', () => {
    const s = startHand(config());
    expect(seatAt(s, 1).committedThisStreet).toBe(SB);
    expect(seatAt(s, 2).committedThisStreet).toBe(BB);
    expect(seatAt(s, 0).committedThisStreet).toBe(0);
  });

  it('inverts the blinds heads-up so the button posts the small blind', () => {
    // The single most commonly mis-implemented rule in Hold'em.
    const s = startHand(config({ players: players(2), buttonSeat: 0 }));
    expect(seatAt(s, 0).committedThisStreet).toBe(SB);
    expect(seatAt(s, 1).committedThisStreet).toBe(BB);
  });

  it('deducts blinds from stacks', () => {
    const s = startHand(config());
    expect(seatAt(s, 1).stack).toBe(10_000 - SB);
    expect(seatAt(s, 2).stack).toBe(10_000 - BB);
    expect(seatAt(s, 0).stack).toBe(10_000);
  });

  it('puts a short blind all-in rather than into debt', () => {
    const short = [
      { seat: 0, playerId: 'p0', stack: 10_000 },
      { seat: 1, playerId: 'p1', stack: 10_000 },
      { seat: 2, playerId: 'p2', stack: 30 },
    ];
    const s = startHand(config({ players: short }));
    expect(seatAt(s, 2).stack).toBe(0);
    expect(seatAt(s, 2).committedThisStreet).toBe(30);
    expect(seatAt(s, 2).status).toBe('allin');
  });

  it('sets the opening raise increment to the big blind', () => {
    const s = startHand(config());
    expect(s.betToCall).toBe(BB);
    expect(s.lastRaiseIncrement).toBe(BB);
  });
});

describe('first to act', () => {
  it('starts left of the big blind when three-handed', () => {
    // Button 0, SB 1, BB 2 — so the button acts first preflop three-handed.
    expect(startHand(config()).actingSeat).toBe(0);
  });

  it('starts with the button heads-up', () => {
    // Heads-up the button is the small blind and acts first preflop.
    const s = startHand(config({ players: players(2), buttonSeat: 0 }));
    expect(s.actingSeat).toBe(0);
  });

  it('leaves nobody to act if the blinds put everyone all-in', () => {
    const s = startHand(
      config({
        players: [
          { seat: 0, playerId: 'p0', stack: SB },
          { seat: 1, playerId: 'p1', stack: BB },
        ],
        buttonSeat: 0,
      }),
    );
    expect(activeSeats(s)).toHaveLength(0);
    expect(s.actingSeat).toBeNull();
  });
});

describe('hole card dealing', () => {
  it('deals one card at a time from the small blind, two passes', () => {
    // This ordering is part of the verification contract: a verifier reconstructs
    // the deck from the revealed seed and must arrive at these exact hole cards.
    // Button 0, SB 1, BB 2 -> deal order is seats 1, 2, 0 then 1, 2, 0.
    // Deck is FULL_DECK unshuffled: 2c 2d 2h 2s 3c 3d ...
    const s = startHand(config());
    expect(cardsToString(seatAt(s, 1).holeCards!)).toBe('2c 2s');
    expect(cardsToString(seatAt(s, 2).holeCards!)).toBe('2d 3c');
    expect(cardsToString(seatAt(s, 0).holeCards!)).toBe('2h 3d');
  });

  it('consumes exactly two cards per player', () => {
    expect(startHand(config({ players: players(6) })).deckIndex).toBe(12);
  });

  it('gives every player two distinct cards', () => {
    const s = startHand(config({ players: players(9) }));
    const dealt = s.seats.flatMap((seat) => seat.holeCards!);
    expect(dealt).toHaveLength(18);
    expect(new Set(dealt).size).toBe(18);
  });

  it('never mutates the deck it was given', () => {
    const deck = parseCards('AsKsQsJsTs9s8s7s6s5s4s3s2s');
    const before = [...deck];
    startHand(config({ players: players(2), deck }));
    expect(deck).toEqual(before);
  });
});

describe('antes', () => {
  it('adds antes to the pot without counting them as a street bet', () => {
    // Paying an ante must not count toward matching a later bet, but it must
    // still show up in the pot — the easy bug here is losing it entirely.
    const s = startHand(config({ ante: 10 }));
    expect(s.pot).toBe(30);
    expect(seatAt(s, 0).committedThisStreet).toBe(0);
    expect(seatAt(s, 0).committedTotal).toBe(10);
    expect(seatAt(s, 0).stack).toBe(10_000 - 10);
  });

  it('counts antes, blinds and stacks to the original total', () => {
    const s = startHand(config({ ante: 10 }));
    const chipsOnTable = s.seats.reduce((sum, seat) => sum + seat.stack, 0);
    expect(chipsOnTable + totalPot(s)).toBe(3 * 10_000);
  });
});

describe('chip conservation at deal time', () => {
  it.each([2, 3, 6, 9])('conserves chips %i-handed', (n) => {
    const s = startHand(config({ players: players(n) }));
    const chipsOnTable = s.seats.reduce((sum, seat) => sum + seat.stack, 0);
    expect(chipsOnTable + totalPot(s)).toBe(n * 10_000);
  });
});

describe('nextSeatWhere', () => {
  const s = startHand(config({ players: players(4) }));

  it('wraps around the table', () => {
    expect(nextSeatWhere(s.seats, 3, () => true)?.seat).toBe(0);
  });

  it('never returns the seat it started from', () => {
    expect(nextSeatWhere(s.seats, 2, (x) => x.seat === 2)).toBeNull();
  });

  it('skips seats failing the predicate', () => {
    expect(nextSeatWhere(s.seats, 0, (x) => x.seat % 2 === 0)?.seat).toBe(2);
  });
});

describe('seat queries', () => {
  it('reports every seat as active and live at the deal', () => {
    const s = startHand(config({ players: players(5) }));
    expect(activeSeats(s)).toHaveLength(5);
    expect(liveSeats(s)).toHaveLength(5);
  });

  it('throws for a seat that is not in the hand', () => {
    expect(() => seatAt(startHand(config()), 7)).toThrow(/No seat 7/);
  });
});

describe('config validation', () => {
  it.each([
    [{ players: players(1) }, /at least 2 players/],
    [{ players: [players(1)[0]!, players(1)[0]!] }, /Duplicate seat/],
    [{ buttonSeat: 9 }, /Button seat 9 is not occupied/],
    [{ smallBlind: 0 }, /Invalid blinds/],
    [{ smallBlind: 200, bigBlind: 100 }, /Invalid blinds/],
    [{ deck: parseCards('AsKsQs') }, /need at least/],
  ])('rejects invalid config %#', (overrides, message) => {
    expect(() => startHand(config(overrides))).toThrow(message);
  });

  it('rejects a non-integer stack', () => {
    const bad = [
      { seat: 0, playerId: 'p0', stack: 10.5 },
      { seat: 1, playerId: 'p1', stack: 10_000 },
    ];
    expect(() => startHand(config({ players: bad }))).toThrow(/non-integer stack/);
  });

  it('rejects duplicate player IDs across seats', () => {
    const dupe = [
      { seat: 0, playerId: 'same', stack: 10_000 },
      { seat: 1, playerId: 'same', stack: 10_000 },
    ];
    expect(() => startHand(config({ players: dupe }))).toThrow(/Duplicate player ID/);
  });
});
