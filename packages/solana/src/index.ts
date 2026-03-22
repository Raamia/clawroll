/**
 * `@clawroll/solana` — devnet guard, HD deposit address derivation, and USDC helpers.
 *
 * Clawroll is devnet-only, and this package is where that is enforced: `assertDevnet`
 * checks the cluster's genesis hash rather than trusting a URL string, so pointing at real
 * money is a deliberate code change rather than an environment variable.
 */
export * from './cluster.js';
export * from './derivation.js';
