#!/usr/bin/env node
/**
 * The whole deploy, in one command.
 *
 * `cdk deploy` gets the infrastructure up and then stops, which leaves four manual steps
 * between a green deploy and a site that works: read the stack outputs, build the spectator
 * app, upload it to the bucket CDK just named, and invalidate the CDN. Every one of them is
 * mechanical, and every one is a place to paste the wrong identifier.
 *
 * ## Why this does not shell out to the AWS CLI
 *
 * The obvious version of this script is four `aws` invocations. It uses the JavaScript SDK
 * instead, and that turned out to matter: the Homebrew `awscli` on this machine is built
 * against a Python whose `pyexpat` resolves to macOS's older bundled `libexpat`, so every
 * command that parses an XML response dies on a missing symbol. `aws --version` works;
 * `aws sts get-caller-identity` does not. No environment variable fixes it, because dyld
 * resolves `/usr/lib` from the shared cache before anything on the library path.
 *
 * That is somebody else's bug, but depending on the CLI would have made it ours. The SDK is
 * already a transitive dependency of CDK, speaks the same credential chain, and has no Python
 * anywhere in it. One less thing between a working checkout and a running site.
 *
 * ## What it deliberately does not do
 *
 * It does not write the master seed, and it does not fund the treasury. Both need a human:
 * the seed is the custody position for every deposit address in the system and must be
 * generated somewhere it can be kept, and the faucets are interactive. The script prints
 * exactly what remains, with the real ARNs filled in.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { CloudFrontClient, CreateInvalidationCommand, ListDistributionsCommand } from '@aws-sdk/client-cloudfront';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

const STACK = 'Clawroll';
const REGION = process.env['AWS_REGION'] ?? process.env['CDK_DEFAULT_REGION'] ?? 'us-east-1';
const ROOT = new URL('../..', import.meta.url).pathname;

const bold = (s: string) => `[1m${s}[0m`;
const dim = (s: string) => `[2m${s}[0m`;
const green = (s: string) => `[32m${s}[0m`;
const yellow = (s: string) => `[33m${s}[0m`;

function step(message: string): void {
  console.log(`\n${bold(`▸ ${message}`)}`);
}

function run(command: string, args: string[], cwd = ROOT): void {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

/**
 * Fail before doing anything expensive.
 *
 * A deploy that dies twenty minutes in because Docker was not running has still built images,
 * pushed layers, and left a stack mid-update. These three checks take about a second between
 * them and cover the failures that actually happen.
 */
async function preflight(): Promise<string> {
  step('Preflight');

  let account: string;
  try {
    const identity = await new STSClient({ region: REGION }).send(new GetCallerIdentityCommand({}));
    account = identity.Account ?? '(unknown)';
  } catch (error) {
    throw new Error(
      `No usable AWS credentials for region ${REGION}.\n` +
        `  Set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or configure a profile and export AWS_PROFILE.\n` +
        `  Underlying error: ${(error as Error).message}`,
    );
  }
  console.log(`  account   ${account}`);
  console.log(`  region    ${REGION}`);

  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
  } catch {
    throw new Error('Docker is not running. CDK builds the engine and worker images during deploy.');
  }
  console.log('  docker    running');

  // The public devnet RPC is rate-limited, and a throttled scanner misses deposits silently
  // rather than failing loudly — money lands on chain and nobody is credited. Worth a warning
  // rather than an error, since a room nobody has funded yet still works fine.
  if (!process.env['SOLANA_RPC_URL']) {
    console.log(
      yellow('  rpc       using the public devnet endpoint — set SOLANA_RPC_URL before taking deposits'),
    );
  } else {
    console.log('  rpc       SOLANA_RPC_URL is set');
  }

  return account;
}

async function stackOutputs(): Promise<Record<string, string>> {
  const client = new CloudFormationClient({ region: REGION });
  const described = await client.send(new DescribeStacksCommand({ StackName: STACK }));
  const outputs = described.Stacks?.[0]?.Outputs ?? [];
  return Object.fromEntries(
    outputs.flatMap((o) => (o.OutputKey && o.OutputValue ? [[o.OutputKey, o.OutputValue]] : [])),
  );
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Upload the built SPA.
 *
 * Content types are set explicitly. S3 defaults every unknown object to
 * `application/octet-stream`, and a stylesheet served as octet-stream is ignored by the
 * browser without an error anywhere — the site renders unstyled and nothing in the logs says
 * why. Hashed assets get a year of immutable caching; `index.html` gets none, because it is
 * the file that names the new hashes and a cached copy pins the old bundle forever.
 */
async function uploadSite(bucket: string): Promise<void> {
  const dist = join(ROOT, 'apps', 'web', 'dist');
  const s3 = new S3Client({ region: REGION });
  const files = filesUnder(dist);

  for (const file of files) {
    const key = relative(dist, file).split(sep).join('/');
    const extension = key.slice(key.lastIndexOf('.'));
    const immutable = key.startsWith('assets/');

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: readFileSync(file),
        ContentType: CONTENT_TYPES[extension] ?? 'application/octet-stream',
        CacheControl: immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      }),
    );
  }
  console.log(`  uploaded ${files.length} files to s3://${bucket}`);
}

/**
 * Invalidate `index.html` so a redeploy is visible immediately.
 *
 * Only that path: the hashed assets are immutable by construction and invalidating them wastes
 * the free tier's monthly allowance on files whose names already changed.
 */
async function invalidate(siteUrl: string): Promise<void> {
  const domain = siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const cloudfront = new CloudFrontClient({ region: REGION });
  const listed = await cloudfront.send(new ListDistributionsCommand({}));
  const distribution = listed.DistributionList?.Items?.find((d) => d.DomainName === domain);

  if (!distribution?.Id) {
    console.log(yellow(`  could not find the distribution for ${domain} — skipping invalidation`));
    return;
  }

  await cloudfront.send(
    new CreateInvalidationCommand({
      DistributionId: distribution.Id,
      InvalidationBatch: {
        CallerReference: `deploy-${process.pid}-${process.hrtime.bigint()}`,
        Paths: { Quantity: 1, Items: ['/index.html'] },
      },
    }),
  );
  console.log(`  invalidated /index.html on ${distribution.Id}`);
}

async function main(): Promise<void> {
  await preflight();

  step('Deploying the stack');
  console.log(dim('  Docker images are built and pushed as part of this — expect several minutes.\n'));
  run('npx', ['cdk', 'deploy', '--require-approval', 'never'], join(ROOT, 'infra'));

  step('Reading stack outputs');
  const outputs = await stackOutputs();
  for (const [key, value] of Object.entries(outputs)) {
    console.log(`  ${key.padEnd(20)} ${value}`);
  }

  step('Building the spectator app');
  run('pnpm', ['--filter', '@clawroll/web', 'build']);

  const bucket = outputs['SiteBucketName'];
  if (!bucket) throw new Error('SiteBucketName is missing from the stack outputs');

  step('Uploading the spectator app');
  await uploadSite(bucket);

  step('Invalidating the CDN');
  const siteUrl = outputs['SiteUrl'];
  if (siteUrl) await invalidate(siteUrl);

  console.log(`\n${green(bold('Deployed.'))}`);
  console.log(`  spectator   ${siteUrl ?? '(no SiteUrl output)'}`);
  console.log(`  engine      ${outputs['EngineUrl'] ?? '(no EngineUrl output)'}`);

  // Both of these need a human. Printed with the real identifiers so neither is a lookup.
  console.log(`\n${bold('Still to do, by hand:')}`);
  console.log(`
  1. Put the Solana master seed in its secret. The stack creates it empty on purpose — a
     mnemonic passed through CDK ends up in the template, the change set, and CloudTrail,
     three places it can never be removed from. Generate one somewhere you can keep it:

       pnpm --filter @clawroll/infra gen-mnemonic

     then store it:

       pnpm --filter @clawroll/infra put-secret ${outputs['MasterSeedSecretArn'] ?? '<MasterSeedSecretArn>'}

     The wallet worker will not start until this is set. It validates the BIP-39 checksum, so
     a mistyped word fails loudly rather than deriving a different valid seed whose addresses
     nobody can spend.

  2. Fund the treasury — derivation index 0, printed in the wallet worker's logs at startup.
     It needs SOL for fees and USDC to pay withdrawals from:

       solana airdrop 2 <treasury> --url devnet
       https://faucet.circle.com          (USDC, one claim per address every two hours)
`);
}

main().catch((error: Error) => {
  console.error(`\n[1;31mDeploy failed.[0m ${error.message}`);
  process.exit(1);
});
