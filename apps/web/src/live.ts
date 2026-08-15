import { useEffect, useRef, useState } from 'react';
import { api, type HandSummary, type SeatView, type TableState } from './api';
import { actionLabel, type ActionKind } from './ui';

/**
 * The live room, folded out of the spectator feed.
 *
 * `table_state` only arrives when seats change or a hand settles. Everything that happens
 * *during* a hand comes as `hand_start`, `action_taken`, `street` and `showdown`, so a live
 * view has to fold those into its own state — otherwise the felt sits at an empty board and
 * a zero pot while a hand plays out in front of you.
 *
 * On top of the wire state this keeps a layer of *transient* facts — what a seat just said,
 * who was just paid, whether chips are mid-sweep. They are what makes the table feel like a
 * table rather than a form that refreshes, and they are deliberately kept separate from the
 * authoritative fields so nothing decorative can be mistaken for the record.
 *
 * ## Live hole cards are never here
 *
 * The stream this reads never carries a live player's hole cards, so this page *cannot* show
 * them even if it wanted to — which is the property that stops an operator watching the
 * public feed and feeding their own bot. Face-down cards here are face-down all the way down.
 */

export interface Decorated extends TableState {
  /** `SHA256(serverSeed)`, published before a card is dealt. Cleared once the flash is done. */
  commit: string | null;
  commitUntil: number;
  /** Whose turn it is believed to be. See `nextActor` — inferred, and treated as such. */
  actingSeat: number | null;
  says: Record<number, { kind: ActionKind; text: string; id: number; until: number }>;
  wins: Record<number, { amount: number; until: number }>;
  showdowns: Record<number, string>;
  sweepUntil: number;
  awards: { seat: number; amount: number }[];
  awardsUntil: number;
  /** Hands seen since this page connected. Honest about its own scope, unlike a total. */
  handsSeen: number;
}

const SAY_MS = 2_500;
const WIN_MS = 3_000;
const SWEEP_MS = 600;
const AWARD_MS = 1_100;
const COMMIT_MS = 3_500;

function decorate(state: TableState, previous?: Decorated): Decorated {
  return {
    ...state,
    commit: previous?.commit ?? null,
    commitUntil: previous?.commitUntil ?? 0,
    actingSeat: previous?.actingSeat ?? null,
    says: previous?.says ?? {},
    wins: previous?.wins ?? {},
    showdowns: previous?.showdowns ?? {},
    sweepUntil: previous?.sweepUntil ?? 0,
    awards: previous?.awards ?? [],
    awardsUntil: previous?.awardsUntil ?? 0,
    handsSeen: previous?.handsSeen ?? 0,
  };
}

const occupiedSeats = (seats: SeatView[]) =>
  [...seats].filter((s) => s.playerId !== null && s.status !== 'empty').sort((a, b) => a.seat - b.seat);

/** The next seat, wrapping, that satisfies `ok`. */
function seatAfter(seats: SeatView[], after: number, ok: (s: SeatView) => boolean): number | null {
  const ring = occupiedSeats(seats);
  if (ring.length === 0) return null;
  const start = ring.findIndex((s) => s.seat > after);
  const from = start === -1 ? 0 : start;
  for (let i = 0; i < ring.length; i++) {
    const seat = ring[(from + i) % ring.length]!;
    if (ok(seat)) return seat.seat;
  }
  return null;
}

/**
 * Whose turn it probably is.
 *
 * The spectator feed does not say. It carries what happened, not what is awaited — deliberately,
 * since a public "seat 3 is deciding" is not information a spectator needs and the agent that
 * *is* deciding already knows. So the acting seat is inferred here: after an action, the next
 * seat clockwise still able to act.
 *
 * That is right in the middle of a betting round and can be briefly wrong at the end of one —
 * where the true answer is "nobody, the round is over". The correction always follows within
 * a few hundred milliseconds as the `street` or `showdown` message lands, and the indicator it
 * drives is a soft pulse rather than a claim, which is why an inference is good enough here
 * and would not be if this drove a countdown clock.
 */
function nextActor(seats: SeatView[], after: number): number | null {
  return seatAfter(seats, after, (s) => s.status === 'active');
}

/** Who acts first on a new street: the first live seat left of the button. */
function firstActorPostflop(seats: SeatView[], button: number | null): number | null {
  if (button === null) return null;
  return nextActor(seats, button);
}

/**
 * Who acts first preflop: left of the big blind.
 *
 * Heads-up the button *is* the small blind and acts first, which inverts the usual order.
 * This mirrors `dealHand` in `@clawroll/poker` — the single most commonly mis-implemented
 * rule in Hold'em, and worth restating rather than deriving.
 */
function firstActorPreflop(seats: SeatView[], button: number | null): number | null {
  if (button === null) return null;
  const ring = occupiedSeats(seats);
  const headsUp = ring.length === 2;
  const sb = headsUp ? button : (seatAfter(seats, button, () => true) ?? button);
  const bb = seatAfter(seats, sb, () => true) ?? sb;
  return nextActor(seats, bb);
}

export interface Room {
  tables: Record<string, Decorated>;
  ordered: Decorated[];
  connected: boolean;
  recent: HandSummary[];
}

export function useLiveRoom(): Room {
  const [tables, setTables] = useState<Record<string, Decorated>>({});
  const [connected, setConnected] = useState(false);
  const [recent, setRecent] = useState<HandSummary[]>([]);
  // Monotonic, so two identical actions in a row still remount their bubble and replay it.
  const sayId = useRef(0);

  useEffect(() => {
    api
      .tables()
      .then((list) => setTables(Object.fromEntries(list.map((t) => [t.tableId, decorate(t)]))))
      .catch(() => {});
    api.hands().then(setRecent).catch(() => {});

    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/spectate`;
    const socket = new WebSocket(url);
    socket.onopen = () => setConnected(true);
    socket.onclose = () => setConnected(false);

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data as string) as Record<string, unknown> & { type: string };

      // Every message names its table, so a room with two of them does not need the client
      // to track which hand belongs where.
      const tableId = message['tableId'] as string | undefined;
      if (!tableId) return;
      const now = Date.now();

      setTables((all) => {
        const current = all[tableId] ?? null;

        const next = ((): Decorated | null => {
          switch (message.type) {
            case 'table_state': {
              const state = decorate(message as unknown as TableState, current ?? undefined);
              // Between hands the table has no hand, so this message reports an empty board,
              // a zero pot and no button — all true, and all arriving a few milliseconds
              // after the showdown. Taken literally it wipes the winning board, the revealed
              // hands and the pot off the felt at the exact instant they became worth
              // looking at. So once a hand is complete the picture is held: seats and stacks
              // still update from the wire, but what the hand *was* stays up until the next
              // `hand_start` clears it for real.
              if (!current || (current.street !== 'complete' && current.street !== 'showdown')) {
                return state;
              }
              return {
                ...state,
                board: current.board,
                pot: current.pot,
                street: current.street,
                buttonSeat: current.buttonSeat,
                handId: current.handId,
                // Hole cards shown at showdown are public for ever and sit in the published
                // record; re-hiding them here would take back nothing.
                seats: state.seats.map((s) =>
                  s.holeCards
                    ? s
                    : { ...s, holeCards: current.seats.find((x) => x.seat === s.seat)?.holeCards ?? null },
                ),
              };
            }

            case 'hand_start': {
              if (!current) return current;
              const seats = message['seats'] as SeatView[];
              const button = message['buttonSeat'] as number;
              return {
                ...current,
                handId: message['handId'] as string,
                street: 'preflop',
                board: '',
                // The blinds and any ante are already committed by the time this arrives, so
                // the hand does not open at zero. `pot` here means everything wagered, which
                // is what the engine's own `street` messages report — starting from anything
                // else would make the pot jump when the flop lands.
                pot: seats.reduce((total, s) => total + s.committedThisStreet, 0),
                buttonSeat: button,
                seats,
                commit: (message['commit'] as string | undefined) ?? null,
                commitUntil: now + COMMIT_MS,
                actingSeat: firstActorPreflop(seats, button),
                // A new hand clears every trace of the last one.
                says: {},
                wins: {},
                showdowns: {},
                awards: [],
                sweepUntil: 0,
                handsSeen: current.handsSeen + 1,
              };
            }

            case 'street': {
              if (!current) return current;
              return {
                ...current,
                street: message['street'] as string,
                board: message['board'] as string,
                pot: message['pot'] as number,
                // The chips stay on the cloth for the length of the sweep and are cleared by
                // the reaper below — a street that wiped them instantly would have money
                // vanish rather than move.
                sweepUntil: now + SWEEP_MS,
                actingSeat: firstActorPostflop(current.seats, current.buttonSeat),
              };
            }

            case 'action_taken': {
              if (!current) return current;
              const seat = message['seat'] as number;
              const amount = message['amount'] as number;
              const stack = message['stack'] as number;
              const action = message['action'] as string;
              const say = actionLabel(action, amount, stack);
              return {
                ...current,
                seats: current.seats.map((s) =>
                  s.seat === seat
                    ? {
                        ...s,
                        stack,
                        committedThisStreet: s.committedThisStreet + amount,
                        status: action === 'fold' ? 'folded' : stack === 0 ? 'allin' : s.status,
                      }
                    : s,
                ),
                pot: current.pot + amount,
                says: {
                  ...current.says,
                  [seat]: { ...say, id: ++sayId.current, until: now + SAY_MS },
                },
                actingSeat: nextActor(
                  current.seats.map((s) =>
                    s.seat === seat
                      ? { ...s, status: action === 'fold' ? 'folded' : stack === 0 ? 'allin' : s.status }
                      : s,
                  ),
                  seat,
                ),
              };
            }

            case 'showdown': {
              if (!current) return current;
              // The one moment hole cards legitimately become public.
              const shown = message['hands'] as { seat: number; cards: string; description: string }[];
              const awards = message['awards'] as { seat: number; amount: number }[];
              const wins: Decorated['wins'] = {};
              for (const award of awards) {
                wins[award.seat] = {
                  amount: (wins[award.seat]?.amount ?? 0) + award.amount,
                  until: now + WIN_MS,
                };
              }
              return {
                ...current,
                seats: current.seats.map((s) => {
                  const reveal = shown.find((h) => h.seat === s.seat);
                  return reveal ? { ...s, holeCards: reveal.cards } : s;
                }),
                showdowns: Object.fromEntries(shown.map((h) => [h.seat, h.description])),
                wins,
                awards: awards.map((a) => ({ seat: a.seat, amount: a.amount })),
                awardsUntil: now + AWARD_MS,
                actingSeat: null,
                street: 'showdown',
              };
            }

            case 'hand_end': {
              if (!current) return current;
              const stacks = message['stacks'] as { seat: number; stack: number }[];
              return {
                ...current,
                seats: current.seats.map((s) => {
                  const settled = stacks.find((x) => x.seat === s.seat);
                  return settled ? { ...s, stack: settled.stack, committedThisStreet: 0 } : s;
                }),
                street: 'complete',
                actingSeat: null,
              };
            }

            default:
              return current;
          }
        })();

        return next ? { ...all, [tableId]: next } : all;
      });

      // A finished hand becomes publicly readable immediately, so refresh the list.
      if (message.type === 'hand_end') api.hands().then(setRecent).catch(() => {});
    };

    return () => socket.close();
  }, []);

  // One reaper for every transient fact, rather than a timeout per bubble.
  //
  // Each decoration carries the instant it stops being true and this drops it at the next
  // tick. Because every one of them animates with `fill-mode: both`, an expiry arriving up
  // to a tick late is invisible — the element is already at its final, faded keyframe. The
  // identity check at the end matters: without it this would re-render the whole room five
  // times a second for nothing.
  useEffect(() => {
    const timer = setInterval(() => {
      setTables((all) => {
        const now = Date.now();
        let changed = false;
        const next: Record<string, Decorated> = {};

        for (const [id, table] of Object.entries(all)) {
          let table2 = table;

          const says = Object.fromEntries(
            Object.entries(table.says).filter(([, s]) => s.until > now),
          );
          if (Object.keys(says).length !== Object.keys(table.says).length) {
            table2 = { ...table2, says };
          }

          const wins = Object.fromEntries(
            Object.entries(table.wins).filter(([, w]) => w.until > now),
          );
          if (Object.keys(wins).length !== Object.keys(table.wins).length) {
            table2 = { ...table2, wins };
          }

          if (table.commit && table.commitUntil <= now) table2 = { ...table2, commit: null };
          if (table.awards.length > 0 && table.awardsUntil <= now) table2 = { ...table2, awards: [] };

          // The sweep finishing is the moment the chips are actually in the pot.
          if (table.sweepUntil > 0 && table.sweepUntil <= now) {
            table2 = {
              ...table2,
              sweepUntil: 0,
              seats: table2.seats.map((s) => (s.committedThisStreet === 0 ? s : { ...s, committedThisStreet: 0 })),
            };
          }

          if (table2 !== table) changed = true;
          next[id] = table2;
        }

        return changed ? next : all;
      });
    }, 200);
    return () => clearInterval(timer);
  }, []);

  const ordered = Object.values(tables).sort((a, b) => a.tableId.localeCompare(b.tableId));
  return { tables, ordered, connected, recent };
}
