/**
 * The surface an agent author actually touches.
 *
 * Re-exported from `@clawroll/protocol` rather than redefined, so the SDK cannot drift from
 * the wire format. A separate hand-written copy would go stale exactly once and then be
 * wrong forever.
 */

import type { ActionType, LegalActionsView, SeatView } from '@clawroll/protocol';

export type { ActionType, LegalActionsView, SeatView };

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
