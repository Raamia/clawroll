import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, shortId, usdc, type HandRecord } from '../api';
import { PokerTable, type PodView, type TableView } from '../components/Table';
import { Avatar } from '../components/Avatar';
import { Cards, HiddenHand } from '../components/Cards';
import { Frame, Crumbs } from '../components/Frame';
import { Reveal, Words } from '../components/Reveal';
import { useReducedMotion } from '../hooks';
import { actionLabel } from '../ui';

/**
 * Hand replay.
 *
 * The record contains the ordered action log, so the betting can be stepped through exactly
 * as it happened — no reconstruction, no guessing. What this page adds is the state *between*
 * the lines of that log: stacks, bets on the cloth, who is next to act. All of it is derived
 * from the archive by `stateAt` below, which means the replay cannot drift from the record.
 *
 * Hole cards appear only where the archive has them, which is only where they were actually
 * shown at showdown. A hand that was folded out stays face down here for ever.
 */

const SPEEDS = [
  { label: '0.5×', ms: 2000 },
  { label: '1×', ms: 1100 },
  { label: '2×', ms: 550 },
] as const;

export function Hand({ handId }: { handId: string }) {
  const [hand, setHand] = useState<HandRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [sweeping, setSweeping] = useState(false);
  const reduced = useReducedMotion();
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setHand(null);
    setError(null);
    setStep(0);
    setPlaying(false);
    api.hand(handId).then(setHand).catch((e: Error) => setError(e.message));
  }, [handId]);

  const total = hand?.actions.length ?? 0;
  const atEnd = step >= total;

  // Autoplay. Deliberately a step at a time rather than a smooth clock: the record is a list
  // of discrete decisions, and playing it as anything else would invent timing that was
  // never recorded.
  useEffect(() => {
    if (!playing || atEnd) return;
    const timer = setTimeout(() => setStep((s) => Math.min(total, s + 1)), SPEEDS[speed]!.ms);
    return () => clearTimeout(timer);
  }, [playing, step, atEnd, total, speed]);

  useEffect(() => {
    if (atEnd) setPlaying(false);
  }, [atEnd]);

  const jump = useCallback((to: number) => {
    setStep(to);
    setPlaying(false);
  }, []);

  // The controls a video player would have, on the keys they live on there.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === 'ArrowRight') setStep((s) => Math.min(total, s + 1));
      else if (event.key === 'ArrowLeft') setStep((s) => Math.max(0, s - 1));
      else if (event.key === 'Home') jump(0);
      else if (event.key === 'End') jump(total);
      else if (event.key === ' ') {
        event.preventDefault();
        setPlaying((p) => !p);
      } else return;
      if (event.key.startsWith('Arrow')) setPlaying(false);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [total, jump]);

  const state = useMemo(() => (hand ? stateAt(hand, step) : null), [hand, step]);

  // Chips sweep in when a street closes, exactly as they do on the live felt.
  const street = state?.street ?? '';
  useEffect(() => {
    if (reduced || !street) return;
    setSweeping(true);
    const timer = setTimeout(() => setSweeping(false), 550);
    return () => clearTimeout(timer);
  }, [street, reduced]);

  // Keep the acting line in view while the hand plays itself.
  useEffect(() => {
    if (!playing) return;
    logRef.current?.querySelector('.log-row.now')?.scrollIntoView({ block: 'nearest' });
  }, [step, playing]);

  if (error) return <div className="empty" style={{ marginTop: 60 }}>Could not load hand: {error}</div>;
  if (!hand || !state) return <LoadingHand />;

  const view = toView(hand, state, sweeping);
  const potTotal = hand.pots.reduce((sum, p) => sum + p.amount, 0);

  return (
    <>
      <section className="page-head">
        <div style={{ minWidth: 0 }}>
          <span className="eyebrow" style={{ '--i': 0 } as CSSProperties}>
            Replay
          </span>
          {/* The headline is what the hand was worth in the end, not what is in the middle at
              this instant — the felt already shows that, and it moves. */}
          <h1 className="display sm">
            <Words text={usdc(potTotal)} from={1} />{' '}
            <span className="muted" style={{ fontSize: '0.5em', fontWeight: 500 }}>
              <Words text="USDC pot" from={2} />
            </span>
          </h1>
          <p className="idline mono" style={{ '--i': 4 } as CSSProperties}>
            {hand.handId}
          </p>
        </div>
        <a className="btn primary" href={`#/verify/${hand.handId}`} style={{ '--i': 5 } as CSSProperties}>
          Verify this hand
        </a>
      </section>

      <Frame
        title={<Crumbs parts={['clawroll', 'replay', hand.tableId]} />}
        status={atEnd ? 'complete' : playing ? 'playing' : `step ${step} / ${total}`}
        live={playing}
        foot={
          <div className="replay-bar">
            <div className="transport">
              <button className="btn icon" onClick={() => jump(0)} disabled={step === 0} title="Start (Home)" aria-label="Start">
                <SkipIcon flip />
              </button>
              <button
                className="btn icon"
                onClick={() => jump(Math.max(0, step - 1))}
                disabled={step === 0}
                title="Back (←)"
                aria-label="Back one action"
              >
                <StepIcon flip />
              </button>
              <button
                className={playing ? 'btn play playing' : 'btn play'}
                onClick={() => (atEnd ? (setStep(0), setPlaying(true)) : setPlaying((p) => !p))}
                title="Play / pause (space)"
                aria-label={atEnd ? 'Replay' : playing ? 'Pause' : 'Play'}
              >
                {atEnd ? <ReplayIcon /> : playing ? <PauseIcon /> : <PlayIcon />}
              </button>
              <button
                className="btn icon"
                onClick={() => jump(Math.min(total, step + 1))}
                disabled={atEnd}
                title="Forward (→)"
                aria-label="Forward one action"
              >
                <StepIcon />
              </button>
              <button className="btn icon" onClick={() => jump(total)} disabled={atEnd} title="End (End)" aria-label="End">
                <SkipIcon />
              </button>
            </div>

            <div className="scrub">
              <input
                type="range"
                min={0}
                max={total}
                value={step}
                onChange={(e) => jump(Number(e.target.value))}
                style={{ '--pct': `${total === 0 ? 100 : (step / total) * 100}%` } as CSSProperties}
                aria-label="Replay position"
              />
              <span className="scrub-count">
                {step} / {total}
              </span>
            </div>

            <div className="segmented">
              {SPEEDS.map((s, i) => (
                <button key={s.label} className={i === speed ? 'on' : ''} onClick={() => setSpeed(i)}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        }
      >
        <PokerTable view={view} />
      </Frame>

      <p className="keys">
        <kbd>←</kbd> <kbd>→</kbd> step · <kbd>space</kbd> play · <kbd>home</kbd> <kbd>end</kbd> jump
      </p>

      <div className="split">
        <Reveal as="section">
          <div className="section-head">
            <span className="eyebrow">{total} decisions</span>
            <h2>Action log</h2>
          </div>
          <div className="rows log" ref={logRef}>
            {hand.actions.map((action, i) => {
              const seat = hand.seats.find((s) => s.seat === action.seat);
              const say = actionLabel(action.action, action.amount, 1);
              const when = i < step ? 'past' : i === step ? 'now' : '';
              return (
                <div
                  key={i}
                  className={`log-row ${when}`}
                  onClick={() => jump(i + 1)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && jump(i + 1)}
                >
                  <span className="log-street">{action.street}</span>
                  <Avatar id={seat?.agentId ?? String(action.seat)} size="sm" />
                  <span className="grow ellipsis" style={{ fontSize: 13 }}>
                    {seat ? shortId(seat.agentId, 22) : `seat ${action.seat}`}
                  </span>
                  <span className={`log-verb ${say.kind}`}>{action.action}</span>
                  {action.amount > 0 && <span className="num" style={{ fontSize: 12.5 }}>{usdc(action.amount)}</span>}
                </div>
              );
            })}
          </div>
        </Reveal>

        <Reveal as="section" delay={90}>
          <div className="section-head">
            <span className="eyebrow">{hand.seats.length} seats</span>
            <h2>Result</h2>
          </div>
          <div className="rows stagger">
            {hand.seats.map((seat, i) => {
              const net = seat.finalStack - seat.startingStack;
              return (
                <a
                  key={seat.seat}
                  className="row result-row"
                  href={`#/agent/${encodeURIComponent(seat.agentId)}`}
                  style={{ '--i': i } as CSSProperties}
                >
                  <Avatar id={seat.agentId} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <div className="ellipsis agent-name">{shortId(seat.agentId, 26)}</div>
                    <div className="mono faint">
                      seat {seat.seat}
                      {seat.seat === hand.buttonSeat ? ' · button' : ''}
                    </div>
                  </span>
                  {seat.holeCards ? <Cards cards={seat.holeCards} size="sm" dealt={false} tight /> : <HiddenHand size="sm" />}
                  <span className="num result-stacks">
                    <span className="faint">{usdc(seat.startingStack)} →</span> {usdc(seat.finalStack)}
                  </span>
                  <span className={`num result-net ${net > 0 ? 'win' : net < 0 ? 'lose' : 'faint'}`}>
                    {net > 0 ? '+' : ''}
                    {usdc(net)}
                  </span>
                </a>
              );
            })}
          </div>
        </Reveal>
      </div>
    </>
  );
}

function LoadingHand() {
  return (
    <>
      <div className="skeleton" style={{ height: 14, width: 70, margin: '58px 0 16px' }} />
      <div className="skeleton" style={{ height: 44, width: 260, marginBottom: 30 }} />
      <div className="skeleton" style={{ height: 420, borderRadius: 22 }} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Transport icons
// ---------------------------------------------------------------------------

function PlayIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path d="M6 4.3v11.4c0 .8.9 1.3 1.6.9l9-5.7c.6-.4.6-1.4 0-1.8l-9-5.7c-.7-.4-1.6.1-1.6.9Z" />
    </svg>
  );
}
function PauseIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <rect x="4.5" y="4" width="4" height="12" rx="1.2" />
      <rect x="11.5" y="4" width="4" height="12" rx="1.2" />
    </svg>
  );
}
function ReplayIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 10a6 6 0 1 0 1.8-4.3" />
      <path d="M4 3.5V7h3.5" />
    </svg>
  );
}
function StepIcon({ flip }: { flip?: boolean | undefined }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden style={flip ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M6 5.2v9.6c0 .7.8 1.1 1.4.7l7-4.8c.5-.4.5-1.1 0-1.5l-7-4.8c-.6-.4-1.4 0-1.4.8Z" />
    </svg>
  );
}
function SkipIcon({ flip }: { flip?: boolean | undefined }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden style={flip ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M4 5.2v9.6c0 .7.8 1.1 1.4.7l6.4-4.8c.5-.4.5-1.1 0-1.5L5.4 4.4C4.8 4 4 4.4 4 5.2Z" />
      <rect x="13.5" y="4.5" width="2.5" height="11" rx="1" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Replay state
// ---------------------------------------------------------------------------

interface ReplayState {
  street: string;
  pot: number;
  stacks: Map<number, number>;
  bets: Map<number, number>;
  folded: Set<number>;
  allin: Set<number>;
  acting: number | null;
  finished: boolean;
}

/**
 * The table as it stood after `step` actions.
 *
 * Rebuilt from scratch on every step rather than accumulated, so scrubbing backwards is
 * exactly as correct as playing forwards — a replay that only worked in one direction would
 * be a subtly different hand depending on how you arrived at a moment in it.
 *
 * The blinds are posted here because the archived action log does not contain them: it
 * records decisions, and a blind is not one. Heads-up the button *is* the small blind, which
 * mirrors `dealHand` in `@clawroll/poker`.
 */
function stateAt(hand: HandRecord, step: number): ReplayState {
  const order = [...hand.seats].sort((a, b) => a.seat - b.seat);
  const stacks = new Map(order.map((s) => [s.seat, s.startingStack]));
  const bets = new Map(order.map((s) => [s.seat, 0]));
  const folded = new Set<number>();
  const allin = new Set<number>();

  const after = (seat: number): number => {
    const i = order.findIndex((s) => s.seat === seat);
    return order[(i + 1) % order.length]!.seat;
  };
  const put = (seat: number, amount: number) => {
    const have = stacks.get(seat) ?? 0;
    const paid = Math.min(have, amount);
    stacks.set(seat, have - paid);
    bets.set(seat, (bets.get(seat) ?? 0) + paid);
    if (have - paid === 0) allin.add(seat);
  };

  const headsUp = order.length === 2;
  const sb = headsUp ? hand.buttonSeat : after(hand.buttonSeat);
  put(sb, hand.smallBlind);
  put(after(sb), hand.bigBlind);

  let street = 'preflop';
  for (let i = 0; i < Math.min(step, hand.actions.length); i++) {
    const action = hand.actions[i]!;
    if (action.street !== street) {
      // A street closed: everything on the cloth is now in the middle.
      street = action.street;
      for (const seat of bets.keys()) bets.set(seat, 0);
    }
    if (action.action === 'fold') folded.add(action.seat);
    else put(action.seat, action.amount);
  }

  const finished = step >= hand.actions.length;
  const next = hand.actions[step];
  if (!finished && next && next.street !== street) {
    street = next.street;
    for (const seat of bets.keys()) bets.set(seat, 0);
  }

  // Everything wagered so far, which is what the engine means by "pot".
  const pot = order.reduce((sum, s) => sum + (s.startingStack - (stacks.get(s.seat) ?? 0)), 0);

  return {
    street: finished ? 'complete' : street,
    pot,
    stacks,
    bets,
    folded,
    allin,
    acting: finished ? null : (next?.seat ?? null),
    finished,
  };
}

function toView(hand: HandRecord, state: ReplayState, sweeping: boolean): TableView {
  const won = new Map<number, number>();
  for (const award of hand.awards) won.set(award.seat, (won.get(award.seat) ?? 0) + award.amount);

  const maxSeats = Math.max(...hand.seats.map((s) => s.seat)) + 1;
  const seats: PodView[] = hand.seats.map((s) => ({
    seat: s.seat,
    playerId: s.agentId,
    name: shortId(s.agentId, 14),
    stack: state.finished ? s.finalStack : (state.stacks.get(s.seat) ?? 0),
    // Once the hand is over there is nothing on the cloth: the last street's bets have been
    // pulled in, which is exactly what the pot in the middle is now showing.
    bet: state.finished ? 0 : (state.bets.get(s.seat) ?? 0),
    status: state.folded.has(s.seat) ? 'folded' : state.allin.has(s.seat) ? 'allin' : 'active',
    // Shown only at the end, and only where the archive has them — mid-replay every hand is
    // face down, exactly as it was to anyone watching at the time.
    holeCards: state.finished ? s.holeCards : null,
    isButton: s.seat === hand.buttonSeat,
    isActing: state.acting === s.seat,
    won: state.finished ? (won.get(s.seat) ?? 0) : 0,
    showdown: null,
    say: null,
  }));

  return {
    seats,
    maxSeats,
    board: hand.board,
    pot: state.pot,
    street: state.street,
    sweeping,
    // A replay has no next hand to move on to, so what was won stays on screen instead of
    // announcing itself and fading the way it does on the live felt.
    hold: state.finished,
    handId: hand.handId,
    label: hand.tableId,
    awards: state.finished ? hand.awards.map((a) => ({ seat: a.seat, amount: a.amount })) : [],
  };
}
