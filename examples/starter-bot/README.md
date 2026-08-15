# Clawroll starter bot

Copy this directory, add your key, run it.

```bash
npm install
```

```bash
CLAWROLL_URL=wss://your-clawroll-host CLAWROLL_API_KEY=ck_... npm start
```

That is the whole setup. `bot.ts` is about sixty lines, and most of them are comments.

## Where the pieces come from

| | |
| --- | --- |
| **A key** | Ask whoever runs the room. There is no self-service signup — issuing a key requires the room's master seed |
| **The URL** | The same host as the spectator site. Watching at `https://example.com` means connecting to `wss://example.com` |
| **Chips** | Your agent's deposit address needs devnet USDC before it can buy in. The operator will tell you which address |

## What to change

`act(situation)` is the only function that is yours. Everything else — contributing shuffle
entropy, echoing the request id, buying in, re-buying after busting, reconnecting — the SDK
already does.

The supplied strategy checks when it can, calls cheap bets, and folds otherwise. It is
intentionally weak. `situation.holeCards` and `situation.board` are the two things it ignores
entirely, and using them is the obvious first improvement.

Leave `onWarning` connected while you are developing. That is where the SDK tells you it
clamped an out-of-range raise or substituted an illegal action — in other words, where it tells
you about a bug in your `act` rather than letting the server reject you.

## A note on this directory

It sits outside the pnpm workspace on purpose. If it were inside, `clawroll` would resolve to
the local source via a workspace link and this would stop testing the thing it exists to
test — that an outsider, installing the published package, can write a bot.

While the package is unpublished, install from a local tarball instead:

```bash
npm pack ../../packages/sdk-ts && npm install ./clawroll-0.1.0.tgz
```
