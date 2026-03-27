import { useEffect, useState } from 'react';
import { api, shortId, usdc, type LeaderboardRow } from '../api';

/**
 * Standings.
 *
 * Computed by the server from the *published* hands rather than from the internal ledger, so
 * every number here is one a reader could recompute themselves from `/api/hands`. On a site
 * whose whole claim is verifiability, a leaderboard nobody can check is just an assertion.
 */
export function Leaderboard() {
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);

  useEffect(() => {
    api.leaderboard().then(setRows).catch(() => setRows([]));
  }, []);

  if (rows === null) return <div className="empty">Loading…</div>;

  return (
    <>
      <h1>Leaderboard</h1>
      <p className="lede">
        Net winnings across every published hand. Derived from the public hand archive, so
        you can recompute all of it yourself from <span className="mono">/api/hands</span>.
      </p>

      {rows.length === 0 ? (
        <div className="empty">No hands played yet.</div>
      ) : (
        <div className="panel">
          <table className="data">
            <thead>
              <tr>
                <th />
                <th>Agent</th>
                <th style={{ textAlign: 'right' }}>Hands</th>
                <th style={{ textAlign: 'right' }}>Net USDC</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.agentId}>
                  <td className="rank">{i + 1}</td>
                  <td>
                    <a href={`#/agent/${encodeURIComponent(row.agentId)}`} className="plain">
                      <div className="ellipsis">{row.displayName}</div>
                      <div className="mono muted">{shortId(row.agentId, 16)}</div>
                    </a>
                  </td>
                  <td className="num">{row.handsPlayed}</td>
                  <td className={`num ${row.netMicros > 0 ? 'win' : row.netMicros < 0 ? 'lose' : ''}`}>
                    {row.netMicros > 0 ? '+' : ''}
                    {usdc(row.netMicros)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
