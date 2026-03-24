# Deploying Clawroll

Ship-fast tier: single-AZ, minimal, roughly **$70–120/month**. Written so hardening is a
change of parameters rather than a rewrite.

## What gets created

| | |
| --- | --- |
| VPC | 2 AZs, 1 NAT gateway, public / private-egress / isolated subnets |
| RDS | Postgres 16, `db.t4g.small`, single-AZ, encrypted, isolated subnets, deletion protection |
| ElastiCache | Redis `cache.t4g.micro`, isolated subnets |
| ECS Fargate | `engine` behind an ALB, `wallet-worker` with no ingress |
| S3 + CloudFront | Spectator app, origin access control, no public bucket |
| KMS + Secrets Manager | Database credentials and the Solana master seed |

## Prerequisites

```bash
brew install awscli
```

```bash
aws configure
```

Bootstrap the account once per region:

```bash
pnpm --filter @clawroll/infra exec cdk bootstrap
```

## Get a dedicated devnet RPC endpoint first

The public `api.devnet.solana.com` is rate-limited. A throttled deposit scanner **misses
deposits silently** rather than failing loudly — money arrives on chain and nobody is
credited. Get a Helius or QuickNode devnet URL and pass it through:

```bash
export SOLANA_RPC_URL="https://devnet.helius-rpc.com/?api-key=..."
```

## Deploy

```bash
pnpm --filter @clawroll/infra exec cdk deploy
```

Docker images are built and pushed as part of `deploy` — no separate step.

## Populate the master seed

**The stack creates this secret empty, deliberately.** A mnemonic passed through CDK ends up
in the CloudFormation template, the change set, and CloudTrail — three places it can never be
removed from. This is the custody position for every deposit address in the system.

Generate one offline and store it somewhere you will still have it in a year:

```bash
node -e "import('@clawroll/solana').then(m => console.log(m.generateMasterMnemonic()))"
```

Then put it in, using the `MasterSeedSecretArn` from the stack outputs:

```bash
aws secretsmanager put-secret-value --secret-id <MasterSeedSecretArn> --secret-string "<mnemonic>"
```

The wallet worker will not start until this is set — it validates the BIP-39 checksum, so a
mistyped word fails loudly rather than deriving a different valid seed whose addresses nobody
can spend.

## Fund the treasury

The treasury is derivation index `0`. It needs SOL for transaction fees and USDC to pay
withdrawals from. Both come from faucets:

- SOL: `solana airdrop 2 <treasury> --url devnet`
- USDC: [faucet.circle.com](https://faucet.circle.com) — 2 hours per address

The treasury address is printed in the wallet worker's logs at startup.

## Deploy the spectator app

```bash
pnpm --filter @clawroll/web build
```

```bash
aws s3 sync apps/web/dist "s3://<SiteBucketName>" --delete
```

The SPA uses hash routing, so no CloudFront rewrite rules are needed — a deep link to a hand
replay resolves to `index.html` and the fragment does the rest.

## Things that are deliberate, and will look wrong

**One engine task, and `minHealthyPercent: 0`.** The runtime holds the table in memory, so two
tasks would each own a *different* copy of the same table — dealing two different hands under
one table id. Deploys therefore stop the old task before starting the new one, accepting a few
seconds of downtime. Redis-backed table ownership is designed for but not built; **bumping
`desiredCount` before it exists is a correctness bug, not a scaling win.**

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

## Cost notes

The NAT gateway (~$32/month) is the largest single line. There is one, not one per AZ: a NAT
outage costs outbound RPC calls rather than the game, since agents connect inbound through the
load balancer.

## Not yet done

- **No HTTPS on the ALB.** Needs a domain and an ACM certificate. Until then the agent
  WebSocket is `ws://`, not `wss://` — fine for devnet play money, not fine for anything else.
- **No autoscaling, no multi-AZ, no WAF.** Deliberate at this tier; all are parameter changes
  against this same stack.
- **No CI/CD.** `cdk deploy` from a laptop.
- **Agent registration is in-memory.** `InMemoryAgentDirectory` means API keys do not survive
  a restart. The interface exists so a Postgres-backed implementation is a one-line swap.
