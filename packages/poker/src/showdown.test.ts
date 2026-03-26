import { describe, expect, it } from 'vitest';
import { type Card, DECK_SIZE, FULL_DECK, parseCards } from './cards.js';
import { type Action, applyAction, legalActions } from './betting.js';
import {
  type HandConfig,
  type HandPlayer,
  type HandState,
  type SeatState,
  startHand,
  totalPot,
} from './handState.js';
import {
  assertChipsConserved,
  derivePots,
  potTotal,
  rakeFor,
  settleHand,
  standardRake,
} from './showdown.js';

const BB = 100;
const SB = 50;

function players(count: number, stack = 10_000): HandPlayer[] {
  return Array.from({ length: count }, (_, i) => ({ seat: i, playerId: `p${i}`, stack }));
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

/** Minimal seat fixture for testing pot derivation in isolation. */
function seat(n: number, committedTotal: number, status: SeatState['status'] = 'active'): SeatState {
  return {
    seat: n,
    playerId: `p${n}`,
    stack: 0,
    committedThisStreet: 0,
    committedTotal,
    holeCards: null,
    status,
    hasActedThisStreet: true,
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(rng: () => number): Card[] {
  const deck = [...FULL_DECK];
  for (let i = DECK_SIZE - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck;
}

describe('pot derivation', () => {
  it('produces a single pot when nobody is all-in', () => {
    // Merging matters here: without it, every distinct contribution amount would
    // report as its own pot even with no all-in anywhere.
    const pots = derivePots([seat(0, 500), seat(1, 500), seat(2, 500)]);
    expect(pots).toHaveLength(1);
    expect(pots[0]).toEqual({ amount: 1500, eligibleSeats: [0, 1, 2] });
  });

  it('slices contribution tiers into main and side pots', () => {
    //   A all-in 200, B all-in 500, C 1000
    //   main   200×3 = 600  -> A, B, C
    //   side 1 300×2 = 600  -> B, C
    //   side 2 500×1 = 500  -> C
    const pots = derivePots([seat(0, 200), seat(1, 500), seat(2, 1000)]);
    expect(pots).toEqual([
      { amount: 600, eligibleSeats: [0, 1, 2] },
      { amount: 600, eligibleSeats: [1, 2] },
      { amount: 500, eligibleSeats: [2] },
    ]);
  });

  it('keeps a folded player’s chips but drops their eligibility', () => {
    const pots = derivePots([seat(0, 300, 'folded'), seat(1, 1000), seat(2, 1000)]);
    expect(potTotal(pots)).toBe(2300);
    expect(pots[0]!.eligibleSeats).toEqual([1, 2]);
  });

  it('handles a player who folded having contributed more than a live player', () => {
    // Seat 0 bet 800 then folded to a raise; seat 1 is all-in for only 400.
    const pots = derivePots([seat(0, 800, 'folded'), seat(1, 400), seat(2, 800)]);
    expect(potTotal(pots)).toBe(2000);
    expect(pots[0]).toEqual({ amount: 1200, eligibleSeats: [1, 2] });
    expect(pots[1]).toEqual({ amount: 800, eligibleSeats: [2] });
  });

  it('returns no pots when nothing was contributed', () => {
    expect(derivePots([seat(0, 0), seat(1, 0)])).toEqual([]);
  });

  it('is independent of the order bets arrived in', () => {
    // The whole point of deriving rather than accumulating: any betting sequence
    // producing these contributions must produce these pots.
    const a = derivePots([seat(0, 200), seat(1, 500), seat(2, 1000)]);
    const b = derivePots([seat(2, 1000), seat(0, 200), seat(1, 500)]);
    expect(a).toEqual(b);
  });
});

describe('showdown resolution', () => {
  function twoHanded(holeA: string, holeB: string, board: string, committed = 1000): HandState {
    const base = startHand(config({ players: players(2) }));
    return {
      ...base,
      street: 'showdown',
      board: parseCards(board),
      actingSeat: null,
      pot: committed * 2,
      seats: [
        { ...base.seats[0]!, holeCards: parseCards(holeA) as [Card, Card], committedTotal: committed, committedThisStreet: 0, stack: 0 },
        { ...base.seats[1]!, holeCards: parseCards(holeB) as [Card, Card], committedTotal: committed, committedThisStreet: 0, stack: 0 },
      ],
    };
  }

  it('awards the pot to the better hand', () => {
    const result = settleHand(twoHanded('AcAd', 'KcKd', '2h5s9c JdTh'));
    expect(result.awards).toEqual([{ seat: 0, amount: 2000, potIndex: 0 }]);
    expect(result.seats[0]!.stack).toBe(2000);
    expect(result.seats[1]!.stack).toBe(0);
  });

  it('chops evenly when the board plays', () => {
    // Both players play the board: identical hands, exact tie.
    const result = settleHand(twoHanded('2c3d', '2d3h', 'AsKsQsJsTs'));
    expect(result.awards).toHaveLength(2);
    expect(result.seats[0]!.stack).toBe(1000);
    expect(result.seats[1]!.stack).toBe(1000);
  });

  it('gives an odd chip to the first seat left of the button', () => {
    // Button is seat 0, so seat 1 is first to its left and takes the extra chip.
    const result = settleHand(twoHanded('2c3d', '2d3h', 'AsKsQsJsTs', 501));
    expect(result.seats[1]!.stack).toBe(501);
    expect(result.seats[0]!.stack).toBe(501);
    expect(potTotal(result.pots)).toBe(1002);
  });

  it('never reveals hands when everyone folds', () => {
    const folded = applyAction(
      applyAction(startHand(config()), { type: 'fold', seat: 0 }).state,
      { type: 'fold', seat: 1 },
    ).state;

    const result = settleHand(folded);
    expect(result.hands.size).toBe(0);
    expect(result.awards).toEqual([{ seat: 2, amount: SB + BB, potIndex: 0 }]);
  });

  it('refunds an uncalled bet rather than awarding it at showdown', () => {
    // Seat 2 is all-in for 400; seat 0 has 1000 in. The uncontested 600 comes back
    // to seat 0 regardless of who wins the main pot.
    const base = startHand(config());
    const state: HandState = {
      ...base,
      street: 'showdown',
      board: parseCards('2h5s9cJdTh'),
      actingSeat: null,
      seats: [
        { ...base.seats[0]!, holeCards: parseCards('3c4d') as [Card, Card], committedTotal: 1000, committedThisStreet: 0, stack: 0 },
        { ...base.seats[1]!, status: 'folded', committedTotal: 0, committedThisStreet: 0, stack: 0 },
        { ...base.seats[2]!, holeCards: parseCards('AcAd') as [Card, Card], committedTotal: 400, committedThisStreet: 0, stack: 0 },
      ],
      pot: 1400,
    };

    const result = settleHand(state);
    expect(result.pots).toEqual([
      { amount: 800, eligibleSeats: [0, 2] },
      { amount: 600, eligibleSeats: [0] },
    ]);
    // Seat 2 wins the main pot with aces; seat 0 gets its uncalled 600 back.
    expect(result.seats[2]!.stack).toBe(800);
    expect(result.seats[0]!.stack).toBe(600);
  });

  it('refuses to settle an unfinished hand', () => {
    expect(() => settleHand(startHand(config()))).toThrow(/is not finished/);
  });

  it('throws rather than silently dropping a pot with no eligible winner', () => {
    // Defence in depth for the fuzz-found chip leak. `legalActions` now makes this
    // unreachable by refusing a fold that is not facing a bet, but if that guard
    // ever regresses the chips must vanish loudly rather than quietly.
    const base = startHand(config());
    const orphaned: HandState = {
      ...base,
      street: 'showdown',
      board: parseCards('2h5s9cJdTh'),
      actingSeat: null,
      seats: [
        { ...base.seats[0]!, status: 'folded', committedTotal: 978, committedThisStreet: 0, stack: 0 },
        { ...base.seats[1]!, status: 'folded', committedTotal: 978, committedThisStreet: 0, stack: 0 },
        { ...base.seats[2]!, status: 'allin', committedTotal: 223, committedThisStreet: 0, stack: 0 },
      ],
      pot: 2179,
    };

    expect(derivePots(orphaned.seats)[1]!.eligibleSeats).toEqual([]);
    expect(() => settleHand(orphaned)).toThrow(/has no eligible winner/);
  });
});

describe('three-way all-in for different amounts', () => {
  it('resolves each pot independently against its own eligible field', () => {
    const base = startHand(config({ players: players(3) }));
    // Seat 0 (short, 200) has the best hand and can only win the main pot.
    // Seat 1 (500) has the second best and takes side pot 1.
    // Seat 2 (1000) has the worst but gets its uncalled remainder back.
    const state: HandState = {
      ...base,
      street: 'showdown',
      board: parseCards('2h5s9cJdTh'),
      actingSeat: null,
      seats: [
        { ...base.seats[0]!, holeCards: parseCards('AcAd') as [Card, Card], committedTotal: 200, committedThisStreet: 0, stack: 0, status: 'allin' },
        { ...base.seats[1]!, holeCards: parseCards('KcKd') as [Card, Card], committedTotal: 500, committedThisStreet: 0, stack: 0, status: 'allin' },
        { ...base.seats[2]!, holeCards: parseCards('3c4d') as [Card, Card], committedTotal: 1000, committedThisStreet: 0, stack: 0 },
      ],
      pot: 1700,
    };

    const result = settleHand(state);
    expect(result.pots).toEqual([
      { amount: 600, eligibleSeats: [0, 1, 2] },
      { amount: 600, eligibleSeats: [1, 2] },
      { amount: 500, eligibleSeats: [2] },
    ]);
    expect(result.seats[0]!.stack).toBe(600);
    expect(result.seats[1]!.stack).toBe(600);
    expect(result.seats[2]!.stack).toBe(500);
    expect(potTotal(result.pots)).toBe(1700);
  });
});

describe('rake', () => {
  function finishedHand(board: string, committed = 1_000_000): HandState {
    const base = startHand(config({ players: players(2) }));
    return {
      ...base,
      street: 'showdown',
      board: board ? parseCards(board) : [],
      actingSeat: null,
      pot: committed * 2,
      seats: [
        { ...base.seats[0]!, holeCards: parseCards('AcAd') as [Card, Card], committedTotal: committed, committedThisStreet: 0, stack: 0 },
        { ...base.seats[1]!, holeCards: parseCards('KcKd') as [Card, Card], committedTotal: committed, committedThisStreet: 0, stack: 0 },
      ],
    };
  }

  it('takes nothing when no policy is configured', () => {
    const result = settleHand(finishedHand('2h5s9cJdTh'));
    expect(result.rakeMicros).toBe(0);
    expect(result.seats[0]!.stack).toBe(2_000_000);
  });

  it('takes the configured percentage', () => {
    const result = settleHand(finishedHand('2h5s9cJdTh', 100_000), {
      percentage: 0.05,
      capMicros: 1_000_000_000,
      noFlopNoDrop: true,
    });
    // 5% of a 200,000 pot.
    expect(result.rakeMicros).toBe(10_000);
    expect(result.seats[0]!.stack).toBe(190_000);
  });

  it('never exceeds the cap', () => {
    // Without a cap a single large all-in pot takes an absurd amount and the game stops
    // being worth playing.
    const policy = standardRake(100_000); // cap = 300,000
    const result = settleHand(finishedHand('2h5s9cJdTh', 50_000_000), policy);
    expect(result.rakeMicros).toBe(300_000);
  });

  it('takes nothing when the hand ended before a flop', () => {
    // No flop, no drop. Raking every walk bleeds a table dry without a hand being played.
    const result = settleHand(finishedHand(''), standardRake(100_000));
    expect(result.rakeMicros).toBe(0);
  });

  it('rounds down rather than up', () => {
    // A rake that exceeds its own stated percentage is the kind of thing players notice.
    const state = finishedHand('2h5s9cJdTh', 33);
    expect(rakeFor(state, { percentage: 0.05, capMicros: 1_000_000, noFlopNoDrop: true })).toBe(3);
  });

  it('conserves chips once the rake is counted', () => {
    // The rake leaves the table but does not vanish — it moves to the house.
    const state = finishedHand('2h5s9cJdTh', 1_000_000);
    const result = settleHand(state, standardRake(100_000));
    expect(result.rakeMicros).toBeGreaterThan(0);
    expect(() => assertChipsConserved(state, result)).not.toThrow();

    const paidOut = result.seats.reduce((sum, s) => sum + s.stack, 0);
    expect(paidOut + result.rakeMicros).toBe(2_000_000);
  });

  it('drains the main pot before any side pot', () => {
    // Not proportionally: that can take chips from a side pot the raked players were never
    // eligible for.
    const base = startHand(config({ players: players(3) }));
    const state: HandState = {
      ...base,
      street: 'showdown',
      board: parseCards('2h5s9cJdTh'),
      actingSeat: null,
      pot: 1_700_000,
      seats: [
        { ...base.seats[0]!, holeCards: parseCards('AcAd') as [Card, Card], committedTotal: 200_000, committedThisStreet: 0, stack: 0, status: 'allin' },
        { ...base.seats[1]!, holeCards: parseCards('KcKd') as [Card, Card], committedTotal: 500_000, committedThisStreet: 0, stack: 0, status: 'allin' },
        { ...base.seats[2]!, holeCards: parseCards('3c4d') as [Card, Card], committedTotal: 1_000_000, committedThisStreet: 0, stack: 0 },
      ],
    };

    const result = settleHand(state, { percentage: 0.05, capMicros: 1_000_000, noFlopNoDrop: true });
    expect(result.rakeMicros).toBe(85_000); // 5% of 1,700,000
    // Main pot was 600,000; the whole rake comes out of it.
    expect(result.pots[0]!.amount).toBe(600_000 - 85_000);
    expect(result.pots[1]!.amount).toBe(600_000);
    expect(potTotal(result.pots) + result.rakeMicros).toBe(1_700_000);
    expect(() => assertChipsConserved(state, result)).not.toThrow();
  });
});

describe('random hands conserve chips end to end', () => {
  /** Pick a uniformly random legal action for whoever is to act. */
  function randomAction(state: HandState, rng: () => number): Action {
    const legal = legalActions(state)!;
    const options: Action[] = [];
    const seat = legal.seat;

    if (legal.canFold) options.push({ type: 'fold', seat });
    if (legal.canCheck) options.push({ type: 'check', seat });
    if (legal.canCall) options.push({ type: 'call', seat });

    if (legal.canBet || legal.canRaise) {
      const type = legal.canBet ? 'bet' : 'raise';
      const span = legal.maxRaiseTo - legal.minRaiseTo;
      const amount = legal.minRaiseTo + Math.floor(rng() * (span + 1));
      options.push({ type, seat, amount });
      // Weight shoving up so all-in side pots occur often.
      options.push({ type, seat, amount: legal.maxRaiseTo });
    }

    return options[Math.floor(rng() * options.length)]!;
  }

  it('plays 5000 random hands without creating or destroying a chip', () => {
    // The headline invariant for the whole package. Random stacks make uneven
    // all-ins — and therefore side pots and odd chips — extremely common.
    const rng = mulberry32(0xdecaf);
    let handsWithSidePots = 0;
    let handsToShowdown = 0;

    for (let hand = 0; hand < 5000; hand++) {
      const seatCount = 2 + Math.floor(rng() * 8);
      const roster = Array.from({ length: seatCount }, (_, i) => ({
        seat: i,
        playerId: `p${i}`,
        stack: BB + Math.floor(rng() * 3000),
      }));

      let state = startHand({
        handId: `h${hand}`,
        buttonSeat: Math.floor(rng() * seatCount),
        smallBlind: SB,
        bigBlind: BB,
        players: roster,
        deck: shuffled(rng),
      });

      const startingChips = state.seats.reduce((sum, s) => sum + s.stack, 0) + totalPot(state);

      let guard = 0;
      while (state.actingSeat !== null) {
        state = applyAction(state, randomAction(state, rng)).state;
        if (++guard > 500) throw new Error(`Hand ${hand} did not terminate`);
      }

      const result = settleHand(state);
      assertChipsConserved(state, result);

      const finalChips = result.seats.reduce((sum, s) => sum + s.stack, 0);
      expect(finalChips, `hand ${hand}`).toBe(startingChips);
      expect(potTotal(result.pots), `hand ${hand} pots`).toBe(totalPot(state));

      if (result.pots.length > 1) handsWithSidePots++;
      if (state.street === 'showdown') handsToShowdown++;
    }

    // Guard against the fuzzer degenerating into hands that end preflop — the
    // conservation result would then be far weaker than it looks.
    expect(handsWithSidePots).toBeGreaterThan(500);
    expect(handsToShowdown).toBeGreaterThan(500);
  });

  it('always terminates', () => {
    // Every sequence of legal actions must reach a state where nobody can act.
    const rng = mulberry32(0x7e12);
    for (let hand = 0; hand < 500; hand++) {
      let state = startHand(config({ players: players(6, 2000), deck: shuffled(rng) }));
      let steps = 0;
      while (state.actingSeat !== null) {
        state = applyAction(state, randomAction(state, rng)).state;
        expect(++steps, `hand ${hand}`).toBeLessThan(500);
      }
      expect(['showdown', 'complete']).toContain(state.street);
    }
  });
});
