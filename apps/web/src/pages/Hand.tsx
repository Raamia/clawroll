import { useEffect, useMemo, useState } from 'react';
import { api, shortId, usdc, type HandRecord } from '../api';
import { Cards, HiddenHand } from '../components/Cards';

/**
 * Hand replay.
 *
 * The record contains the ordered action log, so the betting can be stepped through exactly
 * as it happened — no reconstruction, no guessing. Hole cards appear only where the archive
 * has them, which is only where they were actually shown at showdown.
 */
export function Hand({ handId }: { handId: string }) {
  const [hand, setHand] = useState<HandRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);

  useEffect(() => {
    setHand(null);
    setError(null);
    setStep(0);
    api.hand(handId).then(setHand).catch((e: Error) => setError(e.message));
  }, [handId]);

  const streets = useMemo(() => {
    if (!hand) return [];
    // How much board is visible at each point in the replay.
    const visible: Record<string, number> = {
      preflop: 0, flop: 3, turn: 4, river: 5, showdown: 5, complete: 5,
    };
    return hand.actions.map((a) => visible[a.street] ?? 0);
  }, [hand]);

  if (error) return <div className="empty">Could not load hand: {error}</div>;
  if (!hand) return <div className="empty">Loading…</div>;

  const boardCards = hand.board ? hand.board.split(' ') : [];
  const shown = step === 0 ? 0 : (streets[step - 1] ?? boardCards.length);
  const visibleBoard = boardCards.slice(0, step >= hand.actions.length ? boardCards.length : shown);
  const atEnd = step >= hand.actions.length;

  const netFor = (seat: HandRecord['seats'][number]) => seat.finalStack - seat.startingStack;

  return (
    <>
      <h1>Hand replay</h1>
      <p className="lede mono">{hand.handId}</p>

      <div className="felt">
        <div className="board">
          {visibleBoard.length > 0 ? (
            <Cards cards={visibleBoard.join(' ')} />
          ) : (
            <span className="muted">pre-flop</span>
          )}
        </div>
        <div className="muted mono">
          {atEnd ? 'showdown' : (hand.actions[step]?.street ?? 'preflop')} · action {step} of{' '}
          {hand.actions.length}
        </div>
      </div>

      <div className="controls" style={{ marginBottom: 20 }}>
        <button className="btn" onClick={() => setStep(0)} disabled={step === 0}>
          ⏮ start
        </button>
        <button className="btn" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
          ◀ back
        </button>
        <button
          className="btn primary"
          onClick={() => setStep((s) => Math.min(hand.actions.length, s + 1))}
          disabled={atEnd}
        >
          step ▶
        </button>
        <button className="btn" onClick={() => setStep(hand.actions.length)} disabled={atEnd}>
          end ⏭
        </button>
        <a className="btn" href={`#/verify/${hand.handId}`}>verify this hand</a>
      </div>

      <div className="seats">
        {hand.seats.map((seat) => {
          const net = netFor(seat);
          return (
            <div key={seat.seat} className="seat">
              <div className="seat-name">
                <a href={`#/agent/${encodeURIComponent(seat.agentId)}`} className="plain ellipsis">
                  {shortId(seat.agentId, 14)}
                </a>
              </div>
              <div className="seat-stack">
                {usdc(seat.startingStack)} → {usdc(seat.finalStack)}{' '}
                <span className={net > 0 ? 'win' : net < 0 ? 'lose' : 'muted'}>
                  {net > 0 ? '+' : ''}
                  {usdc(net)}
                </span>
              </div>
              <div className="seat-foot">
                {/* Only shown if it was shown. A folded hand stays face down forever. */}
                {seat.holeCards ? <Cards cards={seat.holeCards} small /> : <HiddenHand small />}
                {seat.seat === hand.buttonSeat && <span className="chip">button</span>}
              </div>
            </div>
          );
        })}
      </div>

      <h2>Action log</h2>
      <div className="rows">
        {hand.actions.map((action, i) => (
          <div
            key={i}
            className="row"
            style={{ opacity: i < step ? 1 : 0.35, cursor: 'pointer' }}
            onClick={() => setStep(i + 1)}
          >
            <span className="mono muted" style={{ width: 60 }}>{action.street}</span>
            <span className="grow">
              seat {action.seat} <strong>{action.action}</strong>
            </span>
            {action.amount > 0 && <span className="mono">{usdc(action.amount)}</span>}
          </div>
        ))}
      </div>
    </>
  );
}
