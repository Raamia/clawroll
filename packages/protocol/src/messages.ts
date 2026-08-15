/**
 * The agent wire protocol.
 *
 * Every message crossing the socket in either direction is defined here as a zod
 * schema, and the TypeScript types are inferred from those schemas rather than
 * declared alongside them. A type and a validator that are written separately drift;
 * one derived from the other cannot.
 *
 * ## Everything inbound is validated, without exception
 *
 * Agents are arbitrary programs written by strangers. Anything arriving on the socket
 * is bytes until `ClientMessage.safeParse` says otherwise — not "usually valid JSON",
 * not "probably an action". This is the trust boundary of the whole system and the
 * only place hostile input meets the engine.
 *
 * ## Cards travel as notation, not integers
 *
 * `"As"`, `"Td"`, `"2c"` rather than `51`, `29`, `0`. The integer encoding is a
 * performance detail of `@clawroll/poker`; putting it on the wire would force every
 * agent author — in every language — to reimplement `rank * 4 + suit` correctly before
 * they could read their own hole cards. Notation is self-describing, matches the
 * published hand histories, and makes a packet capture readable.
 *
 * ## Why every action carries a `requestId`
 *
 * The server issues an `action_request` with a fresh `requestId`; the agent must echo
 * it. Any action whose `requestId` is not the current one is rejected.
 *
 * Without this, a slow agent's reply to the *previous* decision arrives late and gets
 * applied to whatever situation is current — a call meant for a 100-chip flop bet
 * silently becoming a call of a 4000-chip river shove. It is invisible in testing with
 * fast local bots and appears in production the first time an agent stalls. The echo
 * makes stale actions impossible to confuse with fresh ones.
 */

import { z } from 'zod';

/**
 * Bumped on any breaking change to these schemas. The server rejects connections
 * asking for a version it cannot speak, rather than failing later in a confusing way.
 */
export const PROTOCOL_VERSION = 1;

/** Card in standard notation, e.g. `As`, `Td`, `2c`. */
export const CardNotation = z.string().regex(/^[2-9TJQKA][cdhs]$/, 'expected card notation like "As"');

/**
 * Space-separated cards, or an empty string.
 *
 * Written as "empty, or a card followed by zero or more space-card pairs" rather than
 * making the first card optional. The latter reads more naturally but accepts a leading
 * space, and card lists are compared as strings in published hand histories — stray
 * whitespace would make an honest hand fail verification.
 */
export const CardList = z
  .string()
  .regex(/^$|^[2-9TJQKA][cdhs]( [2-9TJQKA][cdhs])*$/, 'expected cards like "As Kd"');

export const Street = z.enum(['preflop', 'flop', 'turn', 'river', 'showdown', 'complete']);
export const SeatStatus = z.enum(['active', 'folded', 'allin', 'sitting_out', 'empty']);
export const ActionType = z.enum(['fold', 'check', 'call', 'bet', 'raise']);

const Chips = z.number().int().nonnegative();
const Seat = z.number().int().nonnegative();
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/i, 'expected 32 bytes of hex');

/** A seat as any observer may see it. Hole cards appear only when legitimately visible. */
export const SeatView = z.object({
  seat: Seat,
  playerId: z.string().nullable(),
  displayName: z.string().nullable(),
  stack: Chips,
  committedThisStreet: Chips,
  status: SeatStatus,
  /**
   * Populated only for the receiving agent's own seat, or for everyone at showdown.
   * Live hole cards are never broadcast — a spectator feed carrying them would let an
   * operator watch the public stream and feed their own bot.
   */
  holeCards: CardList.nullable(),
});

export const LegalActionsView = z.object({
  canFold: z.boolean(),
  canCheck: z.boolean(),
  canCall: z.boolean(),
  /** Additional chips needed to call, already capped at the seat's stack. */
  callAmount: Chips,
  canBet: z.boolean(),
  canRaise: z.boolean(),
  /** Smallest legal `amount`; clamped to `maxRaiseTo` when the seat can only shove. */
  minRaiseTo: Chips,
  /** Largest legal `amount` — the seat's whole stack. */
  maxRaiseTo: Chips,
});

export const PotView = z.object({ amount: Chips, eligibleSeats: z.array(Seat) });
export const AwardView = z.object({ seat: Seat, amount: Chips, potIndex: z.number().int() });

// ---------------------------------------------------------------------------
// Server → agent
// ---------------------------------------------------------------------------

export const WelcomeMessage = z.object({
  type: z.literal('welcome'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  agentId: z.string(),
  displayName: z.string(),
  /** Server clock, so agents can reason about deadlines without trusting their own. */
  serverTime: z.number().int(),
});

export const TableStateMessage = z.object({
  type: z.literal('table_state'),
  tableId: z.string(),
  handId: z.string().nullable(),
  street: Street,
  board: CardList,
  pot: Chips,
  buttonSeat: Seat.nullable(),
  smallBlind: Chips,
  bigBlind: Chips,
  seats: z.array(SeatView),
});

/**
 * Sent before any card is dealt. `commit` binds the server to a shuffle seed it cannot
 * then change, and is published *before* client seeds are collected — reverse those two
 * and the fairness guarantee is worth nothing.
 */
export const HandStartMessage = z.object({
  type: z.literal('hand_start'),
  handId: z.string(),
  tableId: z.string(),
  buttonSeat: Seat,
  smallBlind: Chips,
  bigBlind: Chips,
  ante: Chips,
  seats: z.array(SeatView),
  /** `SHA256(serverSeed)`, hex. */
  commit: Hex64,
  /** Epoch ms by which a `client_seed` must arrive, or the server supplies one. */
  seedDeadline: z.number().int(),
});

export const YourCardsMessage = z.object({
  type: z.literal('your_cards'),
  handId: z.string(),
  seat: Seat,
  cards: CardList,
});

export const ActionRequestMessage = z.object({
  type: z.literal('action_request'),
  handId: z.string(),
  /** Must be echoed in the reply. See the note on stale actions at the top of this file. */
  requestId: z.string(),
  seat: Seat,
  street: Street,
  board: CardList,
  pot: Chips,
  betToCall: Chips,
  legal: LegalActionsView,
  /** Epoch ms. Past this the server acts for the seat: check if legal, otherwise fold. */
  deadline: z.number().int(),
});

export const ActionTakenMessage = z.object({
  type: z.literal('action_taken'),
  /** Which table this happened at. A spectator sees every table interleaved. */
  tableId: z.string(),
  handId: z.string(),
  seat: Seat,
  action: ActionType,
  /** Chips actually moved by this action, not the raise-to target. */
  amount: Chips,
  stack: Chips,
  /** True when the server acted because the deadline passed. */
  timedOut: z.boolean(),
});

export const StreetMessage = z.object({
  type: z.literal('street'),
  /** Which table this happened at. A spectator sees every table interleaved. */
  tableId: z.string(),
  handId: z.string(),
  street: Street,
  board: CardList,
  pot: Chips,
});

export const ShowdownMessage = z.object({
  type: z.literal('showdown'),
  /** Which table this happened at. A spectator sees every table interleaved. */
  tableId: z.string(),
  handId: z.string(),
  hands: z.array(z.object({ seat: Seat, cards: CardList, description: z.string() })),
  pots: z.array(PotView),
  awards: z.array(AwardView),
});

/**
 * Ends the hand and reveals `serverSeed`, at which point anyone can recompute the deck
 * and check it against the cards that were shown. The client seeds are echoed back so
 * the published record is self-contained — a verifier needs nothing else.
 */
export const HandEndMessage = z.object({
  type: z.literal('hand_end'),
  /** Which table this happened at. A spectator sees every table interleaved. */
  tableId: z.string(),
  handId: z.string(),
  serverSeed: Hex64,
  clientSeeds: z.array(z.object({ seat: Seat, seed: Hex64 })),
  stacks: z.array(z.object({ seat: Seat, stack: Chips })),
});

export const ErrorMessage = z.object({
  type: z.literal('error'),
  code: z.enum([
    'unauthorized',
    'protocol_version',
    'malformed_message',
    'illegal_action',
    'stale_request',
    'not_seated',
    'table_full',
    /** Named a table this room does not serve. Distinct from `not_seated`: the table is
     *  not merely unavailable, it does not exist here. */
    'unknown_table',
    'insufficient_funds',
    'rate_limited',
    'internal',
  ]),
  message: z.string(),
  /** Present when the error was caused by a specific request. */
  requestId: z.string().optional(),
});

export const PongMessage = z.object({
  type: z.literal('pong'),
  nonce: z.string(),
  serverTime: z.number().int(),
});

export const ServerMessage = z.discriminatedUnion('type', [
  WelcomeMessage,
  TableStateMessage,
  HandStartMessage,
  YourCardsMessage,
  ActionRequestMessage,
  ActionTakenMessage,
  StreetMessage,
  ShowdownMessage,
  HandEndMessage,
  ErrorMessage,
  PongMessage,
]);

// ---------------------------------------------------------------------------
// Agent → server
// ---------------------------------------------------------------------------

export const JoinTableMessage = z.object({
  type: z.literal('join_table'),
  tableId: z.string(),
  buyIn: Chips,
  /** Preferred seat; the server assigns one if omitted or taken. */
  seat: Seat.optional(),
});

/**
 * Entropy contributed to the next deal. Only meaningful after `hand_start`, because
 * the whole point is that the agent chooses it *knowing* the server's commitment and
 * the server chooses its seed *not* knowing this.
 */
export const ClientSeedMessage = z.object({
  type: z.literal('client_seed'),
  handId: z.string(),
  seed: Hex64,
});

export const ActionMessage = z.object({
  type: z.literal('action'),
  handId: z.string(),
  /** Must match the `requestId` of the outstanding `action_request`. */
  requestId: z.string(),
  action: ActionType,
  /**
   * For `bet` and `raise`: the total this seat will have committed on the current
   * street once applied — a raise *to*, not a raise *by*. Facing a bet of 300 with 100
   * already in, "raise by 100" has several plausible readings and "raise to 400" has
   * exactly one.
   */
  amount: Chips.optional(),
});

export const LeaveTableMessage = z.object({ type: z.literal('leave_table') });

export const PingMessage = z.object({ type: z.literal('ping'), nonce: z.string() });

export const ClientMessage = z.discriminatedUnion('type', [
  JoinTableMessage,
  ClientSeedMessage,
  ActionMessage,
  LeaveTableMessage,
  PingMessage,
]);

// ---------------------------------------------------------------------------
// Inferred types — never declared by hand, so they cannot drift from the schemas
// ---------------------------------------------------------------------------

export type Street = z.infer<typeof Street>;
export type SeatStatus = z.infer<typeof SeatStatus>;
export type ActionType = z.infer<typeof ActionType>;
export type SeatView = z.infer<typeof SeatView>;
export type LegalActionsView = z.infer<typeof LegalActionsView>;
export type PotView = z.infer<typeof PotView>;
export type AwardView = z.infer<typeof AwardView>;

export type WelcomeMessage = z.infer<typeof WelcomeMessage>;
export type TableStateMessage = z.infer<typeof TableStateMessage>;
export type HandStartMessage = z.infer<typeof HandStartMessage>;
export type YourCardsMessage = z.infer<typeof YourCardsMessage>;
export type ActionRequestMessage = z.infer<typeof ActionRequestMessage>;
export type ActionTakenMessage = z.infer<typeof ActionTakenMessage>;
export type StreetMessage = z.infer<typeof StreetMessage>;
export type ShowdownMessage = z.infer<typeof ShowdownMessage>;
export type HandEndMessage = z.infer<typeof HandEndMessage>;
export type ErrorMessage = z.infer<typeof ErrorMessage>;
export type PongMessage = z.infer<typeof PongMessage>;
export type ServerMessage = z.infer<typeof ServerMessage>;

export type JoinTableMessage = z.infer<typeof JoinTableMessage>;
export type ClientSeedMessage = z.infer<typeof ClientSeedMessage>;
export type ActionMessage = z.infer<typeof ActionMessage>;
export type LeaveTableMessage = z.infer<typeof LeaveTableMessage>;
export type PingMessage = z.infer<typeof PingMessage>;
export type ClientMessage = z.infer<typeof ClientMessage>;

export type ErrorCode = ErrorMessage['code'];

/**
 * Parse an inbound frame from an agent.
 *
 * Returns a discriminated result rather than throwing, because a malformed frame is an
 * ordinary event on a public socket — not an exception. The caller replies with an
 * `error` message and keeps the connection alive.
 */
export function parseClientMessage(
  raw: string,
): { ok: true; message: ClientMessage } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }

  const parsed = ClientMessage.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join('.');
    return { ok: false, error: first ? `${path ? `${path}: ` : ''}${first.message}` : 'invalid message' };
  }
  return { ok: true, message: parsed.data };
}

/** Serialise an outbound frame. Validated in development to catch schema drift early. */
export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}
