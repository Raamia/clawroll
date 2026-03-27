import { useEffect, useState } from 'react';
import { Tables } from './pages/Tables';
import { Hand } from './pages/Hand';
import { Leaderboard } from './pages/Leaderboard';
import { Verify } from './pages/Verify';
import { Agent } from './pages/Agent';

/**
 * Hash routing, on purpose.
 *
 * The app is a static bundle behind CloudFront. Hash routes need no server-side rewrite
 * rule, so a deep link to a hand replay works from a plain S3 origin with nothing configured
 * — and a shared link to a specific hand is the main way anyone will arrive here.
 */
type Route =
  | { name: 'tables' }
  | { name: 'hand'; handId: string }
  | { name: 'leaderboard' }
  | { name: 'agent'; agentId: string }
  | { name: 'verify'; handId: string | null };

function parse(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const [head, param] = path.split('/');
  if (head === 'hand' && param) return { name: 'hand', handId: decodeURIComponent(param) };
  if (head === 'agent' && param) return { name: 'agent', agentId: decodeURIComponent(param) };
  if (head === 'verify') return { name: 'verify', handId: param ? decodeURIComponent(param) : null };
  if (head === 'leaderboard') return { name: 'leaderboard' };
  return { name: 'tables' };
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parse(location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parse(location.hash));
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);

  const link = (href: string, label: string, active: boolean) => (
    <a href={href} className={active ? 'active' : ''}>
      {label}
    </a>
  );

  return (
    <>
      <header className="top">
        <div className="top-inner">
          <a href="#/" className="brand">
            claw<span>roll</span>
          </a>
          {/* Stated everywhere, not buried in a footer: this is play money by design. */}
          <span className="devnet" title="Devnet USDC is faucet-issued and has no market value">
            Solana devnet
          </span>
          <nav>
            {link('#/', 'Table', route.name === 'tables')}
            {link('#/leaderboard', 'Leaderboard', route.name === 'leaderboard')}
            {link('#/verify', 'Verify', route.name === 'verify')}
          </nav>
        </div>
      </header>

      <main className="shell">
        {route.name === 'tables' && (
          <Tables onOpenHand={(handId) => setRoute({ name: 'hand', handId })} />
        )}
        {route.name === 'hand' && <Hand handId={route.handId} />}
        {route.name === 'leaderboard' && <Leaderboard />}
        {route.name === 'agent' && <Agent agentId={route.agentId} />}
        {route.name === 'verify' && <Verify handId={route.handId} />}
      </main>
    </>
  );
}
