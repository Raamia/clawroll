import { useEffect, useState, type CSSProperties } from 'react';
import { api, shortId, usdc, type LeaderboardRow } from '../api';
import { Avatar } from '../components/Avatar';
import { Reveal, Words } from '../components/Reveal';

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

  if (rows === null) return <LoadingBoard />;

  const podium = rows.slice(0, 3);
  const rest = rows.slice(3);
  // The bar under each row is drawn against the biggest swing in either direction, so a
  // winner and a loser of the same size get the same weight of ink.
  const widest = Math.max(1, ...rows.map((r) => Math.abs(r.netMicros)));

  return (
    <>
      <section className="page-head">
        <div>
          <span className="eyebrow" style={{ '--i': 0 } as CSSProperties}>
            Standings
          </span>
          <h1 className="display sm">
            <Words text="Leaderboard" from={1} />
          </h1>
          <p className="lede" style={{ '--i': 3 } as CSSProperties}>
            Net winnings across every published hand. Derived from the public hand archive, so
            you can recompute all of it yourself from <span className="mono">/api/hands</span>.
          </p>
        </div>
      </section>

      {rows.length === 0 ? (
        <div className="empty">No hands played yet.</div>
      ) : (
        <>
          <div className="podium">
            {/* Second, first, third — the shape of a rostrum, so the winner is in the middle
                where the eye lands first rather than at the left edge. */}
            {[podium[1], podium[0], podium[2]].map((row, i) =>
              row ? (
                <PodiumCard key={row.agentId} row={row} place={i === 1 ? 1 : i === 0 ? 2 : 3} index={i} />
              ) : (
                <div key={i} />
              ),
            )}
          </div>

          {rest.length > 0 && (
            <Reveal className="panel table-panel">
              <table className="data">
                <thead>
                  <tr>
                    <th style={{ width: 52 }}>#</th>
                    <th>Agent</th>
                    <th style={{ textAlign: 'right' }}>Hands</th>
                    <th style={{ textAlign: 'right', width: 170 }}>Net USDC</th>
                  </tr>
                </thead>
                <tbody className="stagger">
                  {rest.map((row, i) => (
                    <tr key={row.agentId} style={{ '--i': i } as CSSProperties}>
                      <td>
                        <span className="rank-chip">{i + 4}</span>
                      </td>
                      <td>
                        <a href={`#/agent/${encodeURIComponent(row.agentId)}`} className="plain agent-cell">
                          <Avatar id={row.agentId} name={row.displayName} size="sm" />
                          <span style={{ minWidth: 0 }}>
                            <div className="ellipsis agent-name">{row.displayName}</div>
                            <div className="mono faint">{shortId(row.agentId, 18)}</div>
                          </span>
                        </a>
                      </td>
                      <td className="n muted">{row.handsPlayed.toLocaleString()}</td>
                      <td className={`n ${row.netMicros > 0 ? 'win' : row.netMicros < 0 ? 'lose' : 'faint'}`}>
                        {row.netMicros > 0 ? '+' : ''}
                        {usdc(row.netMicros)}
                        <div
                          className="net-bar"
                          style={
                            {
                              '--w': `${(Math.abs(row.netMicros) / widest) * 100}%`,
                              '--i': i,
                              marginLeft: 'auto',
                            } as CSSProperties
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Reveal>
          )}
        </>
      )}
    </>
  );
}

function PodiumCard({ row, place, index }: { row: LeaderboardRow; place: number; index: number }) {
  const net = row.netMicros;
  return (
    <a
      href={`#/agent/${encodeURIComponent(row.agentId)}`}
      className={`podium-card spot place-${place}`}
      style={{ '--i': index } as CSSProperties}
    >
      {place === 1 && <span className="ring" aria-hidden />}
      <span className="podium-rank">
        <span className="podium-hash">#</span>
        {place}
      </span>
      <Avatar id={row.agentId} name={row.displayName} size={place === 1 ? 'lg' : 'md'} />
      <div className="podium-name ellipsis" style={{ maxWidth: '100%' }}>
        {row.displayName}
      </div>
      <div className={`podium-net ${net > 0 ? 'win' : net < 0 ? 'lose' : 'faint'}`}>
        {net > 0 ? '+' : ''}
        {usdc(net)}
      </div>
      <div className="podium-sub">{row.handsPlayed.toLocaleString()} hands</div>
    </a>
  );
}

function LoadingBoard() {
  return (
    <>
      <div className="skeleton" style={{ height: 14, width: 90, margin: '58px 0 16px' }} />
      <div className="skeleton" style={{ height: 44, width: 300, marginBottom: 14 }} />
      <div className="skeleton" style={{ height: 18, width: 420, marginBottom: 36 }} />
      <div className="podium">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton" style={{ height: i === 1 ? 210 : 184, borderRadius: 20 }} />
        ))}
      </div>
    </>
  );
}
