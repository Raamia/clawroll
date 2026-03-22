import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { DEVNET_USDC_MINT } from './cluster.js';
import {
  DerivationError,
  deriveDepositAccount,
  deriveKeypair,
  derivationPath,
  generateMasterMnemonic,
  masterSeedFromMnemonic,
  tokenAccountFor,
} from './derivation.js';

/** The BIP-39 test vector, so derivations are reproducible and reviewable. */
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = masterSeedFromMnemonic(TEST_MNEMONIC);

describe('master seed', () => {
  it('generates a 24-word mnemonic', () => {
    expect(generateMasterMnemonic().split(' ')).toHaveLength(24);
  });

  it('rejects a mnemonic that fails its checksum', () => {
    // A mistyped word derives a *different valid seed* whose addresses nobody can spend.
    // BIP-39's checksum exists to catch exactly that, so it is checked rather than trusted.
    const typo = TEST_MNEMONIC.replace(/about$/, 'zoo');
    expect(() => masterSeedFromMnemonic(typo)).toThrow(DerivationError);
  });

  it('tolerates ragged whitespace', () => {
    const messy = `  ${TEST_MNEMONIC.replace(/ /g, '   ')}  `;
    expect(masterSeedFromMnemonic(messy).equals(seed)).toBe(true);
  });

  it('derives a different seed under a passphrase', () => {
    expect(masterSeedFromMnemonic(TEST_MNEMONIC, 'extra').equals(seed)).toBe(false);
  });
});

describe('derivation paths', () => {
  it('uses the standard Solana BIP-44 path', () => {
    // Standard on purpose: the same mnemonic opens these accounts in Phantom or the
    // Solana CLI if recovery is ever needed.
    expect(derivationPath(0)).toBe("m/44'/501'/0'/0'");
    expect(derivationPath(7)).toBe("m/44'/501'/7'/0'");
  });

  it.each([-1, 1.5, 2 ** 31, Number.NaN])('rejects index %s', (index) => {
    expect(() => derivationPath(index)).toThrow(DerivationError);
  });
});

describe('deposit accounts', () => {
  it('is deterministic for a given seed and index', () => {
    const a = deriveDepositAccount(seed, 0);
    const b = deriveDepositAccount(seed, 0);
    expect(a.owner.toBase58()).toBe(b.owner.toBase58());
    expect(a.tokenAccount.toBase58()).toBe(b.tokenAccount.toBase58());
  });

  it('gives every index a distinct address', () => {
    // Two agents sharing an address would have the scanner credit whoever it looked up
    // first — silently paying the wrong account.
    const owners = new Set<string>();
    const tokenAccounts = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const account = deriveDepositAccount(seed, i);
      owners.add(account.owner.toBase58());
      tokenAccounts.add(account.tokenAccount.toBase58());
    }
    expect(owners.size).toBe(200);
    expect(tokenAccounts.size).toBe(200);
  });

  it('derives different addresses from a different master seed', () => {
    const other = masterSeedFromMnemonic(generateMasterMnemonic());
    expect(deriveDepositAccount(other, 0).owner.toBase58()).not.toBe(
      deriveDepositAccount(seed, 0).owner.toBase58(),
    );
  });

  it('produces a valid ed25519 public key', () => {
    const { owner } = deriveDepositAccount(seed, 3);
    expect(PublicKey.isOnCurve(owner.toBytes())).toBe(true);
  });

  it('separates the owner address from the token account', () => {
    // Tokens never land on the owner address itself — they land in the ATA, which is a
    // different account that must exist first. Conflating them is the classic
    // "my deposit vanished" bug.
    const { owner, tokenAccount } = deriveDepositAccount(seed, 0);
    expect(tokenAccount.toBase58()).not.toBe(owner.toBase58());
    expect(tokenAccount.toBase58()).toBe(tokenAccountFor(owner).toBase58());
  });

  it('derives the token account for the devnet USDC mint', () => {
    const { owner, tokenAccount } = deriveDepositAccount(seed, 11);
    expect(tokenAccountFor(owner, DEVNET_USDC_MINT).toBase58()).toBe(tokenAccount.toBase58());
  });

  it('gives a different token account for a different mint', () => {
    const { owner } = deriveDepositAccount(seed, 0);
    const otherMint = new PublicKey('So11111111111111111111111111111111111111112');
    expect(tokenAccountFor(owner, otherMint).toBase58()).not.toBe(
      tokenAccountFor(owner, DEVNET_USDC_MINT).toBase58(),
    );
  });
});

describe('keypairs', () => {
  it('derives a signing key whose public half matches the deposit account', () => {
    expect(deriveKeypair(seed, 5).publicKey.toBase58()).toBe(
      deriveDepositAccount(seed, 5).owner.toBase58(),
    );
  });

  it('produces distinct secrets per index', () => {
    const a = Buffer.from(deriveKeypair(seed, 0).secretKey);
    const b = Buffer.from(deriveKeypair(seed, 1).secretKey);
    expect(a.equals(b)).toBe(false);
  });
});
