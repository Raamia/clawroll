#!/usr/bin/env node
/**
 * Generate the Solana master mnemonic.
 *
 * Run this once, ever. Every deposit address in the system is derived from the result, so
 * losing it means losing the ability to spend anything that was ever deposited, and leaking
 * it means someone else can.
 *
 * Prints to stdout and nothing else, so it can be piped — but piping it straight into
 * `put-secret` is a mistake worth naming: a seed that exists only in AWS is a seed you cannot
 * recover when the secret is deleted. Write it down first.
 */

import { generateMasterMnemonic, masterSeedFromMnemonic } from '@clawroll/solana';

const mnemonic = generateMasterMnemonic();

// Round-tripped before it is shown. A phrase that fails its own checksum would be stored,
// used to derive addresses, and only fail when the wallet worker started — after deposits
// could already have been sent to addresses nobody can spend.
masterSeedFromMnemonic(mnemonic);

console.log(mnemonic);
