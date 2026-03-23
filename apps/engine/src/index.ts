/**
 * `@clawroll/engine` — the table runtime and agent-facing server.
 *
 * This is where the pure packages become a running game: `TableRuntime` owns seats and
 * chips, drives the commit-reveal shuffle, runs the betting loop, and emits protocol
 * messages. It holds no poker rules of its own. `ClawrollServer` wraps it in WebSockets
 * and is a thin adapter with no game logic at all.
 */
export * from './archive.js';
export * from './auth.js';
export * from './bankroll.js';
export * from './server.js';
export * from './table.js';
