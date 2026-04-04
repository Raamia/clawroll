import { describe, expect, it } from 'vitest';
import { Connection } from '@solana/web3.js';
import {
  ALLOWED_CLUSTER,
  DEVNET_USDC_MINT,
  GENESIS_HASHES,
  MICROS_PER_USDC,
  ClusterUnreachableError,
  WrongClusterError,
  assertDevnet,
  clusterFromGenesisHash,
  microsToUsdc,
  usdcToMicros,
} from './cluster.js';

/** A Connection stub that reports whatever genesis hash a test wants. */
function connectionReporting(hash: string | Error): Connection {
  return {
    getGenesisHash: async () => {
      if (hash instanceof Error) throw hash;
      return hash;
    },
  } as unknown as Connection;
}

describe('the devnet guard', () => {
  it('accepts devnet', async () => {
    await expect(assertDevnet(connectionReporting(GENESIS_HASHES.devnet))).resolves.toBeUndefined();
  });

  it('refuses mainnet-beta', async () => {
    // The whole reason this file exists. Devnet USDC has no market value, which is what
    // keeps Clawroll a test system rather than a gambling operation.
    await expect(
      assertDevnet(connectionReporting(GENESIS_HASHES['mainnet-beta'])),
    ).rejects.toThrow(WrongClusterError);
  });

  it('refuses testnet', async () => {
    await expect(assertDevnet(connectionReporting(GENESIS_HASHES.testnet))).rejects.toThrow(
      /Refusing to run against testnet/,
    );
  });

  it('refuses a cluster it does not recognise', async () => {
    // A private validator or a re-pointed proxy. Unknown is not permission.
    await expect(assertDevnet(connectionReporting('SomeOtherGenesisHash11111'))).rejects.toThrow(
      /unknown cluster/,
    );
  });

  it('refuses to continue when the cluster cannot be verified at all', async () => {
    // An unreachable RPC must not be treated as "probably fine". Failing closed is the
    // only safe reading when the question is "is this real money?".
    await expect(
      assertDevnet(connectionReporting(new Error('ECONNREFUSED'))),
    ).rejects.toThrow(/Refusing to continue rather than assume/);
  });

  it('distinguishes an unreachable endpoint from the wrong chain', async () => {
    // The two demand opposite responses from a caller. Being on the wrong chain is a
    // configuration error that will not fix itself and must stop a deploy. Being unable to
    // reach the endpoint is usually a blip, and treating it as fatal means a momentary
    // network hiccup takes a service down — which, with an ECS circuit breaker watching,
    // rolls back an entire stack. The wallet worker retries one and not the other, and it
    // can only do that if they are different types.
    //
    // Neither ever permits proceeding unverified; both still reject. That is the property
    // this pair of assertions is protecting, and the distinction does not weaken it.
    await expect(
      assertDevnet(connectionReporting(new Error('ECONNREFUSED'))),
    ).rejects.toThrow(ClusterUnreachableError);

    await expect(
      assertDevnet(connectionReporting(GENESIS_HASHES['mainnet-beta'])),
    ).rejects.toThrow(WrongClusterError);

    // And not each other's, so a caller's `instanceof` check cannot quietly match both.
    await expect(
      assertDevnet(connectionReporting(new Error('ECONNREFUSED'))),
    ).rejects.not.toThrow(WrongClusterError);
  });

  it('identifies each known cluster by hash', () => {
    expect(clusterFromGenesisHash(GENESIS_HASHES.devnet)).toBe('devnet');
    expect(clusterFromGenesisHash(GENESIS_HASHES['mainnet-beta'])).toBe('mainnet-beta');
    expect(clusterFromGenesisHash('nonsense')).toBeNull();
  });

  it('is pinned to devnet', () => {
    // If this ever needs to change, it is a code review, not a config change.
    expect(ALLOWED_CLUSTER).toBe('devnet');
  });
});

describe('USDC amounts', () => {
  it('uses six decimals', () => {
    expect(MICROS_PER_USDC).toBe(1_000_000);
  });

  it('converts USDC to the integer unit the ledger stores', () => {
    expect(usdcToMicros(1)).toBe(1_000_000);
    expect(usdcToMicros(0.000001)).toBe(1);
    expect(usdcToMicros(12.345678)).toBe(12_345_678);
  });

  it('rounds rather than truncating a sub-micro amount', () => {
    // Floating point will hand us 0.1 + 0.2 style values; truncating would quietly lose
    // a micro-USDC on every conversion.
    expect(usdcToMicros(0.0000004)).toBe(0);
    expect(usdcToMicros(0.0000006)).toBe(1);
  });

  it('refuses an amount it cannot represent exactly', () => {
    expect(() => usdcToMicros(1e12)).toThrow(/out of range/);
  });

  it('renders micros for humans without doing arithmetic in the result', () => {
    expect(microsToUsdc(1_000_000)).toBe('1.000000');
    expect(microsToUsdc(12_345_678)).toBe('12.345678');
    expect(microsToUsdc(1)).toBe('0.000001');
    expect(microsToUsdc(-2_500_000)).toBe('-2.500000');
    expect(microsToUsdc(0)).toBe('0.000000');
  });

  it('round-trips through the string form', () => {
    for (const micros of [0, 1, 999_999, 1_000_000, 12_345_678, 987_654_321]) {
      expect(usdcToMicros(Number(microsToUsdc(micros)))).toBe(micros);
    }
  });
});

describe('the devnet USDC mint', () => {
  it('is Circle’s published devnet mint', () => {
    // Pinned literally: a wrong mint would credit deposits of a token nobody wanted.
    expect(DEVNET_USDC_MINT.toBase58()).toBe('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  });
});

describe('against the live network', () => {
  // Opt-in with CLAWROLL_LIVE_TESTS=1. Off by default so CI does not go flaky when the
  // public RPC is rate-limited or unreachable, but worth running before a deploy: every
  // other test in this file takes the genesis constants on trust, and this is the only
  // one that checks them against reality.
  //
  // A wrong devnet hash fails *closed* — the guard would reject the real devnet and
  // Clawroll would refuse to start. Loud, but only at the moment you deploy.
  const live = process.env['CLAWROLL_LIVE_TESTS'] === '1';

  it.runIf(live)(
    'matches the real devnet genesis hash',
    async () => {
      const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
      expect(await connection.getGenesisHash()).toBe(GENESIS_HASHES.devnet);
      await expect(assertDevnet(connection)).resolves.toBeUndefined();
    },
    30_000,
  );

  it.runIf(live)(
    'refuses the real mainnet-beta',
    async () => {
      const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
      expect(await connection.getGenesisHash()).toBe(GENESIS_HASHES['mainnet-beta']);
      await expect(assertDevnet(connection)).rejects.toThrow(WrongClusterError);
    },
    30_000,
  );
});
