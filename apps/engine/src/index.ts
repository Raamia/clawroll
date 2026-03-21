/**
 * `@clawroll/engine` — the table runtime and agent-facing server.
 *
 * This is where the pure packages become a running game: `TableRuntime` owns seats and
 * chips, drives the commit-reveal shuffle, runs the betting loop, and emits protocol
 * messages. It holds no poker rules of its own.
 */
export * from './table.js';
