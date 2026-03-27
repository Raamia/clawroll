import { useEffect, useState } from 'react';
import { api, usdc, type AgentProfile } from '../api';

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

  useEffect(() => {
    setProfile(null);
    setError(null);
    api.agent(agentId).then(setProfile).catch((e: Error) => setError(e.message));
  }, [agentId]);

  if (error) return <div className="empty">No such agent.</div>;
  if (!profile) return <div className="empty">Loading…</div>;

  const { netMicros } = profile;
  const netClass = netMicros > 0 ? 'win' : netMicros < 0 ? 'lose' : 'muted';

  return (
    <>
      <h1 className="ellipsis">{profile.displayName}</h1>
      <p className="lede mono">{profile.agentId}</p>

      <div className="stats">
        <div className="stat">
          <div className="stat-label">Hands played</div>
          <div className="stat-value">{profile.handsPlayed.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Net USDC</div>
          <div className={`stat-value ${netClass}`}>
            {netMicros > 0 ? '+' : ''}
            {usdc(netMicros)}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Biggest pot</div>
          <div className="stat-value">{usdc(profile.biggestPotMicros)}</div>
        </div>
      </div>

      <h2>Recent hands</h2>
      {profile.hands.length === 0 ? (
        <div className="empty">No finished hands yet.</div>
      ) : (
        <div className="rows">
          {profile.hands.map((hand) => {
            // What this agent took from the pot, which is not the same as whether it
            // profited — a player can win a pot smaller than what it put in. The hand
            // replay has the honest per-seat net; this list only claims what it shows.
            const won = hand.winners.find((w) => w.agentId === profile.agentId)?.amount ?? 0;
            return (
              <a key={hand.handId} className="row" href={`#/hand/${hand.handId}`}>
                <span className="mono muted" style={{ width: 92 }}>
                  {new Date(hand.endedAt).toLocaleTimeString()}
                </span>
                <span className="grow mono">{hand.board || <em className="muted">no flop</em>}</span>
                <span className="mono muted">pot {usdc(hand.potTotal)}</span>
                <span className={`mono ${won > 0 ? 'win' : 'muted'}`} style={{ width: 76, textAlign: 'right' }}>
                  {won > 0 ? `won ${usdc(won)}` : '—'}
                </span>
              </a>
            );
          })}
        </div>
      )}
    </>
  );
}
