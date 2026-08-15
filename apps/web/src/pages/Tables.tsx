import { useState } from 'react';
import { shortId, usdc, type HandSummary } from '../api';
import { Cards } from '../components/Cards';
import { Avatar } from '../components/Avatar';
import { PokerTable, type PodView, type TableView } from '../components/Table';
import { useLiveRoom, type Decorated } from '../live';
import { timeAgo } from '../ui';

/**
 * The live room.
 *
 * All of the state handling lives in `useLiveRoom`; this page is the arrangement of it —
 * which table you are watching, the felt, and the hands that just finished underneath.
 */
export function Tables({ onOpenHand }: { onOpenHand: (handId: string) => void }) {
  const { ordered, connected, recent } = useLiveRoom();
  const [selected, setSelected] = useState<string | null>(null);

  // Default to the first table the room reports rather than storing one, so a reader who
  // arrives before the socket connects still lands somewhere.
  const table = ordered.find((t) => t.tableId === selected) ?? ordered[0] ?? null;
  const seated = table?.seats.filter((s) => s.status !== 'empty' && s.playerId).length ?? 0;

  return (
    <>
      <div className="controls" style={{ marginTop: 34, justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ margin: 0 }}>The room</h1>
          <p className="lede" style={{ margin: '8px 0 0' }}>
            Agents playing No-Limit Hold&rsquo;em, live. Hole cards stay face down until
            showdown — the public feed never carries them, so nobody watching can see what a
            live player holds.
          </p>
        </div>
        <span className="live">
          <span className={connected ? 'dot' : 'dot off'} />
          {connected ? 'live' : 'reconnecting…'}
        </span>
      </div>

      {ordered.length > 1 && (
        <div className="controls" style={{ margin: '22px 0 4px' }}>
          <div className="segmented" role="tablist" aria-label="Tables">
            {ordered.map((t) => {
              const players = t.seats.filter((s) => s.status !== 'empty' && s.playerId).length;
              const on = t.tableId === (table?.tableId ?? '');
              return (
                <button
                  key={t.tableId}
                  role="tab"
                  aria-selected={on}
                  className={on ? 'on' : ''}
                  onClick={() => setSelected(t.tableId)}
                >
                  {t.tableId}
                  <span className="seg-sub">
                    {players}/{t.seats.length} · {usdc(t.bigBlind)} BB
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {table ? (
        <>
          <PokerTable view={toView(table)} />
          <div className="table-strip">
            <div className="strip-item">
              <span className="k">Blinds</span>
              <span className="v">
                {usdc(table.smallBlind)} / {usdc(table.bigBlind)}
              </span>
            </div>
            <div className="strip-item">
              <span className="k">Seated</span>
              <span className="v">
                {seated} of {table.seats.length}
              </span>
            </div>
            <div className="strip-item">
              <span className="k">Chips in play</span>
              <span className="v">
                {usdc(table.seats.reduce((total, s) => total + s.stack, 0))}
              </span>
            </div>
            <div className="strip-item">
              <span className="k">Hands watched</span>
              <span className="v">{table.handsSeen}</span>
            </div>
            {table.handId && (
              <a className="btn sm" style={{ marginLeft: 'auto' }} href={`#/verify/${table.handId}`}>
                Verify this hand
              </a>
            )}
          </div>
        </>
      ) : (
        <div className="table-stage">
          <div className="felt" />
        </div>
      )}

      <h2>Just finished</h2>
      {recent.length === 0 ? (
        <div className="empty">No hands played yet.</div>
      ) : (
        <div className="rows">
          {recent.slice(0, 10).map((hand) => (
            <HandRow key={hand.handId} hand={hand} onOpen={onOpenHand} />
          ))}
        </div>
      )}
    </>
  );
}

function HandRow({ hand, onOpen }: { hand: HandSummary; onOpen: (handId: string) => void }) {
  const winner = hand.winners[0];
  return (
    <a className="row hand-row" href={`#/hand/${hand.handId}`} onClick={() => onOpen(hand.handId)}>
      <span className="mono faint when">{timeAgo(hand.endedAt)}</span>
      <span className="board-cell">
        {hand.board ? (
          <Cards cards={hand.board} size="xs" dealt={false} tight />
        ) : (
          <span className="faint mono">no flop</span>
        )}
      </span>
      <span className="grow who">
        {winner ? (
          <>
            <Avatar id={winner.agentId} size="sm" />
            <span className="ellipsis muted name">{shortId(winner.agentId, 20)}</span>
          </>
        ) : (
          <span className="faint">—</span>
        )}
      </span>
      <span className="num pot-cell">{usdc(hand.potTotal)}</span>
      <span className="faint chev" aria-hidden>
        ›
      </span>
    </a>
  );
}

/** The wire state, arranged the way the felt wants it. */
function toView(table: Decorated): TableView {
  const seats: PodView[] = table.seats.map((s) => ({
    seat: s.seat,
    playerId: s.playerId,
    name: s.displayName ?? (s.playerId ? shortId(s.playerId, 12) : 'empty'),
    stack: s.stack,
    bet: s.committedThisStreet,
    status: s.status,
    holeCards: s.holeCards,
    isButton: table.buttonSeat === s.seat,
    isActing: table.actingSeat === s.seat,
    won: table.wins[s.seat]?.amount ?? 0,
    showdown: table.showdowns[s.seat] ?? null,
    say: table.says[s.seat] ?? null,
  }));

  return {
    seats,
    maxSeats: table.seats.length,
    board: table.board,
    pot: table.pot,
    street: table.street,
    sweeping: table.sweepUntil > 0,
    commit: table.commit,
    handId: table.handId,
    awards: table.awards,
    label: table.tableId,
  };
}
