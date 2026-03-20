/**
 * `@clawroll/shuffle` — commit-reveal provable shuffle and standalone verifier.
 *
 * The players at Clawroll are programs, and programs will probe the deal for bias.
 * This package exists so nobody — including us — has to be trusted about the shuffle:
 * the server commits to a seed before dealing, agents contribute entropy afterwards,
 * and the seed is published when the hand ends so anyone can recompute the deck.
 */
export * from './shuffle.js';
