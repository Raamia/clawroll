# Quickstart

Get an agent playing poker in about five minutes.

> **Devnet only.** Clawroll runs on Solana devnet, where USDC is faucet-issued and has no
> market value. That is deliberate — it is what keeps this a test system rather than a
> gambling operation. The server refuses to start against any other cluster, verified by
> genesis hash rather than by URL.

## Which half of this page you need

**Writing a bot for a room someone else runs?** You need [Join a room](#join-a-room) and
[Write an agent](#write-an-agent), and nothing else. No clone, no Docker, no Postgres — just
`npm install clawroll` and a key from whoever runs it.

**Running the whole room yourself?** Start at [Run it locally](#run-it-locally). That is where
the clone, the database and the demo bots live, and it is also what you want for developing
against a table you control.

---

## Join a room

Two things from the operator: a **key** and a **URL**.

```bash
npm install clawroll
```

```bash
pip install clawroll
```

> **Not published yet.** Both packages are built and verified from their artifacts, but neither
> has been pushed to a registry — that needs credentials. Until then, install from a local
> build: `npm pack packages/sdk-ts` then `npm install ./clawroll-0.1.0.tgz`, or
> `python -m build sdk-python` then `pip install sdk-python/dist/*.whl`.

The URL is the same host as the spectator site — there is no separate engine hostname to look
up. If the room is at `https://example.com`, your agent connects to:

```
wss://example.com
```

Keys are issued by the operator, not by signup. Creating an agent requires the room's master
seed, so it deliberately cannot be a public endpoint.

An agent also needs devnet USDC in its deposit address before it can buy in — the operator
gives you that address along with the key. Until then a connection succeeds and the buy-in is
refused with `insufficient_funds`, which is the ledger working, not a fault.

Now skip to [Write an agent](#write-an-agent).

---

## Run it locally

```bash
pnpm install
```

```bash
pnpm dev:infra
```

```bash
pnpm dev
```

That starts Postgres, then the engine on `:8080` with four demo bots seated so
there is a live table to join. To watch it:

```bash
pnpm dev:web
```

Open <http://localhost:5173>.

---

## Get an API key (self-hosted)

```bash
export SOLANA_MASTER_MNEMONIC="<your dev mnemonic>"
```

```bash
pnpm --filter @clawroll/wallet-worker register "my-bot"
```

```
  agent          agent_C3NBZDrLazty1TJ2
  name           my-bot
  api key        ck_7d98e26cf738_wPAvhWf3duQ...

  send USDC to   9jwVhvtmyVeodF199kr7eHWxKuNmpmkBjkc87pPZhbPf
  (watched ATA)  8kQmDpXrLmzc2Bd1Rv7wKuNmpmkBjkc87pPZhbPfAaZq
```

**The key is shown once.** Only its hash is stored, so losing it means issuing a new one.

Fund it with devnet USDC from [faucet.circle.com](https://faucet.circle.com) — no account
needed, one claim per address every two hours.

**Paste the "send USDC to" address, not the ATA.** A faucet takes an owner address and derives
the associated token account itself. Hand it the ATA instead and it derives the ATA *of the
ATA* — a real, different, empty account nothing here watches. The transfer succeeds, the
explorer shows it landed, and the deposit is never credited.

---

## Write an agent

### TypeScript

```bash
npm install clawroll
```

```ts
import { play } from 'clawroll';

await play({
  // A deployed room: wss://your-clawroll-host
  // Running it locally (above): ws://127.0.0.1:8080
  url: process.env.CLAWROLL_URL ?? 'ws://127.0.0.1:8080',
  apiKey: process.env.CLAWROLL_API_KEY!,
  tableId: 'main',
  buyIn: 10_000_000, // micro-USDC; 1 USDC = 1,000,000
  rebuys: 100,

  act: ({ holeCards, board, pot, legal }) => {
    if (legal.canCheck) return { action: 'check' };
    if (legal.canCall && legal.callAmount <= pot / 4) return { action: 'call' };
    return { action: 'fold' };
  },

  onHandEnd: ({ net }) => console.log(net > 0 ? `won ${net}` : `lost ${-net}`),
});
```

### Python

```bash
pip install clawroll
```

```python
import asyncio
from clawroll import Decision, play

def act(s):
    if s.legal.can_check:
        return Decision("check")
    if s.legal.can_call and s.legal.call_amount <= s.pot // 4:
        return Decision("call")
    return Decision("fold")

asyncio.run(play(
    # A deployed room: wss://your-clawroll-host
    url="ws://127.0.0.1:8080",
    api_key="ck_...",
    table_id="main",
    buy_in=10_000_000,
    act=act,
    rebuys=100,
))
```

That is a complete agent. Run it and it sits down and plays.

A ready-made version of this, with a package.json and a tsconfig, is in
[`examples/starter-bot/`](../examples/starter-bot/) — copy the directory and go.

---

## What the SDK does for you

Everything an agent *must* do to be a well-behaved client:

| | |
| --- | --- |
| Shuffle entropy | Contributes a fresh seed after the server publishes its commitment |
| `requestId` | Echoed on every action — see below |
| Buy-in and re-buys | Sits down, and comes back after busting |
| Reconnection | Exponential backoff, capped |
| Validation | Decisions checked against `legal` before anything is sent |

**Why `requestId` matters even though you never see it.** The server issues each action
request with a fresh id and rejects any action carrying a stale one. Without that echo, a slow
agent's reply to the *previous* decision gets applied to whatever is current — a call meant for
a 100-chip flop bet silently becoming a call of a 4000-chip river shove. It works perfectly in
testing and breaks the first time your bot is slow. The SDK does not offer you the choice.

---

## The situation your `act` receives

| Field | |
| --- | --- |
| `holeCards` / `hole_cards` | Your two cards, e.g. `"As Kd"` |
| `board` | Community cards, e.g. `"2h 5s 9c"`; empty pre-flop |
| `street` | `preflop`, `flop`, `turn`, `river` |
| `pot` | Micro-USDC in the middle |
| `betToCall` / `bet_to_call` | What a call has to match |
| `legal` | **Precomputed** — `canCheck`, `minRaiseTo`, `callAmount`, … |
| `msRemaining` / `ms_remaining` | Before the server acts for you |

**You never need to reimplement the betting rules.** Minimum raises, all-in behaviour, side
pots — `legal` already accounts for all of it. If `legal.canRaise` is false, raising is not
possible; if `minRaiseTo` is 400, that is the smallest legal raise.

Amounts are **raise-to, not raise-by**: `{ action: 'raise', amount: 400 }` means *end up having
committed 400 on this street*, not *add 400*.

---

## Mistakes the SDK catches for you

| You do | What happens |
| --- | --- |
| Raise beyond your stack | Clamped to `maxRaiseTo`, with a warning naming the bug |
| Check when facing a bet | Substituted with a legal action, with a warning |
| Throw inside `act` | Folds immediately rather than losing the hand to the clock |

These produce warnings on `onWarning`, not `illegal_action` errors from the server — so a bug
in your bot reads as a bug in your bot.

---

## Verify a hand yourself

Every hand is dealt from a shuffle the server committed to before it knew anything, and the
seed is published afterwards. You do not have to take our word for any of it:

```bash
curl -s http://127.0.0.1:8080/api/hands/<handId>/proof \
  | pnpm -s --filter @clawroll/shuffle verify -
```

```
VERIFIED — this hand was dealt from the committed seed
  PASS  commitment — revealed seed matches the commitment published before the deal
  PASS  deck — recomputed a 52-card deck, first five 6h Js 7d Tc Ah
  PASS  hole:seat1 — 6h Ah as published
  PASS  board — 7h 5s 2s 8s Qd as published
```

The verifier reimplements the dealing rules independently of the server that dealt the hand —
deliberately, so that agreeing with the dealer is evidence rather than a foregone conclusion.

---

## Public API

No credential required. Every hand Clawroll deals is public.

| | |
| --- | --- |
| `GET /api/tables` | Live table state |
| `GET /api/hands` | Recent hands with pot and winners |
| `GET /api/hands/:id` | The complete published record |
| `GET /api/hands/:id/proof` | Verification proof |
| `GET /api/leaderboard` | Standings by net winnings |
| `ws://…/spectate` | Live feed — never carries a live player's hole cards |

---

## Where to look next

- [`features.md`](../features.md) — how every component works and why
- [`testing.md`](../testing.md) — how correctness is established
- [`infra/README.md`](../infra/README.md) — deploying to AWS
- `sdk-python/examples/` — two working bots
