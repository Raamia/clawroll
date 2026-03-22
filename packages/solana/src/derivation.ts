/**
 * Deposit address derivation.
 *
 * ## One master seed, no per-agent secrets
 *
 * Every agent gets its own deposit address, derived deterministically from a single master
 * seed at `m/44'/501'/{index}'/0'` — the standard Solana path, so the same seed phrase
 * opens these accounts in Phantom or the Solana CLI if it is ever needed.
 *
 * The alternative is generating a keypair per agent and storing each encrypted secret. That
 * means a growing collection of secrets to protect, rotate, back up, and eventually leak.
 * Here there is exactly one secret. It lives in AWS Secrets Manager under a KMS CMK, and
 * every address in the system is a pure function of it plus an integer.
 *
 * A consequence worth stating plainly: **the master seed is the entire custody position.**
 * Losing it loses every deposit address; leaking it leaks all of them. On devnet that is
 * worth nothing, which is a good place to build the habits.
 *
 * ## Derivation indices are assigned once and never reused
 *
 * `agents.derivation_index` is `UNIQUE` in the schema. Reusing an index would give two
 * agents the same deposit address, and the scanner would credit whoever it looked up first
 * — silently paying the wrong account. The database makes that impossible rather than
 * relying on the allocator being careful.
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { derivePath } from 'ed25519-hd-key';
import { mnemonicToSeedSync, validateMnemonic, generateMnemonic } from 'bip39';
import { DEVNET_USDC_MINT } from './cluster.js';

/** BIP-44 coin type for Solana. */
export const SOLANA_COIN_TYPE = 501;

export interface DepositAccount {
  readonly derivationIndex: number;
  /** The owner address — what the HD path produces. */
  readonly owner: PublicKey;
  /**
   * Where USDC actually lands: the Associated Token Account for the mint.
   *
   * Tokens are never held by the owner address itself. An ATA is a separate account that
   * must exist before it can receive anything, and creating it costs rent — which the
   * platform pays, because a brand new agent has no SOL. Forgetting this is the classic
   * "my deposit vanished" bug: the transfer simply fails.
   */
  readonly tokenAccount: PublicKey;
}

export class DerivationError extends Error {}

/** Generate a fresh 24-word master mnemonic. Run once, then store it and never again. */
export function generateMasterMnemonic(): string {
  return generateMnemonic(256);
}

/**
 * Turn a master mnemonic into the seed bytes derivation works from.
 *
 * Validates the mnemonic rather than trusting it: a typo'd word silently produces a
 * *different valid seed*, which would generate a whole set of addresses nobody holds the
 * keys to. The checksum built into BIP-39 exists precisely to catch that, so it is checked.
 */
export function masterSeedFromMnemonic(mnemonic: string, passphrase = ''): Buffer {
  const normalised = mnemonic.trim().replace(/\s+/g, ' ');
  if (!validateMnemonic(normalised)) {
    throw new DerivationError(
      'invalid master mnemonic: failed BIP-39 checksum. A mistyped word derives a ' +
        'different, valid-looking seed whose addresses nobody can spend.',
    );
  }
  return mnemonicToSeedSync(normalised, passphrase);
}

/** The BIP-44 path for an agent's deposit account. */
export function derivationPath(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= 2 ** 31) {
    throw new DerivationError(`derivation index must be a non-negative int32, got ${index}`);
  }
  return `m/44'/${SOLANA_COIN_TYPE}'/${index}'/0'`;
}

/** Derive the keypair for a deposit index. Only the wallet worker should ever call this. */
export function deriveKeypair(masterSeed: Buffer, index: number): Keypair {
  const { key } = derivePath(derivationPath(index), masterSeed.toString('hex'));
  return Keypair.fromSeed(key);
}

/**
 * Derive an agent's deposit account — public information only.
 *
 * Safe to call anywhere: it returns addresses, never a secret key. The API uses it to show
 * an agent where to send funds.
 */
export function deriveDepositAccount(
  masterSeed: Buffer,
  index: number,
  mint: PublicKey = DEVNET_USDC_MINT,
): DepositAccount {
  const owner = deriveKeypair(masterSeed, index).publicKey;
  return {
    derivationIndex: index,
    owner,
    tokenAccount: getAssociatedTokenAddressSync(mint, owner, true),
  };
}

/** The Associated Token Account for any owner and mint. */
export function tokenAccountFor(owner: PublicKey, mint: PublicKey = DEVNET_USDC_MINT): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true);
}
