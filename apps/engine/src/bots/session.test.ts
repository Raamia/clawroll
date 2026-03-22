import { describe, expect, it } from 'vitest';
import { handStrength, callingStation, randomBot, tightAggressive } from './agent.js';
import { runSession } from './session.js';

describe('hand strength heuristic', () => {
  it('rates a made hand above an unmade one', () => {
    const quads = handStrength('AsAd', 'AhAc2s');
    const nothing = handStrength('7s2d', 'AhKc9s');
    expect(quads).toBeGreaterThan(nothing);
  });

  it('rates a preflop pair above unconnected low cards', () => {
    expect(handStrength('AsAd', '')).toBeGreaterThan(handStrength('7s2d', ''));
  });

  it('rewards suitedness and connectedness', () => {
    expect(handStrength('9s8s', '')).toBeGreaterThan(handStrength('9s4d', ''));
  });

  it('returns zero before any cards are dealt', () => {
    expect(handStrength('', '')).toBe(0);
  });

  it('stays within 0..1', () => {
    for (const [hole, board] of [
      ['AsAd', 'AhAc2s'],
      ['7s2d', ''],
      ['AsKs', 'QsJsTs'],
    ] as const) {
      const value = handStrength(hole, board);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('strategies produce a legal-looking decision', () => {
  const request = {
    type: 'action_request' as const,
    handId: 'h1',
    requestId: 'r1',
    seat: 0,
    street: 'flop' as const,
    board: '2h 5s 9c',
    pot: 300,
    betToCall: 0,
    legal: {
      canFold: false,
      canCheck: true,
      canCall: false,
      callAmount: 0,
      canBet: true,
      canRaise: false,
      minRaiseTo: 100,
      maxRaiseTo: 5_000,
    },
    deadline: 0,
  };

  it.each([
    ['calling-station', callingStation],
    ['tight-aggressive', tightAggressive],
    ['random', randomBot(1)],
  ])('%s never bets outside the legal range', (_name, strategy) => {
    for (let i = 0; i < 200; i++) {
      const decision = strategy.decide(request, { holeCards: 'AsAd', board: request.board });
      if (decision.amount !== undefined) {
        expect(decision.amount).toBeGreaterThanOrEqual(request.legal.minRaiseTo);
        expect(decision.amount).toBeLessThanOrEqual(request.legal.maxRaiseTo);
      }
      expect(['fold', 'check', 'call', 'bet', 'raise']).toContain(decision.action);
    }
  });

  it('never folds when checking is free', () => {
    for (const strategy of [callingStation, tightAggressive, randomBot(3)]) {
      const decision = strategy.decide(request, { holeCards: '7s2d', board: request.board });
      expect(decision.action).not.toBe('fold');
    }
  });
});

describe('a full session over real sockets', () => {
  // The end-to-end proof for M3: real server, real WebSockets, real bots, real hands.
  // Everything below this has already been tested in isolation; this asserts the pieces
  // actually work together.
  it(
    'plays hands that all verify and conserves every chip',
    async () => {
      const result = await runSession(25);

      expect(result.handsPlayed).toBeGreaterThanOrEqual(25);

      // Every hand verifiable from the public feed alone. Not "most" — all.
      expect(result.failedHands).toEqual([]);
      expect(result.verifiedHands).toBe(result.handsPlayed);

      // Chips in equals chips accounted for, counted by the engine rather than the bots.
      expect(result.chipsAtEnd).toBe(result.chipsAtStart);

      // A clean run means no agent hit an error. This is what catches regressions in the
      // protocol contract: an agent written against the docs must never see one.
      expect(result.botErrors).toEqual([]);
    },
    { timeout: 60_000 },
  );
});
