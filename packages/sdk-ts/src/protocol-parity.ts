/**
 * Compile-time proof that the SDK's public types still match the wire protocol.
 *
 * The public types in `types.ts` are declared by hand rather than re-exported from
 * `@clawroll/protocol`, because the protocol package is bundled into the published SDK and so
 * cannot appear in the emitted declarations — see the docblock there for the full reasoning.
 *
 * Hand-written copies of a wire format go stale. This file is what stops that: it asserts, in
 * both directions, that each declaration and its zod schema describe the same type. Add a
 * field to the protocol, drop one from the SDK, widen a `number` to `number | null` — any of
 * them turns into a type error here, at `pnpm typecheck`, rather than into a runtime surprise
 * several hands into someone else's session.
 *
 * Nothing is exported and nothing runs. `verbatimModuleSyntax` erases the whole module, so it
 * contributes no bytes to the bundle. It exists purely to be typechecked.
 *
 * Both directions matter, and one is easy to forget. `Mutually<A, B>` fails if either side has
 * a member the other lacks — a one-directional `extends` check would happily accept the SDK
 * silently dropping a field the server still sends.
 */

import type {
  ActionType as WireActionType,
  LegalActionsView as WireLegalActions,
  SeatView as WireSeatView,
} from '@clawroll/protocol';
import type { ActionType, LegalActionsView, SeatView } from './types.js';

/**
 * Structural equality, ignoring `readonly`.
 *
 * The SDK marks its fields `readonly` (an agent has no business mutating what the server
 * sent) while the zod-inferred types do not, so a strict identity check would fail on every
 * field for a difference that does not exist at runtime. `-readonly` normalises both sides
 * before comparing.
 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type Exact<A, B> = Mutable<A> extends Mutable<B> ? (Mutable<B> extends Mutable<A> ? true : never) : never;

/** Fails to compile unless `A` and `B` are the same type in both directions. */
type Mutually<A, B> = Exact<A, B>;

// Each line is the assertion. A mismatch makes the right-hand side `never`, and `true` is not
// assignable to `never` — so the error lands on the specific type that drifted.
const _actionType: Mutually<ActionType, WireActionType> = true;
const _seatView: Mutually<SeatView, WireSeatView> = true;
const _legalActions: Mutually<LegalActionsView, WireLegalActions> = true;

// Referenced so `noUnusedLocals` stays satisfied without weakening it for the whole package.
export type ProtocolParityChecked = [
  typeof _actionType,
  typeof _seatView,
  typeof _legalActions,
];
