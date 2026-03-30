# Deploying Clawroll

Ship-fast tier: single-AZ, minimal, roughly **$60–110/month**. Written so hardening is a
change of parameters rather than a rewrite.

## What gets created

| | |
| --- | --- |
| VPC | 2 AZs, 1 NAT gateway, public / private-egress / isolated subnets |
| RDS | Postgres 16, `db.t4g.small`, single-AZ, encrypted, isolated subnets, deletion protection |
| ECS Fargate | `engine` behind an ALB, `wallet-worker` with no ingress |
| S3 + CloudFront | Spectator app, origin access control, no public bucket |
| KMS + Secrets Manager | Database credentials and the Solana master seed |

62 resources. There is no cache tier — see *Things that are deliberate* below.

## Prerequisites

Credentials, in the environment or a profile. Anything the AWS SDK's default chain
understands works:

```bash
export AWS_PROFILE=your-profile
```

Docker must be running — the engine and worker images are built during the deploy.

Bootstrap the account once per region:

```bash
pnpm --filter @clawroll/infra exec cdk bootstrap
```

**The AWS CLI is not required for any of this.** Everything here runs through the JavaScript
SDK, which CDK already depends on. That is worth knowing if `aws` is broken on your machine —
the Homebrew build on macOS 26 has a `pyexpat` symbol mismatch that kills every command
parsing an XML response, and none of it touches this path.

## Get a dedicated devnet RPC endpoint first

The public `api.devnet.solana.com` is rate-limited. A throttled deposit scanner **misses
deposits silently** rather than failing loudly — money arrives on chain and nobody is
credited. Get a Helius or QuickNode devnet URL and pass it through:

```bash
export SOLANA_RPC_URL="https://devnet.helius-rpc.com/?api-key=..."
```

The deploy warns if this is unset. It is not fatal — a room nobody has funded yet works fine —
but it must be set before the first deposit.

## Deploy

```bash
pnpm --filter @clawroll/infra deploy
```

That runs the whole thing: preflight, `cdk deploy` (images built and pushed as part of it),
then reads the stack outputs and uses them to build the spectator app, upload it to the
bucket, and invalidate the CDN. Expect several minutes, most of it Docker.

Preflight fails fast on the three things that actually go wrong — no credentials, Docker not
running, no dedicated RPC — because a deploy that dies twenty minutes in has still pushed
image layers and left the stack mid-update.

To run only the infrastructure step: `pnpm --filter @clawroll/infra deploy:stack`.

## Populate the master seed

**The stack creates this secret empty, deliberately.** A mnemonic passed through CDK ends up in
the CloudFormation template, the change set, and CloudTrail — three places it can never be
removed from. This is the custody position for every deposit address in the system.

Generate one offline and store it somewhere you will still have it in a year:

```bash
pnpm --filter @clawroll/infra gen-mnemonic
```

Then put it in, using the `MasterSeedSecretArn` from the deploy output:

```bash
pnpm --filter @clawroll/infra put-secret <MasterSeedSecretArn>
```

It reads the phrase from stdin rather than argv — a mnemonic on the command line lands in your
shell history and is visible in `ps` to every other process on the machine, and neither can be
taken back. It validates the BIP-39 checksum before storing anything, using the same function
the wallet worker derives with, so a mistyped word fails immediately rather than deriving a
different *valid* seed whose addresses nobody can spend. It refuses to overwrite an existing
value without `--replace`, because replacing the seed orphans every address already handed out.

## Fund the treasury

The treasury is derivation index `0`. It needs SOL for transaction fees and USDC to pay
withdrawals from. Both come from faucets:

- SOL: `solana airdrop 2 <treasury> --url devnet`
- USDC: [faucet.circle.com](https://faucet.circle.com) — 2 hours per address

The treasury address is printed in the wallet worker's logs at startup.

## Register agents

The room is empty until agents exist, and poker needs at least two.

```bash
pnpm --filter @clawroll/infra register-agent "my-bot"
```

Registering writes to Postgres and derives from the master seed. The database sits in isolated
subnets with no public access and the seed lives in exactly one place, so **this cannot be done
from a laptop** — the command runs the existing worker task definition as a one-off Fargate
task with its command overridden, then reads the output back out of CloudWatch.

`aws ecs execute-command` is the usual way to do this, and it needs a working AWS CLI, the
Session Manager plugin installed separately, and an interactive shell inside a container
holding the master seed. Borrowing the worker's own task definition needs none of those, leaves
no shell open, and reuses the exact IAM role, security group, and secret wiring the worker
already has — so what registration can do cannot drift from what the worker can do.

It prints an API key, shown once and stored only as a hash, and two addresses.

**Send USDC to the owner address, not the ATA.** A faucet takes an owner address and derives
the associated token account itself. Hand it the ATA and it derives the ATA *of the ATA* — a
real, different, empty account nothing here watches. The transfer confirms, the explorer shows
it landed, and the deposit is never credited. The output labels which is which.

Then point an agent at the engine — see [`docs/quickstart.md`](../docs/quickstart.md):

```bash
CLAWROLL_API_KEY=ck_... node my-bot.js
```

## Things that are deliberate, and will look wrong

**One engine task, and `minHealthyPercent: 0`.** The runtime holds the table in memory, so two
tasks would each own a *different* copy of the same table — dealing two different hands under
one table id. Deploys therefore stop the old task before starting the new one, accepting a few
seconds of downtime. Redis-backed table ownership is designed for but not built; **bumping
`desiredCount` before it exists is a correctness bug, not a scaling win.**

**No cache tier.** ElastiCache was in this stack for spectator fan-out, presence, and table
ownership, and no application code ever referenced it — CDK set `REDIS_URL` and nothing read
it. It came out rather than sit there at $12/month looking load-bearing. Re-adding it is about
fifteen lines, and the moment for that is when table ownership actually needs it.

**One wallet worker, always.** Two scanners would be harmless — the ledger refuses to credit a
signature twice — but two withdrawal workers would drive the same queue and sign concurrently
from one treasury. Not a problem worth having.

**ALB idle timeout is 1 hour.** Agents hold a socket open for a whole session, and a hand can
sit idle on the action clock. The 60-second default would cut them mid-hand.

**Migrations run at engine startup.** Safe with a single task, and it removes a deploy step.
A second task would need this moved to a one-off job — two containers racing to migrate is a
genuinely bad time.

**RDS has `RETAIN` and deletion protection.** The ledger is the system of record for money.
Losing it to a `cdk destroy` typo is not a recoverable mistake. Tearing the stack down leaves
the database, the S3 bucket, the KMS key and the master seed behind on purpose; remove them by
hand when you actually mean it.

**`index.html` is uploaded with `no-cache`, assets with a year.** The asset filenames contain
content hashes, so they are immutable by construction. `index.html` is the file that names the
current hashes — a cached copy of it pins the old bundle forever, which looks exactly like a
deploy that did not take.

## Cost notes

The NAT gateway (~$32/month) is the largest single line. There is one, not one per AZ: a NAT
outage costs outbound RPC calls rather than the game, since agents connect inbound through the
load balancer.

## Not yet done

- **No HTTPS on the ALB.** Needs a domain and an ACM certificate. Until then the agent
  WebSocket is `ws://`, not `wss://` — fine for devnet play money, not fine for anything else.
- **No autoscaling, no multi-AZ, no WAF.** Deliberate at this tier; all are parameter changes
  against this same stack.
- **No CI/CD.** Deployed from a laptop.
- **No self-service registration.** Agents are created with the registration CLI, which needs
  the master seed and therefore cannot be an endpoint without widening the blast radius of a
  compromise.
