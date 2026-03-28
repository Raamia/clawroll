#!/usr/bin/env node
/**
 * Store the Solana master seed in its Secrets Manager secret.
 *
 * This is the custody position for every deposit address in the system, so the handling is
 * more careful than a one-line `aws secretsmanager put-secret-value` would be:
 *
 * - **Read from stdin, never from argv.** A mnemonic on the command line lands in the shell
 *   history file and is visible in `ps` to every other process on the machine for as long as
 *   the command runs. Neither can be taken back afterwards.
 * - **Validated before it is stored.** BIP-39 has a checksum precisely so a mistyped word is
 *   detectable. Storing an unvalidated phrase means the failure surfaces later as a wallet
 *   worker deriving a *different valid* seed — addresses that look fine, receive deposits,
 *   and cannot be spent.
 * - **Refuses to overwrite an existing value** unless `--replace` is passed. Overwriting the
 *   seed orphans every deposit address already handed out.
 *
 * Usage:
 *
 *   node --import tsx infra/bin/put-secret.ts <secret-arn> [--replace]
 *
 * then paste the mnemonic and press ctrl-D.
 */

import { createInterface } from 'node:readline/promises';
import {
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { masterSeedFromMnemonic } from '@clawroll/solana';

const REGION = process.env['AWS_REGION'] ?? process.env['CDK_DEFAULT_REGION'] ?? 'us-east-1';

async function main(): Promise<void> {
  const [secretId, ...flags] = process.argv.slice(2);
  if (!secretId) {
    console.error('usage: put-secret.ts <secret-arn> [--replace]');
    process.exit(2);
  }
  const replace = flags.includes('--replace');

  const client = new SecretsManagerClient({ region: REGION });

  // Everything that can fail is checked *before* the prompt, so nobody ever pastes a master
  // mnemonic into a process that was going to fail anyway. An earlier version had exactly
  // that flaw: it wrapped the value lookup in a catch that swallowed everything except a
  // missing secret, so with no credentials at all it happily asked for the seed and only
  // failed on the write.
  //
  // Two calls rather than one, because they answer different questions and a missing secret
  // and an empty secret raise the identical `ResourceNotFoundException`. Describe answers
  // "does this secret exist and may I touch it?"; Get answers "does it already hold a value?"
  try {
    await client.send(new DescribeSecretCommand({ SecretId: secretId }));
  } catch (error) {
    if ((error as { name?: string }).name === 'ResourceNotFoundException') {
      throw new Error(`No secret with id ${secretId} in ${REGION}.`);
    }
    throw new Error(`Cannot reach ${secretId} in ${REGION}: ${(error as Error).message}`);
  }

  let existing: string | undefined;
  try {
    existing = (await client.send(new GetSecretValueCommand({ SecretId: secretId }))).SecretString;
  } catch (error) {
    // The secret exists — Describe just said so — and this is the expected state on a fresh
    // stack, which creates it with no version at all. Anything else is a real failure.
    if ((error as { name?: string }).name !== 'ResourceNotFoundException') {
      throw new Error(`Cannot read ${secretId}: ${(error as Error).message}`);
    }
  }

  if (existing && existing.length > 0 && !replace) {
    throw new Error(
      'This secret already has a value. Overwriting it orphans every deposit address\n' +
        '  already derived from the current seed — funds sent to them become unspendable.\n' +
        '  Pass --replace only if you are certain no address has been handed out.',
    );
  }

  console.error('Paste the mnemonic, then press ctrl-D:');
  const reader = createInterface({ input: process.stdin });
  let mnemonic = '';
  for await (const line of reader) mnemonic += `${line} `;
  mnemonic = mnemonic.trim().replace(/\s+/g, ' ');

  // Validated through the same function the wallet worker derives with, rather than a
  // second copy of the check. Two implementations of "is this mnemonic valid" is two
  // opportunities for one of them to be more permissive than the other, and the permissive
  // one would let a seed into the secret that the worker then refuses to start on.
  try {
    masterSeedFromMnemonic(mnemonic);
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\n  Nothing was stored.`,
    );
  }

  await client.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: mnemonic }));
  console.error(`\nStored ${mnemonic.split(' ').length} words in ${secretId}.`);
  console.error('The wallet worker will pick it up on its next start.');
}

main().catch((error: Error) => {
  console.error(`\nFailed: ${error.message}`);
  process.exit(1);
});
