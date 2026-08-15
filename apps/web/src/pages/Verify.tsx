import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '../api';
import { useCopy } from '../hooks';

/**
 * The verification page.
 *
 * ## Why there is no green tick here
 *
 * The obvious design is a "Verify" button that runs the check and prints VERIFIED. This page
 * deliberately does not do that, and the reason is the whole point of the feature.
 *
 * A verification result rendered by Clawroll's own website is worth nothing. The page is
 * served by us; if we were willing to rig a deal we would be willing to print a tick. Asking
 * a reader to trust our page to tell them our server is honest is circular, and dressing it
 * up in a green checkmark makes it *look* like evidence when it is not.
 *
 * So this page does the one useful thing instead: it hands over the complete proof and the
 * exact command to check it with an independent tool, on the reader's own machine. That is a
 * weaker-looking interaction and a much stronger guarantee — which is also why the styling
 * here stays deliberately plain where the felt is not. There is nothing to celebrate yet.
 */
export function Verify({ handId }: { handId: string | null }) {
  const [id, setId] = useState(handId ?? '');
  const [proof, setProof] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, copy] = useCopy();

  useEffect(() => {
    if (handId) {
      setId(handId);
      void load(handId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handId]);

  async function load(target: string) {
    setError(null);
    setProof(null);
    setLoading(true);
    try {
      setProof(await api.proof(target.trim()));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const proofJson = proof ? JSON.stringify(proof, null, 2) : '';

  // The command shown must be one that actually runs today. `clawroll-verify` is not on npm
  // yet, so pointing people at `npx clawroll-verify` would hand them a copy-paste that
  // fails — on a page whose entire argument is "do not take our word for it", that is the
  // worst possible detail to get wrong.
  const command = `curl -s ${location.origin}/api/hands/${id}/proof \\\n  | pnpm -s --filter @clawroll/shuffle verify -`;

  return (
    <>
      <h1>Verify a hand</h1>
      <p className="lede">
        Every hand is dealt from a shuffle the server committed to before it knew anything —
        and published the seed for afterwards. Here is the proof. Check it yourself.
      </p>

      <div className="controls" style={{ marginBottom: 20 }}>
        <input
          className="field"
          style={{ flex: 1, minWidth: 280 }}
          placeholder="hand id"
          value={id}
          onChange={(e) => setId(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void load(id)}
        />
        <button className="btn primary" onClick={() => void load(id)} disabled={!id.trim() || loading}>
          {loading ? 'Fetching…' : 'Fetch proof'}
        </button>
      </div>

      <div className="note">
        <strong>We deliberately do not show you a green tick.</strong> A verification result
        rendered by this website would be worth nothing — the page is served by us, and anyone
        willing to rig a deal would be willing to print a checkmark. Run the command below on
        your own machine instead. It uses an independent tool and never talks to us except to
        download the proof.
      </div>

      {error && <div className="empty">Could not load proof: {error}</div>}
      {loading && <div className="skeleton" style={{ height: 180 }} />}

      {proof && (
        <>
          <h2>Check it yourself</h2>
          <code className="cmd">{command}</code>
          <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
            The verifier lives in this repository at <span className="mono">packages/shuffle</span>{' '}
            and reimplements the dealing rules independently of the server that dealt the hand —
            deliberately, so that agreeing with the dealer is evidence rather than a foregone
            conclusion. It will be <span className="mono">npx clawroll-verify</span> once published.
          </p>
          <div className="controls" style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => copy(command, 'cmd')}>
              {copied === 'cmd' ? '✓ Copied' : 'Copy command'}
            </button>
            <button className="btn" onClick={() => copy(proofJson, 'json')}>
              {copied === 'json' ? '✓ Copied' : 'Copy proof JSON'}
            </button>
            <a className="btn ghost" href={`/api/hands/${id}/proof`} target="_blank" rel="noreferrer">
              Open raw proof ↗
            </a>
            <a className="btn ghost" href={`#/hand/${id}`}>
              Watch the replay
            </a>
          </div>

          <h2>What the tool checks</h2>
          <div className="check-list">
            {CHECKS.map((check, i) => (
              <div key={check.title} className="check-item" style={{ '--i': i } as CSSProperties}>
                <span className="check-num">{i + 1}</span>
                <span>
                  <strong>{check.title}</strong>{' '}
                  <span className="muted">{check.body}</span>
                </span>
              </div>
            ))}
          </div>

          <h2>The proof</h2>
          <p className="lede">
            Everything needed to recompute the deck, and nothing else — no pot, no winner, no
            stacks. The verifier answers one question: was this deal the one the server
            committed to?
          </p>
          <pre className="proof">
            <Json text={proofJson} />
          </pre>
        </>
      )}
    </>
  );
}

/**
 * The proof, coloured.
 *
 * A wall of hex is the least readable thing on this site and also the most important, so the
 * keys, the seeds and the numbers get told apart. Tokenised into React elements rather than
 * spliced into HTML: this is server-supplied text on a page whose entire purpose is being
 * trusted about that server, and it will not be handed to `dangerouslySetInnerHTML`.
 */
function Json({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const token = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\b\d+(?:\.\d+)?\b)|\b(true|false|null)\b/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = token.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const key = `${match.index}`;
    if (match[1] !== undefined) {
      // A string followed by a colon is a key; anything else is a value.
      out.push(
        <span key={key} className={match[2] ? 'k' : 's'}>
          {match[1]}
        </span>,
      );
      if (match[2]) out.push(match[2]);
    } else {
      out.push(
        <span key={key} className="n">
          {match[3] ?? match[4]}
        </span>,
      );
    }
    last = match.index + match[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

const CHECKS = [
  {
    title: 'The commitment binds the server.',
    body: 'SHA256(serverSeed) must equal the commit published before any card was dealt — so the seed could not have been chosen after seeing the agents’ entropy.',
  },
  {
    title: 'The deck follows from the seeds.',
    body: 'Server seed and every client seed hash to one final seed, which drives an unbiased shuffle of the standard 52-card deck.',
  },
  {
    title: 'The cards match the deal.',
    body: 'Dealing that deck — one card at a time from the small blind, burning before each street — must reproduce exactly the hole cards and board that were shown.',
  },
];
