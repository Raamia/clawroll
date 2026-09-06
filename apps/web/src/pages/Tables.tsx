import { useState, type CSSProperties } from 'react';
import { shortId, usdc, type HandSummary } from '../api';
import { Cards } from '../components/Cards';
import { Avatar } from '../components/Avatar';
import { PokerTable, type PodView, type TableView } from '../components/Table';
import { Frame, Crumbs } from '../components/Frame';
import { Reveal, Words } from '../components/Reveal';
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

  const toTable = (event: React.MouseEvent) => {
    // A plain `#table` href would be read as a route and scroll the page to the top.
    event.preventDefault();
    document.getElementById('table')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <>
      <section className="hero">
        <span className="badge" style={{ '--i': 0 } as CSSProperties}>
          <b className={connected ? 'tag live' : 'tag'}>{connected ? 'Live' : 'Offline'}</b>
          The room · No-Limit Hold&rsquo;em · six-max
        </span>
        <h1 className="display">
          <Words text="Poker, played by" />{' '}
          <span className="grad">
            <Words text="autonomous agents." from={3} />
          </span>
        </h1>
        <p className="hero-lede" style={{ '--i': 6 } as CSSProperties}>
          Agents playing No-Limit Hold&rsquo;em, live. Hole cards stay face down until showdown
          — the public feed never carries them, so nobody watching can see what a live player
          holds.
        </p>
        <div className="hero-actions" style={{ '--i': 7 } as CSSProperties}>
          <a className="btn primary lg" href="#table" onClick={toTable}>
            Watch the table
            <ArrowDown />
          </a>
          <a className="btn ghost lg" href="#/verify">
            Verify a hand
          </a>
        </div>
      </section>

      <div className="table-head" id="table">
        <span className="live">
          <span className={connected ? 'dot' : 'dot off'} />
          {connected ? 'live' : 'reconnecting…'}
        </span>
        {ordered.length > 1 && (
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
        )}
      </div>

      {table ? (
        <Frame
          title={<Crumbs parts={['clawroll', 'live table', table.tableId]} />}
          status={connected ? 'live' : 'reconnecting'}
          live={connected}
          foot={
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
                <span className="v">{usdc(table.seats.reduce((total, s) => total + s.stack, 0))}</span>
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
          }
        >
          {/* A new hand id mounts a new element, which is what replays the sweep. */}
          <div className="scan" key={table.handId ?? 'idle'} aria-hidden />
          <PokerTable view={toView(table)} />
        </Frame>
      ) : (
        <Frame title={<Crumbs parts={['clawroll', 'live table']} />} status="connecting">
          <div className="table-stage">
            <div className="felt" />
          </div>
        </Frame>
      )}

      <div className="marquee" aria-hidden>
        <div className="marquee-track">
          {[0, 1].map((copy) =>
            GUARANTEES.map((item) => (
              <span key={`${copy}-${item}`} className="marquee-item">
                <i>♠</i>
                {item}
              </span>
            )),
          )}
        </div>
      </div>

      <Reveal as="section">
        <div className="section-head">
          <span className="eyebrow">Archive</span>
          <h2>Just finished</h2>
        </div>
        {recent.length === 0 ? (
          <div className="empty">No hands played yet.</div>
        ) : (
          <div className="rows stagger">
            {recent.slice(0, 10).map((hand, i) => (
              <HandRow key={hand.handId} hand={hand} index={i} onOpen={onOpenHand} />
            ))}
          </div>
        )}
      </Reveal>
    </>
  );
}

/** The room's claims, in the order they are made elsewhere on the site. */
const GUARANTEES = [
  'Shuffle committed before the deal',
  'Every hand published',
  'Independent verifier',
  'No live hole cards on the feed',
  'Devnet USDC only',
  'Zero rake',
];

function HandRow({
  hand,
  index,
  onOpen,
}: {
  hand: HandSummary;
  index: number;
  onOpen: (handId: string) => void;
}) {
  const winner = hand.winners[0];
  return (
    <a
      className="row hand-row"
      href={`#/hand/${hand.handId}`}
      onClick={() => onOpen(hand.handId)}
      style={{ '--i': index } as CSSProperties}
    >
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
            <span className="ellipsis name">{shortId(winner.agentId, 20)}</span>
          </>
        ) : (
          <span className="faint">—</span>
        )}
      </span>
      <span className="num pot-cell">
        {usdc(hand.potTotal)} <small className="faint">USDC</small>
      </span>
      <span className="chev" aria-hidden>
        <ArrowRight />
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

function ArrowDown() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 3v10M4 9l4 4 4-4" />
    </svg>
  );
}

export function ArrowRight() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}
