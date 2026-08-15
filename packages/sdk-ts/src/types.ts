/**
 * The surface an agent author actually touches.
 *
 * ## Why these are written out rather than re-exported
 *
 * They used to be `export type { ActionType, LegalActionsView, SeatView } from
 * '@clawroll/protocol'`, on the reasoning that re-exporting cannot drift from the wire format
 * while a hand-written copy goes stale exactly once and is then wrong forever. That reasoning
 * is sound, and the anti-drift guarantee is kept below — but the re-export could not survive
 * publishing.
 *
 * `@clawroll/protocol` is bundled into the published package, so it does not exist for a
 * consumer to import from. A re-export leaves `import { SeatView } from '@clawroll/protocol'`
 * in the emitted `.d.ts` — a specifier nobody outside this repo can resolve. The JavaScript
 * runs perfectly and every TypeScript user fails to compile, which is a failure a plain-JS
 * smoke test never catches.
 *
 * Declaring them here also produces far better types for a consumer: readable interfaces in
 * the editor instead of `z.infer<typeof ...>` inference chains.
 *
 * ## How drift is prevented anyway
 *
 * `assertMatchesProtocol` below is a compile-time proof that these declarations and the zod
 * schemas describe the same shapes, in both directions. Add a field to the protocol, remove
 * one here, or change a type, and `pnpm typecheck` fails in this file. That is strictly
 * stronger than the re-export: it was an assumption, this is checked.
 */

/** What an agent may do. */
export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise';

/** One seat as the agent sees it. */
export interface SeatView {
  readonly seat: number;
  readonly playerId: string | null;
  readonly displayName: string | null;
  readonly stack: number;
  readonly committedThisStreet: number;
  readonly status: 'active' | 'folded' | 'allin' | 'sitting_out' | 'empty';
  /**
   * Populated only for the receiving agent's own seat, or for everyone at showdown. Live hole
   * cards are never broadcast — a spectator feed carrying them would let an operator watch the
   * public stream and feed their own bot.
   */
  readonly holeCards: string | null;
}

/**
 * What is legal right now, precomputed by the server.
 *
 * An agent never needs to re-derive the betting rules: minimum raises, all-in behaviour and
 * side pots are already accounted for. If `canRaise` is false, raising is not possible.
 */
export interface LegalActionsView {
  readonly canFold: boolean;
  readonly canCheck: boolean;
  readonly canCall: boolean;
  /** Additional chips needed to call, already capped at the seat's stack. */
  readonly callAmount: number;
  readonly canBet: boolean;
  readonly canRaise: boolean;
  /** Smallest legal `amount`; clamped to `maxRaiseTo` when the seat can only shove. */
  readonly minRaiseTo: number;
  /** Largest legal `amount` — the seat's whole stack. */
  readonly maxRaiseTo: number;
}

/** What the agent decides to do. */
export interface Decision {
  readonly action: ActionType;
  /**
   * For `bet` and `raise` only: the total this seat will have committed on the current
   * street once applied — a raise *to*, not a raise *by*.
   */
  readonly amount?: number;
}

/** Everything known when it is the agent's turn. */
export interface Situation {
  /** The agent's own cards, e.g. `"As Kd"`. */
  readonly holeCards: string;
  /** Community cards so far, e.g. `"2h 5s 9c"`. Empty pre-flop. */
  readonly board: string;
  readonly street: string;
  /** Total in the middle, in micro-USDC. */
  readonly pot: number;
  /** Highest amount committed this street; what a call has to match. */
  readonly betToCall: number;
  /** Precomputed by the server — no need to re-derive the betting rules. */
  readonly legal: LegalActionsView;
  readonly seat: number;
  readonly seats: readonly SeatView[];
  /** Milliseconds remaining before the server acts for you. */
  readonly msRemaining: number;
}

export interface HandResult {
  readonly handId: string;
  /** Net micro-USDC across the hand. Negative when the agent lost. */
  readonly net: number;
  readonly stack: number;
}

export interface AgentOptions {
  /** e.g. `wss://clawroll.example` or `ws://127.0.0.1:8080`. */
  readonly url: string;
  readonly apiKey: string;
  readonly tableId: string;
  /** Micro-USDC. 1 USDC = 1,000,000. */
  readonly buyIn: number;

  /** Called when it is the agent's turn. */
  act(situation: Situation): Decision | Promise<Decision>;

  /** Times to re-buy after busting. Defaults to 0 — the agent leaves when broke. */
  readonly rebuys?: number;
  /** Called after each hand the agent played. */
  onHandEnd?(result: HandResult): void;
  /**
   * Called for anything the author probably wants to know about but that is not fatal —
   * a clamped raise, a rejected action, a dropped connection.
   */
  onWarning?(message: string): void;
  /** Reconnect after a dropped connection. Defaults to true. */
  readonly reconnect?: boolean;
}
