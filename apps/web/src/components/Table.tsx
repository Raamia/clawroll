import type { CSSProperties } from 'react';
import { usdc } from '../api';
import { Cards, BoardSlots, HiddenHand } from './Cards';
import { Avatar } from './Avatar';
import { Chips } from './Chips';
import { useCountUp, usePulse } from '../hooks';
import { boardVisible, chipCount, seatOffset, seatPosition, type ActionKind } from '../ui';

/**
 * The felt.
 *
 * One component draws the table for both the live room and a replay, which is the point: a
 * hand being watched and the same hand read back an hour later should be the same picture,
 * because they are the same hand. The two pages differ only in where the view model comes
 * from — a WebSocket in one case, an archived record stepped through in the other.
 *
 * Seats are placed around an ellipse from their seat number rather than from their position
 * in the array, so an empty chair leaves a real gap and the button moving round the table is
 * something you can actually follow.
 */

export interface PodView {
  seat: number;
  /** Null for a seat nobody is in. Those are not drawn, but they still take up their place. */
  playerId: string | null;
  name: string;
  stack: number;
  bet: number;
  status: 'active' | 'folded' | 'allin' | 'sitting_out' | 'empty';
  holeCards: string | null;
  isButton: boolean;
  /** Believed to be thinking. Inferred, never asserted — see `useLiveRoom`. */
  isActing: boolean;
  /** Set once a hand is settled: what this seat took from the pot, and with what. */
  won: number;
  showdown: string | null;
  /** The last thing this seat did, while it is still worth saying out loud. */
  say: { kind: ActionKind; text: string; id: number } | null;
}

export interface TableView {
  seats: PodView[];
  maxSeats: number;
  board: string;
  pot: number;
  street: string;
  /** Chips are being pulled into the middle: the street just ended. */
  sweeping: boolean;
  /** Shown for a beat at the start of a hand. The shuffle was sealed before anyone spoke. */
  commit?: string | null | undefined;
  handId?: string | null | undefined;
  /** Seats currently being paid, for chips flying out of the middle. */
  awards?: { seat: number; amount: number }[] | undefined;
  /** Keep what each seat won on screen rather than letting it announce itself and fade. */
  hold?: boolean | undefined;
  label?: string | undefined;
}

/** Where a seat's chips sit: on its spoke, clear of the pod and short of the middle. */
const BET_RX = 26;
const BET_RY = 28;

export function PokerTable({ view }: { view: TableView }) {
  const pot = useCountUp(view.pot);
  const bumped = usePulse(view.pot);

  // Only as much board as the street has actually turned over. The live feed sends exactly
  // that much anyway, but a replay holds the whole board from the first frame and would
  // otherwise show the river while the hand is still pre-flop.
  const all = view.board ? view.board.split(' ').filter(Boolean) : [];
  const boardCards = all.slice(0, boardVisible(view.street));
  const missing = Math.max(0, 5 - boardCards.length);

  // Sorted by seat, always.
  //
  // Not cosmetic: `hand_start` carries the seats in its own order, and letting that reorder
  // the DOM moves the nodes — which restarts every CSS animation on them, leaving pods stuck
  // at the first frame of their entrance. Ordering by seat also makes the stagger below run
  // round the table rather than in whatever order the server happened to serialise.
  const occupied = [...view.seats]
    .filter((s) => s.playerId !== null && s.status !== 'empty')
    .sort((a, b) => a.seat - b.seat);
  // A six-max table with five agents at it has an empty chair, and drawing it says so — the
  // alternative is five pods spread evenly round the oval, which looks like a full table.
  const vacant = view.seats.filter((s) => s.playerId === null || s.status === 'empty');

  return (
    <div className="table-stage">
      <div className="felt">
        <div className="felt-mark">{view.label ?? 'clawroll'}</div>

        <div className="table-center">
          <div className={bumped ? 'pot bumped' : 'pot'}>
            <Chips amount={view.pot} count={chipCount(view.pot)} />
            <div>
              <div className="pot-label">Pot</div>
              <div className="pot-value">
                {usdc(Math.round(pot))}
                <small>USDC</small>
              </div>
            </div>
          </div>

          <div className="board">
            {boardCards.length > 0 && <Cards cards={boardCards.join(' ')} />}
            {missing > 0 && <BoardSlots count={missing} />}
          </div>

          <div className="street-tag">
            <b>{view.street === 'complete' ? 'hand over' : view.street}</b>
            {view.handId && <span className="raw">· {view.handId.slice(0, 10)}</span>}
          </div>
        </div>

        {/* Sealed before the first card and published after the last one. Worth a beat. */}
        {view.commit && (
          <div className="commit-flash" key={view.commit}>
            <LockIcon />
            shuffle committed · {view.commit.slice(0, 16)}…
          </div>
        )}

        {/* The pot going to whoever won it. Purely a flourish over the felt — the seat's own
            total is what actually says who was paid. */}
        {(view.awards ?? []).map((award) => {
          const { dx, dy } = seatOffset(award.seat, view.maxSeats);
          return (
            <div
              key={`${award.seat}-${award.amount}`}
              className="award-fly"
              style={{ '--dx': dx, '--dy': dy } as CSSProperties}
              aria-hidden
            >
              <Chips amount={award.amount} count={chipCount(award.amount)} />
            </div>
          );
        })}

        {/* Chips out in front of a seat, between it and the middle. */}
        {occupied
          .filter((s) => s.bet > 0)
          .map((s) => {
            // Between the seat and the middle, on the same spoke — chips a player has pushed
            // out but not yet lost sight of.
            const { x, y } = seatPosition(s.seat, view.maxSeats, BET_RX, BET_RY);
            // The same radii the chips are placed at, so sweeping them backwards lands them
            // in the middle rather than somewhere past it.
            const { dx, dy } = seatOffset(s.seat, view.maxSeats, BET_RX, BET_RY);
            return (
              <div
                key={s.seat}
                className={view.sweeping ? 'bet-stack sweeping' : 'bet-stack'}
                style={{
                  '--x': x,
                  '--y': y,
                  // Sweeping runs the seat→centre vector backwards, so the chips go where
                  // they would go on a real table rather than simply fading out.
                  '--dx': `calc(${dx} * -1)`,
                  '--dy': `calc(${dy} * -1)`,
                } as CSSProperties}
              >
                <Chips amount={s.bet} count={Math.min(3, chipCount(s.bet))} />
                {usdc(s.bet)}
              </div>
            );
          })}
      </div>

      {/* Below 900px these stop being positioned and flow into a grid instead — see the
          media query in styles.css. The wrapper exists only to give them a container there. */}
      <div className="pods-grid">
        {vacant.map((s) => {
          const { x, y } = seatPosition(s.seat, view.maxSeats);
          return (
            <div key={`empty-${s.seat}`} className="pod empty-seat" style={{ '--x': x, '--y': y } as CSSProperties}>
              <div className="pod-card">
                <span className="empty-chair" />
                <span className="muted" style={{ fontSize: 12 }}>
                  open seat
                </span>
              </div>
            </div>
          );
        })}
        {occupied.map((s) => (
          // The stagger runs off the seat number rather than the array index, so it stays put
          // when a seat empties instead of re-timing — and re-timing restarts the animation.
          <Pod key={s.seat} pod={s} maxSeats={view.maxSeats} index={s.seat} hold={view.hold} />
        ))}
      </div>

      {occupied.length === 0 && (
        <div className="empty" style={{ marginTop: 18 }}>
          No agents seated. Start the demo to see a table in play.
        </div>
      )}
    </div>
  );
}

function Pod({
  pod,
  maxSeats,
  index,
  hold,
}: {
  pod: PodView;
  maxSeats: number;
  index: number;
  hold?: boolean | undefined;
}) {
  const { x, y } = seatPosition(pod.seat, maxSeats);
  const stack = useCountUp(pod.stack, 500);

  const state = [
    'pod',
    pod.status === 'folded' ? 'folded' : '',
    pod.status === 'allin' ? 'allin' : '',
    pod.isActing ? 'acting' : '',
    pod.won > 0 ? 'winner' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={state} style={{ '--x': x, '--y': y, '--i': index } as CSSProperties}>
      {pod.say && (
        // Keyed by the action's own id so a second `call` in the same hand replays the
        // animation instead of sitting there already faded out.
        <div key={pod.say.id} className={`pod-say ${pod.say.kind}`}>
          {pod.say.text}
        </div>
      )}
      {pod.won > 0 && <div className={hold ? 'pod-won hold' : 'pod-won'}>+{usdc(pod.won)}</div>}

      <div className="pod-card">
        <div className="pod-badges">
          {pod.isButton && <span className="badge-dealer" title="dealer button">D</span>}
          {pod.status === 'allin' && <span className="badge-tiny allin">all in</span>}
        </div>

        <div className="pod-hole">
          {pod.holeCards ? <Cards cards={pod.holeCards} size="xs" tight /> : <HiddenHand size="xs" />}
        </div>

        <Avatar id={pod.playerId ?? pod.name} name={pod.name} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="pod-name ellipsis">
            {pod.playerId ? (
              <a href={`#/agent/${encodeURIComponent(pod.playerId)}`} className="plain">
                {pod.name}
              </a>
            ) : (
              pod.name
            )}
          </div>
          <div className="pod-stack">
            <b>{usdc(Math.round(stack))}</b> USDC
          </div>
        </div>
      </div>

      {pod.showdown && <div className="pod-showdown">{pod.showdown}</div>}
    </div>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
      <rect x="4" y="10" width="16" height="11" rx="2.5" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
