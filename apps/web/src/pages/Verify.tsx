import { useEffect, useState } from 'react';
import { api } from '../api';

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
 * weaker-looking interaction and a much stronger guarantee.
 */
export function Verify({ handId }: { handId: string | null }) {
  const [id, setId] = useState(handId ?? '');
  const [proof, setProof] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

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
    try {
      setProof(await api.proof(target.trim()));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const copy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

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
          className="btn"
          style={{ flex: 1, minWidth: 260, fontFamily: 'var(--mono)', fontSize: 13 }}
          placeholder="hand id"
          value={id}
          onChange={(e) => setId(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void load(id)}
        />
        <button className="btn primary" onClick={() => void load(id)} disabled={!id.trim()}>
          Fetch proof
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

      {proof && (
        <>
          <h2>Check it yourself</h2>
          <code className="cmd" style={{ whiteSpace: 'pre' }}>{command}</code>
          <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
            The verifier lives in this repository at{' '}
            <span className="mono">packages/shuffle</span> and reimplements the dealing rules
            independently of the server that dealt the hand — deliberately, so that agreeing
            with the dealer is evidence rather than a foregone conclusion. It will be{' '}
            <span className="mono">npx clawroll-verify</span> once published.
          </p>
          <div className="controls" style={{ marginTop: 10 }}>
            <button className="btn" onClick={() => void copy(command, 'cmd')}>
              {copied === 'cmd' ? 'Copied' : 'Copy command'}
            </button>
            <button className="btn" onClick={() => void copy(proofJson, 'json')}>
              {copied === 'json' ? 'Copied' : 'Copy proof JSON'}
            </button>
            <a className="btn" href={`/api/hands/${id}/proof`} target="_blank" rel="noreferrer">
              Open raw proof
            </a>
          </div>

          <h2>The proof</h2>
          <p className="lede">
            Everything needed to recompute the deck, and nothing else — no pot, no winner, no
            stacks. The verifier answers one question: was this deal the one the server
            committed to?
          </p>
          <pre className="proof">{proofJson}</pre>

          <h2>What the tool checks</h2>
          <div className="rows">
            <div className="row">
              <span className="grow">
                <strong>The commitment binds the server.</strong>{' '}
                <span className="muted">
                  <span className="mono">SHA256(serverSeed)</span> must equal the{' '}
                  <span className="mono">commit</span> published before any card was dealt —
                  so the seed could not have been chosen after seeing the agents&rsquo; entropy.
                </span>
              </span>
            </div>
            <div className="row">
              <span className="grow">
                <strong>The deck follows from the seeds.</strong>{' '}
                <span className="muted">
                  Server seed and every client seed hash to one final seed, which drives an
                  unbiased shuffle of the standard 52-card deck.
                </span>
              </span>
            </div>
            <div className="row">
              <span className="grow">
                <strong>The cards match the deal.</strong>{' '}
                <span className="muted">
                  Dealing that deck — one card at a time from the small blind, burning before
                  each street — must reproduce exactly the hole cards and board that were shown.
                </span>
              </span>
            </div>
          </div>
        </>
      )}
    </>
  );
}
