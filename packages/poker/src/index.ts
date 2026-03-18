/**
 * `@clawroll/poker` — pure No-Limit Hold'em logic.
 *
 * Everything in this package is a pure function over plain data: no clock, no
 * network, no database, no ambient randomness. Randomness enters only as an
 * already-shuffled deck passed in by the caller.
 *
 * That constraint is what makes a hand a *replayable value*. Given the same deck
 * and the same ordered list of actions, a hand must produce bit-identical
 * output — which is what gives Clawroll free replay, free audit, free spectator
 * rewind, and game-logic tests that need no infrastructure and never flake.
 */
export * from './cards.js';
export * from './evaluator.js';
