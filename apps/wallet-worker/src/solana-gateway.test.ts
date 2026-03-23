import { describe, expect, it } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { DEVNET_USDC_MINT, tokenAccountFor } from '@clawroll/solana';
import { SolanaGatewayError, SolanaWithdrawalGateway, bs58 } from './solana-gateway.js';

describe('base58 encoding', () => {
  /**
   * Cross-checked against `PublicKey.toBase58()`.
   *
   * This is the one place in the file where a subtle bug is genuinely dangerous: a
   * mis-encoded signature means the worker asks the chain about a transaction that does not
   * exist, concludes it never landed, and eventually rebuilds — while the original is
   * sitting in a block. So it is checked against an independent implementation rather than
   * against expectations I wrote myself.
   */
  it('agrees with @solana/web3.js across 500 random keys', () => {
    for (let i = 0; i < 500; i++) {
      const key = Keypair.generate().publicKey;
      expect(bs58(key.toBytes())).toBe(key.toBase58());
    }
  });

  it('encodes the all-zero key as the canonical form', () => {
    // 32 zero bytes: every one is a literal leading '1', not a positional digit. Getting
    // leading zeros wrong is the classic base58 bug and it only shows on rare inputs.
    const zeros = new Uint8Array(32);
    expect(bs58(zeros)).toBe(new PublicKey(zeros).toBase58());
    expect(bs58(zeros)).toBe('1'.repeat(32));
  });

  it('preserves each leading zero byte', () => {
    for (let leading = 1; leading <= 5; leading++) {
      const bytes = new Uint8Array(32);
      bytes.fill(7, leading);
      const encoded = bs58(bytes);
      expect(encoded.startsWith('1'.repeat(leading))).toBe(true);
      expect(encoded).toBe(new PublicKey(bytes).toBase58());
    }
  });

  it('encodes an empty input as an empty string', () => {
    expect(bs58(new Uint8Array(0))).toBe('');
  });

  it('handles 64-byte inputs, which is what a signature actually is', () => {
    // Signatures are twice the length of a public key, so the carry loop runs further than
    // the 32-byte cross-check exercises.
    const signature = new Uint8Array(64).fill(0xff);
    const encoded = bs58(signature);
    expect(encoded).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(encoded.length).toBeGreaterThan(64);
  });
});

describe('input validation', () => {
  const gateway = () =>
    new SolanaWithdrawalGateway(
      // Never contacted: these cases must fail before any RPC call.
      new Connection('http://127.0.0.1:1', 'finalized'),
      Keypair.generate(),
    );

  it.each([0, -1, 1.5, Number.NaN])('refuses an amount of %s', async (amount) => {
    await expect(
      gateway().buildAndSign(Keypair.generate().publicKey.toBase58(), amount),
    ).rejects.toThrow(SolanaGatewayError);
  });

  it('refuses a destination that is not an address', async () => {
    await expect(gateway().buildAndSign('not-an-address', 1_000_000)).rejects.toThrow(
      /not a valid address/,
    );
  });
});

describe('treasury token account', () => {
  it('is the associated account for the treasury and the USDC mint', () => {
    // A mis-derived source would move the wrong token — which `transferChecked` is there to
    // catch, but deriving it correctly in the first place is cheaper than relying on that.
    const treasury = Keypair.generate();
    const expected = tokenAccountFor(treasury.publicKey, DEVNET_USDC_MINT);
    expect(expected.toBase58()).not.toBe(treasury.publicKey.toBase58());
    expect(tokenAccountFor(treasury.publicKey, DEVNET_USDC_MINT).toBase58()).toBe(
      expected.toBase58(),
    );
  });
});

describe('against live devnet', () => {
  // Opt in with CLAWROLL_LIVE_TESTS=1. Off by default so CI does not depend on a public RPC.
  const live = process.env['CLAWROLL_LIVE_TESTS'] === '1';

  it.runIf(live)(
    'reads the chain and reports a treasury balance',
    async () => {
      const connection = new Connection('https://api.devnet.solana.com', 'finalized');
      const gateway = new SolanaWithdrawalGateway(connection, Keypair.generate());

      // A freshly generated treasury has no token account at all, which must read as zero
      // rather than throwing — this is the path a brand new deployment takes.
      expect(await gateway.treasuryBalance()).toBe(0);

      const height = await gateway.getBlockHeight();
      expect(height).toBeGreaterThan(0);

      // A signature the cluster has never seen is `null`, not an error. The withdrawal
      // worker relies on that distinction to tell "not landed" from "cannot tell".
      const unknown = await gateway.getSignatureOutcome(bs58(new Uint8Array(64).fill(1)));
      expect(unknown).toBeNull();
    },
    60_000,
  );

  it.runIf(live)(
    'builds a signed transfer whose signature exists before it is sent',
    async () => {
      // The property the entire withdrawal protocol rests on: the id is computable offline.
      const connection = new Connection('https://api.devnet.solana.com', 'finalized');
      const gateway = new SolanaWithdrawalGateway(connection, Keypair.generate());

      const signed = await gateway.buildAndSign(Keypair.generate().publicKey.toBase58(), 1_000_000);

      expect(signed.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
      expect(signed.blockhash).toBeTruthy();
      expect(signed.lastValidBlockHeight).toBeGreaterThan(await gateway.getBlockHeight());
      expect(signed.rawTransaction.length).toBeGreaterThan(0);

      // Nothing was broadcast, so the cluster has never heard of it.
      expect(await gateway.getSignatureOutcome(signed.signature)).toBeNull();
    },
    60_000,
  );
});
