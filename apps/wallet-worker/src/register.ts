#!/usr/bin/env node
/**
 * Register an agent.
 *
 *   pnpm --filter @clawroll/wallet-worker register "my-bot"
 *
 * Lives in the wallet worker because creating an agent means deriving its deposit address,
 * which means holding the master seed — and that seed lives in exactly one process. Adding a
 * second one that needs it would double the blast radius of a compromise for the sake of
 * convenience.
 *
 * ## The API key is printed once and never stored
 *
 * Only its SHA-256 and a lookup prefix go in the database. If the operator loses it, the key
 * is gone and a new one has to be issued — which is the correct behaviour and worth being
 * blunt about at the point of printing, rather than discovering later.
 */

import { Keypair } from '@solana/web3.js';
import { createSql, migrate } from '@clawroll/db';
import { deriveDepositAccount, masterSeedFromMnemonic } from '@clawroll/solana';
import { issueKey } from '@clawroll/engine';

async function main(): Promise<void> {
  const displayName = process.argv[2];
  if (!displayName) {
    console.error('usage: register <display-name>');
    process.exit(1);
  }

  const mnemonic = process.env['SOLANA_MASTER_MNEMONIC'];
  if (!mnemonic) {
    console.error('SOLANA_MASTER_MNEMONIC must be set');
    process.exit(1);
  }
  const masterSeed = masterSeedFromMnemonic(mnemonic);

  const sql = createSql();
  await migrate(sql);

  try {
    // A sequence, not MAX(derivation_index) + 1.
    //
    // MAX+1 is racy — two concurrent registrations read the same value and one loses on the
    // UNIQUE constraint — and it is fragile: one row with a large index breaks every future
    // registration, since BIP-44 hardened indices must fit in an int32. That is not
    // hypothetical; it broke the first time this CLI was run, against a database whose test
    // fixtures had inserted indices up to 2^40. `nextval` is atomic and cannot be poisoned
    // by an unrelated row. Index 0 is the treasury, so the sequence starts at 1.
    const rows = await sql<{ next: string }[]>`
      SELECT nextval('agent_derivation_index_seq')::text AS next`;
    const derivationIndex = Number(rows[0]!.next);

    const account = deriveDepositAccount(masterSeed, derivationIndex);
    const agentId = `agent_${Keypair.generate().publicKey.toBase58().slice(0, 16)}`;
    const issued = issueKey(agentId, displayName);

    await sql`
      INSERT INTO agents (id, display_name, key_prefix, key_hash, derivation_index, deposit_address)
      VALUES (${agentId}, ${displayName}, ${issued.record.keyPrefix}, ${issued.record.keyHash},
              ${derivationIndex}, ${account.tokenAccount.toBase58()})`;

    console.log('');
    console.log(`  agent          ${agentId}`);
    console.log(`  name           ${displayName}`);
    console.log(`  api key        ${issued.apiKey}`);
    console.log('');
    // Which of these two addresses to hand a sender is not a detail — getting it wrong
    // loses the money silently.
    //
    // A faucet or wallet takes an *owner* address and derives the associated token account
    // itself. Give it the token account instead and it derives the ATA *of the ATA* — a
    // real, different, empty account that nothing in this system watches. The transfer
    // succeeds, the explorer shows it landed, and the agent is never credited.
    //
    // So the owner address is the one presented as the thing to send to, and the token
    // account is labelled as what the scanner watches rather than as an address to use.
    console.log(`  send USDC to   ${account.owner.toBase58()}`);
    console.log(`  (watched ATA)  ${account.tokenAccount.toBase58()}`);
    console.log('');
    // Blunt on purpose. Only the hash is stored, so "I lost it" means "issue a new one".
    console.log('  The API key is shown once and is not recoverable. Store it now.');
    console.log('');
    console.log('  Fund it with devnet USDC at https://faucet.circle.com — paste the');
    console.log('  "send USDC to" address above, not the ATA. The faucet derives the ATA');
    console.log('  itself; giving it the ATA sends the money somewhere nothing watches.');
    console.log('');
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error('registration failed:', error);
  process.exit(1);
});
