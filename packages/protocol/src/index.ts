/**
 * `@clawroll/protocol` — the agent wire protocol.
 *
 * Shared by the engine, both agent SDKs, and the spectator web client. Keeping it in
 * one package is why a protocol change is a build error rather than a runtime surprise
 * discovered by an agent author at 2am.
 */
export * from './messages.js';
