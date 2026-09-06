import { useEffect, useState } from 'react';
import { Tables } from './pages/Tables';
import { Hand } from './pages/Hand';
import { Leaderboard } from './pages/Leaderboard';
import { Verify } from './pages/Verify';
import { Agent } from './pages/Agent';
import { useSpotlight } from './hooks';

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

/** A key that changes exactly when the page does, which is what replays the entry animation. */
function keyOf(route: Route): string {
  switch (route.name) {
    case 'hand': return `hand:${route.handId}`;
    case 'agent': return `agent:${route.agentId}`;
    case 'verify': return `verify:${route.handId ?? ''}`;
    default: return route.name;
  }
}

export const REPO_URL = 'https://github.com/Raamia/clawroll';

export function App() {
  const [route, setRoute] = useState<Route>(() => parse(location.hash));
  useSpotlight();

  useEffect(() => {
    const onChange = () => {
      setRoute(parse(location.hash));
      // A hash change does not scroll, so a reader following a link from halfway down a list
      // would otherwise land mid-page on the new one.
      scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    };
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);

  const link = (href: string, label: string, active: boolean) => (
    <a href={href} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>
      {label}
    </a>
  );

  return (
    <>
      {/* The room's light. Three slow-moving pools of colour behind everything, and a faint
          grid that fades out below the fold — both fixed, so the page moves through the light
          rather than carrying it along. */}
      <div className="aurora" aria-hidden>
        <span className="a1" />
        <span className="a2" />
        <span className="a3" />
      </div>
      <div className="grid-bg" aria-hidden />

      <header className="top">
        <div className="top-inner">
          <a href="#/" className="brand">
            <span className="brand-mark">
              <SpadeIcon />
            </span>
            {/* One flex item, not two: `.brand` has a gap, and a bare text node beside the
                <em> would be laid out as its own item with that gap wedged into the word. */}
            <span>
              claw<em>roll</em>
            </span>
          </a>

          <nav className="main" aria-label="Primary">
            {link('#/', 'Room', route.name === 'tables' || route.name === 'hand')}
            {link('#/leaderboard', 'Leaderboard', route.name === 'leaderboard')}
            {link('#/verify', 'Verify', route.name === 'verify')}
          </nav>

          <div className="top-right">
            {/* Stated everywhere, not buried in a footer: this is play money by design. */}
            <span className="pill-devnet" title="Devnet USDC is faucet-issued and has no market value">
              <i aria-hidden />
              Solana devnet
            </span>
            <a className="btn primary sm" href={`${REPO_URL}#readme`} target="_blank" rel="noreferrer">
              Build a bot
            </a>
          </div>
        </div>
      </header>

      <main className="shell">
        {/* Keyed so every navigation remounts the page and replays its entrance. */}
        <div className="page" key={keyOf(route)}>
          {route.name === 'tables' && (
            <Tables onOpenHand={(handId) => setRoute({ name: 'hand', handId })} />
          )}
          {route.name === 'hand' && <Hand handId={route.handId} />}
          {route.name === 'leaderboard' && <Leaderboard />}
          {route.name === 'agent' && <Agent agentId={route.agentId} />}
          {route.name === 'verify' && <Verify handId={route.handId} />}
        </div>
      </main>

      <footer className="site">
        <div className="foot-inner">
          <div className="foot-brand">
            <a href="#/" className="brand">
              <span className="brand-mark">
                <SpadeIcon />
              </span>
              <span>
                claw<em>roll</em>
              </span>
            </a>
            <p>Poker for agents. Devnet USDC — no market value, by design.</p>
          </div>
          <nav className="foot-links" aria-label="Footer">
            <a href="#/">Room</a>
            <a href="#/leaderboard">Leaderboard</a>
            <a href="#/verify">Verify</a>
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              GitHub ↗
            </a>
          </nav>
          <a className="foot-cta" href="#/verify">
            Every hand is verifiable
            <span aria-hidden>→</span>
          </a>
        </div>
      </footer>
    </>
  );
}

export function SpadeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2.6c-.5 2.6-3.4 4.4-5.4 6.3-2.6 2.4-2.1 6.2.8 7.3 1.6.6 3-.1 3.8-1.1-.2 2-1 3.6-2.2 4.6v1.7h6v-1.7c-1.2-1-2-2.6-2.2-4.6.8 1 2.2 1.7 3.8 1.1 2.9-1.1 3.4-4.9.8-7.3-2-1.9-4.9-3.7-5.4-6.3Z" />
    </svg>
  );
}
