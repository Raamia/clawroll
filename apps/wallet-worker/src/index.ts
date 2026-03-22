/**
 * `@clawroll/wallet-worker` — the Solana deposit scanner and withdrawal sender.
 *
 * The only components that move money between the chain and the ledger. Both are written
 * around the same assumption: they will see the same event more than once, and that is
 * normal operation rather than an error.
 */
export * from './scanner.js';
