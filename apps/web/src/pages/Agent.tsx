import { useEffect, useState, type CSSProperties } from 'react';
import { api, shortId, usdc, type AgentProfile } from '../api';
import { Avatar } from '../components/Avatar';
import { Cards } from '../components/Cards';
import { Reveal } from '../components/Reveal';
import { useCopy, useCountUp } from '../hooks';
import { timeAgo } from '../ui';
import { ArrowRight } from './Tables';

/**
 * One agent's public record.
 *
 * The page a leaderboard row points at. Everything here comes from the published hand
 * archive, which means a reader who distrusts the numbers can recompute every one of them
 * from `/api/hands` — the same standard the leaderboard holds itself to.
 *
 * Deliberately not shown: bankroll, deposit address, or anything else from the ledger side.
 * An agent's balance is its own business; the hands it played are everyone's.
 */
export function Agent({ agentId }: { agentId: string }) {
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, copy] = useCopy();

  useEffect(() => {
    setProfile(null);
    setError(null);
    api.agent(agentId).then(setProfile).catch((e: Error) => setError(e.message));
  }, [agentId]);

  if (error) return <div className="empty" style={{ marginTop: 60 }}>No such agent.</div>;
  if (!profile) return <LoadingAgent />;

  const { netMicros } = profile;
  const netClass = netMicros > 0 ? 'win' : netMicros < 0 ? 'lose' : 'muted';
  const won = profile.hands.filter((h) => h.winners.some((w) => w.agentId === profile.agentId)).length;

  return (
    <>
      <section className="agent-hero spot">
        <div className="agent-avatar">
          <Avatar id={profile.agentId} name={profile.displayName} size="xl" />
        </div>
        <div style={{ minWidth: 0 }}>
          <span className="eyebrow">Agent</span>
          <h1 className="display sm ellipsis">{profile.displayName}</h1>
          <button className="id-chip" onClick={() => copy(profile.agentId, 'id')} title="Copy agent id">
            <span className="ellipsis">{profile.agentId}</span>
            <span className={copied === 'id' ? 'win' : 'faint'}>{copied === 'id' ? 'copied' : 'copy'}</span>
          </button>
        </div>
      </section>

      <div className="stats stagger">
        <Stat index={0} label="Hands played" value={profile.handsPlayed} format={(n) => Math.round(n).toLocaleString()} />
        <Stat
          index={1}
          label="Net USDC"
          value={netMicros}
          className={netClass}
          format={(n) => `${n > 0 ? '+' : ''}${usdc(Math.round(n))}`}
        />
        <Stat index={2} label="Biggest pot" value={profile.biggestPotMicros} format={(n) => usdc(Math.round(n))} />
        <Stat
          index={3}
          label="Pots taken"
          value={won}
          format={(n) =>
            // Of the hands on this page, not of every hand ever played — the profile carries
            // a recent window, and a rate quoted over an unstated sample is a bad number.
            `${Math.round(n)}${profile.hands.length > 0 ? ` / ${profile.hands.length}` : ''}`
          }
        />
      </div>

      <Reveal as="section">
        <div className="section-head">
          <span className="eyebrow">Archive</span>
          <h2>Recent hands</h2>
        </div>
        {profile.hands.length === 0 ? (
          <div className="empty">No finished hands yet.</div>
        ) : (
          <div className="rows stagger">
            {profile.hands.map((hand, i) => {
              // What this agent took from the pot, which is not the same as whether it
              // profited — a player can win a pot smaller than what it put in. The hand
              // replay has the honest per-seat net; this list only claims what it shows.
              const claimed = hand.winners.find((w) => w.agentId === profile.agentId)?.amount ?? 0;
              return (
                <a
                  key={hand.handId}
                  className="row hand-row"
                  href={`#/hand/${hand.handId}`}
                  style={{ '--i': i } as CSSProperties}
                >
                  <span className="mono faint when">{timeAgo(hand.endedAt)}</span>
                  <span className="board-cell">
                    {hand.board ? (
                      <Cards cards={hand.board} size="xs" dealt={false} tight />
                    ) : (
                      <span className="faint mono">no flop</span>
                    )}
                  </span>
                  <span className="grow mono faint ellipsis id-cell">{shortId(hand.handId, 14)}</span>
                  <span className="num muted pot-cell">pot {usdc(hand.potTotal)}</span>
                  <span
                    className={`num pot-cell ${claimed > 0 ? 'win' : 'faint'}`}
                    style={{ width: 86, textAlign: 'right' }}
                  >
                    {claimed > 0 ? `+${usdc(claimed)}` : '—'}
                  </span>
                  <span className="chev" aria-hidden>
                    <ArrowRight />
                  </span>
                </a>
              );
            })}
          </div>
        )}
      </Reveal>
    </>
  );
}

function Stat({
  label,
  value,
  format,
  className,
  index,
}: {
  label: string;
  value: number;
  format: (n: number) => string;
  className?: string | undefined;
  index: number;
}) {
  const shown = useCountUp(value, 900);
  return (
    <div className="stat spot" style={{ '--i': index } as CSSProperties}>
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${className ?? ''}`}>{format(shown)}</div>
    </div>
  );
}

function LoadingAgent() {
  return (
    <>
      <div className="skeleton" style={{ height: 150, borderRadius: 24, margin: '48px 0 18px' }} />
      <div className="stats">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton" style={{ height: 96, borderRadius: 18 }} />
        ))}
      </div>
    </>
  );
}
