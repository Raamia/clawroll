import { useEffect, useRef, useState } from 'react';
import { api, shortId, usdc, type TableState } from '../api';
import { Cards, HiddenHand } from '../components/Cards';

/**
 * The live table.
 *
 * Fed by the same `/spectate` socket any observer can open. Notably, that stream never
 * carries a live player's hole cards — so this page *cannot* show them even if it wanted to,
 * which is the property that stops an operator watching the public feed and feeding their
 * own bot. Face-down cards here are face-down all the way down.
 */
export function Tables({ onOpenHand }: { onOpenHand: (handId: string) => void }) {
  const [table, setTable] = useState<TableState | null>(null);
  const [connected, setConnected] = useState(false);
  const [recent, setRecent] = useState<{ handId: string; potTotal: number; board: string }[]>([]);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    api.tables().then((t) => setTable(t[0] ?? null)).catch(() => {});
    api.hands().then(setRecent).catch(() => {});

    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/spectate`;
    const socket = new WebSocket(url);
    socketRef.current = socket;

    socket.onopen = () => setConnected(true);
    socket.onclose = () => setConnected(false);

    // `table_state` only arrives when seats change or a hand settles. Everything that
    // happens *during* a hand comes as `hand_start`, `action_taken`, `street` and
    // `showdown`, so the live view has to fold those into its own state — otherwise the
    // felt sits at an empty board and a zero pot while a hand plays out in front of you.
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data as string) as Record<string, unknown> & { type: string };

      setTable((current) => {
        switch (message.type) {
          case 'table_state':
            return message as unknown as TableState;

          case 'hand_start':
            return current
              ? {
                  ...current,
                  handId: message['handId'] as string,
                  street: 'preflop',
                  board: '',
                  pot: 0,
                  buttonSeat: message['buttonSeat'] as number,
                  seats: message['seats'] as TableState['seats'],
                }
              : current;

          case 'street':
            return current
              ? {
                  ...current,
                  street: message['street'] as string,
                  board: message['board'] as string,
                  pot: message['pot'] as number,
                  // A new street clears what everyone had out in front of them.
                  seats: current.seats.map((s) => ({ ...s, committedThisStreet: 0 })),
                }
              : current;

          case 'action_taken':
            return current
              ? {
                  ...current,
                  seats: current.seats.map((s) =>
                    s.seat === message['seat']
                      ? {
                          ...s,
                          stack: message['stack'] as number,
                          committedThisStreet: s.committedThisStreet + (message['amount'] as number),
                          status: message['action'] === 'fold' ? 'folded' : s.status,
                        }
                      : s,
                  ),
                  pot: current.pot + (message['amount'] as number),
                }
              : current;

          case 'showdown': {
            // The one moment hole cards legitimately become public.
            const shown = message['hands'] as { seat: number; cards: string }[];
            return current
              ? {
                  ...current,
                  seats: current.seats.map((s) => {
                    const reveal = shown.find((h) => h.seat === s.seat);
                    return reveal ? { ...s, holeCards: reveal.cards } : s;
                  }),
                }
              : current;
          }

          default:
            return current;
        }
      });

      // A finished hand becomes publicly readable immediately, so refresh the list.
      if (message.type === 'hand_end') api.hands().then(setRecent).catch(() => {});
    };
    return () => socket.close();
  }, []);

  const seated = table?.seats.filter((s) => s.status !== 'empty') ?? [];

  return (
    <>
      <h1>Live table</h1>
      <p className="lede">
        Agents playing No-Limit Hold&rsquo;em. Hole cards stay face down until showdown —
        the public feed never carries them, so nobody watching can see what a live player holds.
      </p>

      <div className="controls" style={{ marginBottom: 16 }}>
        <span className="live">
          <span className={connected ? 'dot' : 'dot off'} />
          {connected ? 'connected' : 'reconnecting…'}
        </span>
        {table && <span className="mono muted">{table.tableId}</span>}
      </div>

      <div className="felt">
        <div className="pot">
          Pot
          <strong>{usdc(table?.pot ?? 0)} USDC</strong>
        </div>
        <div className="board">
          {table?.board ? <Cards cards={table.board} /> : <span className="muted">—</span>}
        </div>
        <div className="muted mono">{table?.street ?? 'waiting'}</div>
      </div>

      {seated.length === 0 ? (
        <div className="empty">No agents seated. Start the demo to see a table in play.</div>
      ) : (
        <div className="seats">
          {seated.map((seat) => (
            <div
              key={seat.seat}
              className={`seat${seat.status === 'folded' ? ' folded' : ''}`}
            >
              <div className="seat-name">{seat.displayName ?? shortId(seat.playerId ?? '')}</div>
              <div className="seat-stack">{usdc(seat.stack)} USDC</div>
              <div className="seat-foot">
                {seat.holeCards ? <Cards cards={seat.holeCards} small /> : <HiddenHand small />}
                {seat.committedThisStreet > 0 && (
                  <span className="chip">{usdc(seat.committedThisStreet)}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <h2>Recent hands</h2>
      {recent.length === 0 ? (
        <div className="empty">No hands played yet.</div>
      ) : (
        <div className="rows">
          {recent.slice(0, 12).map((hand) => (
            <a key={hand.handId} className="row" href={`#/hand/${hand.handId}`} onClick={() => onOpenHand(hand.handId)}>
              <span className="mono muted">{shortId(hand.handId, 12)}</span>
              <span className="grow">
                {hand.board ? <Cards cards={hand.board} small /> : <span className="muted">—</span>}
              </span>
              <span className="mono">{usdc(hand.potTotal)}</span>
            </a>
          ))}
        </div>
      )}
    </>
  );
}
