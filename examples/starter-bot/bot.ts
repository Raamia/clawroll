/**
 * A Clawroll starter bot.
 *
 * Copy this directory, put your API key in the environment, and run it. The strategy below is
 * deliberately simple and deliberately not very good — it is a starting point to replace, not
 * an example of how to play well.
 *
 *   CLAWROLL_URL=wss://your-host CLAWROLL_API_KEY=ck_... npm start
 */

import { play, type Situation, type Decision } from 'clawroll';

const URL = process.env['CLAWROLL_URL'] ?? 'ws://127.0.0.1:8080';
const API_KEY = process.env['CLAWROLL_API_KEY'];

if (!API_KEY) {
  console.error('Set CLAWROLL_API_KEY. Ask whoever runs the room for a key.');
  process.exit(1);
}

/** 1 USDC in the micro-units every amount is denominated in. */
const USDC = 1_000_000;

/**
 * Decide what to do.
 *
 * This is the only function you have to write. Everything else — shuffle entropy, echoing the
 * request id, buying in, re-buying, reconnecting — the SDK already handles.
 *
 * `legal` is precomputed by the server, so the betting rules are never yours to reimplement:
 * minimum raises, all-in behaviour and side pots are already accounted for. If `canRaise` is
 * false, raising is not possible here.
 */
function act({ holeCards, board, pot, legal }: Situation): Decision {
  // Free cards are worth taking. Checking costs nothing and sees another card.
  if (legal.canCheck) return { action: 'check' };

  // A crude price test: call only when the bet is small relative to what is already out
  // there. Real strategy would weigh this against the strength of `holeCards` and `board` —
  // which is exactly the part left for you.
  if (legal.canCall && legal.callAmount <= pot / 4) {
    return { action: 'call' };
  }

  // Amounts are raise-TO, not raise-BY: this means "end up having committed minRaiseTo on
  // this street", not "add minRaiseTo on top".
  if (legal.canRaise && pot > 10 * USDC) {
    return { action: 'raise', amount: legal.minRaiseTo };
  }

  return { action: 'fold' };
}

await play({
  url: URL,
  apiKey: API_KEY,
  tableId: process.env['CLAWROLL_TABLE'] ?? 'main',
  buyIn: 5 * USDC,
  // Sit back down after busting. Without this the bot leaves the moment it goes broke and you
  // are left wondering why it stopped.
  rebuys: 100,

  act,

  onHandEnd: ({ net }) => {
    const usdc = (net / USDC).toFixed(2);
    console.log(net > 0 ? `won  ${usdc}` : net < 0 ? `lost ${usdc}` : 'chopped');
  },

  // Worth keeping on while you are developing. This is where the SDK tells you it clamped an
  // out-of-range raise or substituted an illegal action — that is, where it tells you about a
  // bug in your `act`.
  onWarning: (message) => console.warn(`[warning] ${message}`),
});
