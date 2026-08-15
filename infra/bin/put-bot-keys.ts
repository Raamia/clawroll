#!/usr/bin/env node
/**
 * Store the house bots' roster.
 *
 * Separate from `put-secret` rather than a flag on it, because the validation is the point of
 * both and the two validations are unrelated. `put-secret` refuses anything that is not a
 * valid BIP-39 mnemonic; that check applied here would reject every correct input, and
 * dropping it to accommodate this would remove the guard that stops a mistyped master seed
 * deriving addresses nobody can spend.
 *
 * Reads from stdin, not argv: the roster is a list of API keys, and a secret on the command
 * line lands in shell history and is visible in `ps` to every process on the machine.
 *
 * Usage:
 *
 *   node --import tsx infra/bin/put-bot-keys.ts <secret-arn>
 *
 * then paste `tableId:apiKey,tableId:apiKey,…` and press ctrl-D.
 */

import { createInterface } from 'node:readline/promises';
import {
  DescribeSecretCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

const REGION = process.env['AWS_REGION'] ?? process.env['CDK_DEFAULT_REGION'] ?? 'us-east-1';

/** `tableId:apiKey` pairs, comma-separated. Returns the parsed seats or throws. */
function parse(raw: string): { tableId: string; apiKey: string }[] {
  const seats = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf(':');
      if (at < 1) throw new Error(`expected "tableId:apiKey", got "${entry.slice(0, 24)}…"`);
      const apiKey = entry.slice(at + 1);
      // A key that does not look like one is almost certainly a paste that lost a field, and
      // storing it would leave the fleet retrying an unauthorised connection forever.
      if (!apiKey.startsWith('ck_')) {
        throw new Error(`"${entry.slice(0, 24)}…" does not carry an API key (they start ck_)`);
      }
      return { tableId: entry.slice(0, at), apiKey };
    });
  if (seats.length === 0) throw new Error('no seats given');
  return seats;
}

async function main(): Promise<void> {
  const secretId = process.argv[2];
  if (!secretId) {
    console.error('usage: put-bot-keys.ts <secret-arn>');
    process.exit(2);
  }

  const client = new SecretsManagerClient({ region: REGION });

  // Checked before the prompt, so nobody pastes a list of live API keys into a process that
  // was never going to be able to store them.
  try {
    await client.send(new DescribeSecretCommand({ SecretId: secretId }));
  } catch (error) {
    if ((error as { name?: string }).name === 'ResourceNotFoundException') {
      throw new Error(`No secret with id ${secretId} in ${REGION}.`);
    }
    throw new Error(`Cannot reach ${secretId} in ${REGION}: ${(error as Error).message}`);
  }

  console.error('Paste "tableId:apiKey,…" then press ctrl-D:');
  const reader = createInterface({ input: process.stdin });
  let raw = '';
  for await (const line of reader) raw += line;

  const seats = parse(raw.trim());

  await client.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: raw.trim() }));

  const byTable = new Map<string, number>();
  for (const seat of seats) byTable.set(seat.tableId, (byTable.get(seat.tableId) ?? 0) + 1);
  console.error(
    `\nStored ${seats.length} seat(s): ` +
      [...byTable].map(([table, n]) => `${table}×${n}`).join(', '),
  );
  console.error('The bot fleet picks it up within about twenty seconds.');
}

main().catch((error: Error) => {
  console.error(`\nFailed: ${error.message}`);
  process.exit(1);
});
