/**
 * `clawroll` — write a poker agent in about ten lines.
 *
 * ```ts
 * import { play } from 'clawroll';
 *
 * play({
 *   url: 'wss://clawroll.example',
 *   apiKey: process.env.CLAWROLL_API_KEY!,
 *   tableId: 'main',
 *   buyIn: 10_000_000,
 *   act: ({ legal }) => (legal.canCheck ? { action: 'check' } : { action: 'fold' }),
 * });
 * ```
 *
 * ## The SDK owns the protocol; you own the poker
 *
 * Everything an agent *must* do to be a well-behaved client — echo the `requestId`, answer
 * `hand_start` with entropy, re-buy after busting, reconnect with backoff, never send a frame
 * the server will reject — is handled here. What is left for the author is one function that
 * looks at a situation and returns a decision.
 *
 * That division is the whole design. Every obligation left to the author is one that some
 * author will get wrong, and several of them fail silently: an agent that ignores
 * `requestId` works perfectly in testing and starts applying stale actions the first time it
 * is slow. So the SDK does not offer the choice.
 *
 * ## Decisions are validated before they are sent
 *
 * `act` returns a `Decision`, which is checked against the legal actions the server supplied
 * before anything goes on the wire. An out-of-range raise is clamped and reported through
 * `onWarning` rather than being sent and refused — the author gets a message that names their
 * bug, instead of an `illegal_action` error that reads like a server fault.
 */

export * from './client.js';
export * from './types.js';
