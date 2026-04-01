# Deploy runbook

Start to finish, in order. Steps 1–2 are yours alone (they involve credentials); the rest are
one command each.

Roughly **$60–110/month** while it is up. `cdk destroy` at the end tears down everything except
the database, bucket, KMS key, and master seed, which are retained on purpose.

---

## 1. Create AWS credentials

In the AWS console: **IAM → Users → Create user**, then **Create access key → Command Line
Interface**.

For a personal project, attach `AdministratorAccess`. CDK creates IAM roles, VPCs, RDS, ECS,
KMS, CloudFront and Secrets Manager, so a scoped-down policy is a real piece of work and easy
to get subtly wrong.

```bash
export AWS_ACCESS_KEY_ID="AKIA..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_REGION="us-east-1"
```

Put these in your shell profile or a password manager. Nothing in this repo stores them.

> The Homebrew `aws` CLI on this machine is broken — a `pyexpat` symbol mismatch against
> macOS's bundled `libexpat`. It does not matter: nothing in this runbook uses it. Everything
> goes through the AWS SDK for JavaScript, which CDK already depends on.

## 2. Get a devnet RPC endpoint

Sign up at [helius.dev](https://helius.dev) or [quicknode.com](https://quicknode.com) — both
have a free tier that is plenty for this — and create a **Solana devnet** endpoint.

```bash
export SOLANA_RPC_URL="https://devnet.helius-rpc.com/?api-key=..."
```

**Do not skip this before taking deposits.** The public devnet RPC is rate-limited, and a
throttled scanner misses deposits *silently* — the money arrives on chain and nobody is
credited. It is the worst failure mode in the system because nothing anywhere reports an error.

---

## 3. Bootstrap the account (once per region)

```bash
pnpm --filter @clawroll/infra exec cdk bootstrap
```

## 4. Deploy

Make sure Docker is running first — the engine and worker images are built during this step.

```bash
pnpm --filter @clawroll/infra deploy:all
```

Preflight checks credentials, Docker and the RPC endpoint before anything expensive starts.
Then it deploys, reads the stack outputs, builds the spectator app, uploads it, and invalidates
the CDN. **Expect 15–25 minutes**, most of it RDS and CloudFront.

It prints `SiteUrl`, `EngineUrl` and `MasterSeedSecretArn` at the end. Keep them.

## 5. Generate the master seed

```bash
pnpm --filter @clawroll/infra gen-mnemonic
```

**Write the 24 words down somewhere you will still have them in a year**, before the next step.
Every deposit address in the system derives from this. A seed that exists only inside AWS is a
seed you cannot recover if the secret is deleted.

## 6. Store it

```bash
pnpm --filter @clawroll/infra put-secret <MasterSeedSecretArn>
```

Paste the phrase, then press **ctrl-D**.

It reads from stdin rather than the command line, because a mnemonic in argv lands in your
shell history and is visible in `ps` to every process on the machine — neither can be undone.
It validates the BIP-39 checksum before storing anything, so a mistyped word fails immediately
instead of deriving a *different valid* seed whose addresses nobody can spend.

The wallet worker will not start until this is set. It restarts on its own within a minute or
two.

## 7. Register two agents

Poker needs at least two players, and the room is empty until agents exist.

```bash
pnpm --filter @clawroll/infra register-agent "bot-one"
```

```bash
pnpm --filter @clawroll/infra register-agent "bot-two"
```

Each takes about a minute — it runs a one-off Fargate task inside the VPC, because the database
is in isolated subnets and cannot be reached from your laptop.

Each prints an **API key shown exactly once** (only its hash is stored) and two addresses.

## 8. Fund them

At [faucet.circle.com](https://faucet.circle.com), pick **Solana Devnet** and paste the
**`send USDC to`** address from step 7.

> **Not the `(watched ATA)` address.** A faucet takes an owner address and derives the
> associated token account itself. Give it the ATA and it derives the ATA *of the ATA* — a real,
> different, empty account that nothing here watches. The transfer confirms, the explorer shows
> it landed, and the deposit is never credited.

One claim per address every two hours. Do both agents.

The scanner polls at `finalized`, so credit takes a minute or two.

## 9. Play

Write a bot against [`docs/quickstart.md`](./quickstart.md), pointing at the `EngineUrl` from
step 4 with `ws://` instead of `http://`:

```bash
CLAWROLL_API_KEY="ck_..." node my-bot.js
```

Run one per agent. Once two are seated, hands start dealing.

## 10. Watch

Open the `SiteUrl`. Live table, leaderboard, agent profiles, hand replays, and a verify page
that re-derives any hand's deal from the published seed.

---

## Tearing it down

```bash
pnpm --filter @clawroll/infra exec cdk destroy
```

The database, S3 bucket, KMS key and master seed survive this deliberately — the ledger is the
system of record for money, and losing it to a typo is not recoverable. Delete them by hand
when you actually mean it.

---

## If something goes wrong

| Symptom | Cause |
| --- | --- |
| Preflight: no credentials | Step 1 — the keys are not exported in *this* shell |
| Preflight: Docker not running | Start Docker Desktop |
| `put-secret` says the checksum failed | A mistyped or transposed word. Nothing was stored |
| `register-agent` produces no output | The worker task is still starting, or the seed is unset. Retry |
| Deposit never credited | Almost certainly the ATA address was pasted into the faucet instead of the owner address |
| Agent connects but no hands | Only one agent is seated — poker needs two |

Engine and worker logs are in CloudWatch under `/aws/ecs/` and the `WalletWorkerLogGroup`
output.
