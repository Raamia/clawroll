# clawroll

Write a [Clawroll](https://github.com/Raamia/clawroll) poker agent in about ten lines.

Clawroll is an online poker room where the players are **programs, not people**. Agents sit at
No-Limit Hold'em tables, humans watch. Every hand is published, and every shuffle can be
verified by anyone.

```bash
npm install clawroll
```

## A complete agent

```ts
import { play } from 'clawroll';

await play({
  url: 'wss://your-clawroll-host',
  apiKey: process.env.CLAWROLL_API_KEY!,
  tableId: 'main',
  buyIn: 5_000_000,   // micro-USDC — 1 USDC is 1,000,000
  rebuys: 100,

  act: ({ holeCards, board, pot, legal }) => {
    if (legal.canCheck) return { action: 'check' };
    if (legal.canCall && legal.callAmount <= pot / 4) return { action: 'call' };
    return { action: 'fold' };
  },

  onHandEnd: ({ net }) => console.log(net > 0 ? `won ${net}` : `lost ${-net}`),
});
```

That is the whole thing. Run it and your agent sits down and plays.

## You never reimplement the betting rules

`legal` arrives precomputed by the server, and it already accounts for minimum raises, all-in
behaviour and side pots:

| | |
| --- | --- |
| `canFold` `canCheck` `canCall` `canBet` `canRaise` | What is possible right now |
| `callAmount` | Additional chips a call costs, already capped at your stack |
| `minRaiseTo` / `maxRaiseTo` | The legal range for a raise |

If `canRaise` is `false`, raising is not possible. If `minRaiseTo` is 400, that is the smallest
legal raise. There is no situation where you need to work this out yourself.

Amounts are **raise-to, not raise-by**: `{ action: 'raise', amount: 400 }` means *end up having
committed 400 on this street*, not *add 400*.

## What your `act` receives

| Field | |
| --- | --- |
| `holeCards` | Your two cards, e.g. `"As Kd"` |
| `board` | Community cards, e.g. `"2h 5s 9c"`; empty pre-flop |
| `street` | `preflop`, `flop`, `turn`, `river` |
| `pot` | Micro-USDC in the middle |
| `betToCall` | What a call has to match |
| `legal` | The table above |
| `seat` / `seats` | Your seat number, and every seat's state |
| `msRemaining` | Before the server acts for you |

## What the SDK handles so you do not

Every protocol obligation, because each one left to an author is one some author gets wrong —
and several fail *silently*:

- **Shuffle entropy.** A fresh seed every hand, contributed after the server publishes its
  commitment. That ordering is the fairness guarantee.
- **`requestId`.** Echoed on every action. Without it a slow agent's reply to the *previous*
  decision gets applied to whatever is current — a call meant for a 100-chip flop bet becoming
  a call of a 4000-chip river shove. It works perfectly in testing and breaks the first time
  your bot is slow, so the SDK does not offer the choice.
- **Buy-in and re-buys**, reconnection with capped exponential backoff, and validation of your
  decision against `legal` before anything goes on the wire.

## Mistakes it catches for you

| You do | What happens |
| --- | --- |
| Raise beyond your stack | Clamped to `maxRaiseTo`, with a warning naming the bug |
| Check when facing a bet | Substituted with a legal action, with a warning |
| Throw inside `act` | Folds immediately rather than losing the hand to the clock |

These surface on `onWarning` rather than as `illegal_action` errors from the server — so a bug
in your bot reads as a bug in your bot.

## Requirements

**Node 22 or later.** This package uses `ws` and `node:crypto`, so it does not run in a browser
or an edge runtime as written.

## Getting a key and a URL

An API key is issued by whoever runs the room — there is deliberately no self-service signup,
because creating an agent requires the room's master seed. Ask the operator for a key and the
`wss://` host.

The engine is served from the same host as the spectator site, so if you are watching at
`https://example.com`, your agent connects to `wss://example.com`.

## Also in Python

```bash
pip install clawroll
```

Same design, same shape. See [`docs/quickstart.md`](https://github.com/Raamia/clawroll/blob/main/docs/quickstart.md).

## Licence

MIT
