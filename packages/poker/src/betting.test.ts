import { describe, expect, it } from 'vitest';
import { FULL_DECK } from './cards.js';
import { type Action, applyAction, legalActions } from './betting.js';
import {
  type HandConfig,
  type HandPlayer,
  type HandState,
  seatAt,
  startHand,
  totalPot,
} from './handState.js';

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

/** Apply a sequence of actions, asserting each is legal at the time it is played. */
function play(state: HandState, actions: readonly Omit<Action, 'seat'>[]): HandState {
  let current = state;
  for (const [i, a] of actions.entries()) {
    if (current.actingSeat === null) {
      throw new Error(`Action #${i} (${a.type}): nobody is to act (street ${current.street})`);
    }
    current = applyAction(current, { ...a, seat: current.actingSeat }).state;
  }
  return current;
}

const startingChips = (s: HandState) => s.seats.reduce((sum, x) => sum + x.stack, 0) + totalPot(s);

describe('legal actions', () => {
  it('offers the big blind its option to raise preflop', () => {
    // Button 0 / SB 1 / BB 2. After the button and SB call, the BB has already
    // matched betToCall and is not "facing a bet" — but must still be able to raise.
    const s = play(startHand(config()), [{ type: 'call' }, { type: 'call' }]);
    expect(s.actingSeat).toBe(2);

    const legal = legalActions(s)!;
    expect(legal.canCheck).toBe(true);
    expect(legal.canCall).toBe(false);
    expect(legal.canRaise).toBe(true);
    expect(legal.minRaiseTo).toBe(2 * BB);
  });

  it('requires the first raise to be to two big blinds', () => {
    expect(legalActions(startHand(config()))!.minRaiseTo).toBe(2 * BB);
  });

  it('reports the call amount net of what is already committed', () => {
    // The small blind has 50 in already, so calling a 100 bet costs 50 more.
    const s = play(startHand(config()), [{ type: 'call' }]);
    expect(s.actingSeat).toBe(1);
    expect(legalActions(s)!.callAmount).toBe(SB);
  });

  it('lets a short stack shove below the normal minimum raise', () => {
    const short = [
      { seat: 0, playerId: 'p0', stack: 130 },
      { seat: 1, playerId: 'p1', stack: 10_000 },
      { seat: 2, playerId: 'p2', stack: 10_000 },
    ];
    const legal = legalActions(startHand(config({ players: short })))!;
    expect(legal.maxRaiseTo).toBe(130);
    // A full raise would be 200, which the seat cannot reach — so the minimum is
    // clamped to its stack and shoving stays legal.
    expect(legal.minRaiseTo).toBe(130);
    expect(legal.canRaise).toBe(true);
  });

  it('offers a bet but not a raise on a fresh street', () => {
    const s = play(startHand(config()), [{ type: 'call' }, { type: 'call' }, { type: 'check' }]);
    expect(s.street).toBe('flop');
    const legal = legalActions(s)!;
    expect(legal.canBet).toBe(true);
    expect(legal.canRaise).toBe(false);
    expect(legal.canCheck).toBe(true);
    expect(legal.minRaiseTo).toBe(BB);
  });
});

describe('street progression', () => {
  it('advances preflop to flop once the big blind checks its option', () => {
    const s = play(startHand(config()), [{ type: 'call' }, { type: 'call' }, { type: 'check' }]);
    expect(s.street).toBe('flop');
    expect(s.board).toHaveLength(3);
    expect(s.pot).toBe(3 * BB);
  });

  it('burns one card before the flop, turn and river', () => {
    // 3 players => 6 hole cards. Flop burns 1 and deals 3 => index 10.
    // Turn burns 1 deals 1 => 12. River burns 1 deals 1 => 14.
    let s = play(startHand(config()), [{ type: 'call' }, { type: 'call' }, { type: 'check' }]);
    expect(s.deckIndex).toBe(10);
    s = play(s, [{ type: 'check' }, { type: 'check' }, { type: 'check' }]);
    expect(s.street).toBe('turn');
    expect(s.deckIndex).toBe(12);
    s = play(s, [{ type: 'check' }, { type: 'check' }, { type: 'check' }]);
    expect(s.street).toBe('river');
    expect(s.deckIndex).toBe(14);
    expect(s.board).toHaveLength(5);
  });

  it('starts postflop action left of the button', () => {
    const s = play(startHand(config()), [{ type: 'call' }, { type: 'call' }, { type: 'check' }]);
    expect(s.actingSeat).toBe(1);
  });

  it('gives the big blind first action postflop when heads-up', () => {
    // Heads-up the button acts first preflop and last on every later street.
    const s = play(startHand(config({ players: players(2) })), [
      { type: 'call' },
      { type: 'check' },
    ]);
    expect(s.street).toBe('flop');
    expect(s.actingSeat).toBe(1);
  });

  it('resets the bet and clears street commitments on a new street', () => {
    const s = play(startHand(config()), [{ type: 'call' }, { type: 'call' }, { type: 'check' }]);
    expect(s.betToCall).toBe(0);
    expect(s.seats.every((x) => x.committedThisStreet === 0)).toBe(true);
    expect(s.seats.every((x) => !x.hasActedThisStreet)).toBe(true);
  });

  it('reaches showdown after the river betting completes', () => {
    let s = play(startHand(config()), [{ type: 'call' }, { type: 'call' }, { type: 'check' }]);
    for (let i = 0; i < 3; i++) s = play(s, [{ type: 'check' }, { type: 'check' }, { type: 'check' }]);
    expect(s.street).toBe('showdown');
    expect(s.actingSeat).toBeNull();
  });
});

describe('folding', () => {
  it('ends the hand when everyone folds to one player', () => {
    const s = play(startHand(config()), [{ type: 'fold' }, { type: 'fold' }]);
    expect(s.street).toBe('complete');
    expect(s.actingSeat).toBeNull();
    expect(s.pot).toBe(SB + BB);
  });

  it('skips folded seats when passing the action', () => {
    const s = play(startHand(config({ players: players(4) })), [{ type: 'fold' }]);
    expect(s.actingSeat).toBe(0);
  });
});

describe('an all-in short of a full raise does not reopen the betting', () => {
  // The rule: a raise smaller than the previous increment (only possible all-in)
  // lets players who already acted call or fold, but not re-raise. Players who
  // have not yet acted keep their full options.
  const shortStack = [
    { seat: 0, playerId: 'btn', stack: 10_000 },
    { seat: 1, playerId: 'sb', stack: 10_000 },
    { seat: 2, playerId: 'bb', stack: 10_000 },
    { seat: 3, playerId: 'short', stack: 460 },
  ];

  it('denies a raise to a player who already acted', () => {
    let s = startHand(config({ players: shortStack, buttonSeat: 0 }));
    // Seat 3 is UTG and first to act; get past it so seat 0 can open.
    s = play(s, [{ type: 'call' }]); // seat 3 calls 100
    s = play(s, [{ type: 'raise', amount: 400 }]); // seat 0 raises to 400 (increment 300)
    s = play(s, [{ type: 'call' }, { type: 'call' }]); // seats 1 and 2 call

    // Seat 3 shoves its last 460 — an increment of only 60 against a required 300.
    expect(s.actingSeat).toBe(3);
    s = play(s, [{ type: 'raise', amount: 460 }]);

    expect(seatAt(s, 3).status).toBe('allin');
    expect(s.betToCall).toBe(460);
    // The increment stays at the last FULL raise, not the short shove.
    expect(s.lastRaiseIncrement).toBe(300);

    // Seat 0 already acted, so it may only call or fold.
    expect(s.actingSeat).toBe(0);
    const legal = legalActions(s)!;
    expect(legal.canCall).toBe(true);
    expect(legal.canRaise).toBe(false);
    expect(legal.callAmount).toBe(60);
    expect(() => applyAction(s, { type: 'raise', seat: 0, amount: 1000 })).toThrow(/cannot raise/);
  });

  it('reopens the betting after a full raise', () => {
    let s = startHand(config({ players: players(4) }));
    s = play(s, [{ type: 'call' }, { type: 'raise', amount: 400 }]);
    // Seat 1 already acted via the blind but a full raise clears that.
    s = play(s, [{ type: 'raise', amount: 1200 }]);
    expect(s.lastRaiseIncrement).toBe(800);
    expect(legalActions(s)!.canRaise).toBe(true);
  });
});

describe('all-in run-outs', () => {
  it('deals the remaining board when everyone is all-in', () => {
    const s = play(startHand(config({ players: players(2, 1_000) })), [
      { type: 'raise', amount: 1_000 },
      { type: 'call' },
    ]);
    expect(s.street).toBe('showdown');
    expect(s.board).toHaveLength(5);
    expect(s.seats.every((x) => x.status === 'allin')).toBe(true);
    expect(s.actingSeat).toBeNull();
  });

  it('keeps betting alive when one player still has chips behind', () => {
    const stacks = [
      { seat: 0, playerId: 'p0', stack: 10_000 },
      { seat: 1, playerId: 'p1', stack: 10_000 },
      { seat: 2, playerId: 'p2', stack: 600 },
    ];
    let s = startHand(config({ players: stacks }));
    s = play(s, [{ type: 'call' }, { type: 'call' }, { type: 'raise', amount: 600 }]);
    s = play(s, [{ type: 'call' }, { type: 'call' }]);
    // Seat 2 is all-in but seats 0 and 1 still have chips, so the flop is dealt
    // and they keep betting.
    expect(s.street).toBe('flop');
    expect(s.actingSeat).toBe(1);
  });
});

describe('illegal actions throw', () => {
  // An agent sending an illegal action has a bug. Silently reinterpreting it would
  // hide that bug while corrupting the hand, so every one of these must throw.
  const fresh = () => startHand(config());

  it('rejects acting out of turn', () => {
    expect(() => applyAction(fresh(), { type: 'call', seat: 2 })).toThrow(/Out of turn/);
  });

  it('rejects checking when facing a bet', () => {
    expect(() => applyAction(fresh(), { type: 'check', seat: 0 })).toThrow(/cannot check/);
  });

  it('rejects a raise below the minimum', () => {
    expect(() => applyAction(fresh(), { type: 'raise', seat: 0, amount: 150 })).toThrow(
      /outside the legal range/,
    );
  });

  it('rejects a raise above the seat stack', () => {
    expect(() => applyAction(fresh(), { type: 'raise', seat: 0, amount: 99_999 })).toThrow(
      /outside the legal range/,
    );
  });

  it('rejects a non-integer raise', () => {
    expect(() => applyAction(fresh(), { type: 'raise', seat: 0, amount: 250.5 })).toThrow(
      /must be an integer/,
    );
  });

  it('rejects a raise with no amount', () => {
    expect(() => applyAction(fresh(), { type: 'raise', seat: 0 })).toThrow(/needs an amount/);
  });

  it('rejects acting after the hand is over', () => {
    const done = play(fresh(), [{ type: 'fold' }, { type: 'fold' }]);
    expect(() => applyAction(done, { type: 'call', seat: 0 })).toThrow(/already over/);
  });

  it('rejects a bet when there is already a bet to face', () => {
    expect(() => applyAction(fresh(), { type: 'bet', seat: 0, amount: 500 })).toThrow(/cannot bet/);
  });
});

describe('immutability and conservation', () => {
  it('never mutates the state it was given', () => {
    const before = startHand(config());
    const snapshot = JSON.stringify(before);
    applyAction(before, { type: 'call', seat: 0 });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('conserves chips through every action of a hand', () => {
    let s = startHand(config({ players: players(4) }));
    const total = startingChips(s);

    const script: Omit<Action, 'seat'>[] = [
      { type: 'call' },
      { type: 'raise', amount: 300 },
      { type: 'call' },
      { type: 'call' },
      { type: 'call' },
      { type: 'check' },
      { type: 'bet', amount: 250 },
      { type: 'call' },
      { type: 'fold' },
      { type: 'fold' },
    ];

    for (const action of script) {
      s = applyAction(s, { ...action, seat: s.actingSeat! }).state;
      expect(startingChips(s)).toBe(total);
    }
  });
});

describe('events', () => {
  it('reports the chips actually moved by each action', () => {
    const s = startHand(config());
    const { events } = applyAction(s, { type: 'raise', seat: 0, amount: 300 });
    expect(events[0]).toEqual({ type: 'action', seat: 0, action: 'raise', amount: 300 });
  });

  it('reports street transitions with the new board', () => {
    let s = play(startHand(config()), [{ type: 'call' }, { type: 'call' }]);
    const { events } = applyAction(s, { type: 'check', seat: s.actingSeat! });
    const street = events.find((e) => e.type === 'street');
    expect(street).toMatchObject({ type: 'street', street: 'flop' });
  });

  it('reports a fold-out as complete without a showdown', () => {
    let s = applyAction(startHand(config()), { type: 'fold', seat: 0 }).state;
    const { events } = applyAction(s, { type: 'fold', seat: 1 });
    expect(events).toContainEqual({ type: 'hand_complete', reason: 'fold' });
  });
});
