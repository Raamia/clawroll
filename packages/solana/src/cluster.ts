/**
 * Cluster identification and the devnet guard.
 *
 * ## Why this file exists
 *
 * Clawroll runs on Solana **devnet**, where USDC is faucet-issued and has no market value.
 * That is not a convenience — it is the property that keeps the whole system a test
 * harness rather than a gambling operation, with everything that would follow from the
 * latter. So it needs to be structural, not a config value one typo away from real money.
 *
 * ## The guard checks the genesis hash, not the URL
 *
 * A URL string tells you nothing. `https://api.devnet.solana.com` could be re-pointed by
 * DNS, a proxy, a hosts file, or a paid RPC provider that silently defaults to mainnet
 * when a key expires. A URL containing the word "devnet" is a *claim about* a cluster, not
 * evidence of one.
 *
 * The genesis hash is the cluster's identity. `assertDevnet` asks the endpoint what chain
 * it is actually on and refuses to continue unless the answer is devnet's genesis hash.
 * Pointing Clawroll at real money therefore requires editing this file — a deliberate,
 * reviewable act — rather than editing an environment variable.
 *
 * This is not legal advice. It is the mechanism that makes the devnet-only claim true in
 * code rather than merely intended.
 */

import { Connection, PublicKey } from '@solana/web3.js';

/** Genesis hashes identify a Solana cluster. These are fixed and public. */
export const GENESIS_HASHES = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
} as const;

export type ClusterName = keyof typeof GENESIS_HASHES;

/** The only cluster Clawroll is permitted to run against. */
export const ALLOWED_CLUSTER: ClusterName = 'devnet';

/**
 * Circle's USDC mint on devnet.
 *
 * Faucet at https://faucet.circle.com (2 hours per address). This is a test asset with no
 * market value, which is the entire point.
 */
export const DEVNET_USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

/** USDC has 6 decimals, so one USDC is 1,000,000 micro-USDC — the ledger's unit. */
export const USDC_DECIMALS = 6;
export const MICROS_PER_USDC = 10 ** USDC_DECIMALS;

export class WrongClusterError extends Error {}

/** Identify a cluster from its genesis hash, or `null` if it is not one we know. */
export function clusterFromGenesisHash(hash: string): ClusterName | null {
  for (const [name, known] of Object.entries(GENESIS_HASHES) as [ClusterName, string][]) {
    if (known === hash) return name;
  }
  return null;
}

/**
 * Refuse to continue unless the endpoint really is devnet.
 *
 * Call this once at startup, before anything touches a key or signs anything. It costs one
 * RPC round trip and is the difference between "we intended to be on devnet" and "we are
 * on devnet".
 */
export async function assertDevnet(connection: Connection): Promise<void> {
  let hash: string;
  try {
    hash = await connection.getGenesisHash();
  } catch (error) {
    throw new WrongClusterError(
      `could not verify the Solana cluster: ${(error as Error).message}. ` +
        'Refusing to start rather than assume.',
    );
  }

  const cluster = clusterFromGenesisHash(hash);
  if (cluster === ALLOWED_CLUSTER) return;

  throw new WrongClusterError(
    `Refusing to run against ${cluster ?? `an unknown cluster (genesis ${hash})`}. ` +
      `Clawroll is devnet-only: devnet USDC has no market value, which is what keeps this ` +
      `a test system. Moving to real value is a deliberate code change, not a config change.`,
  );
}

/** Convert a USDC amount to the integer micro-USDC the ledger stores. */
export function usdcToMicros(usdc: number): number {
  const micros = Math.round(usdc * MICROS_PER_USDC);
  if (!Number.isSafeInteger(micros)) throw new Error(`amount out of range: ${usdc} USDC`);
  return micros;
}

/** Render micro-USDC for humans. Never used for arithmetic. */
export function microsToUsdc(micros: number): string {
  const sign = micros < 0 ? '-' : '';
  const absolute = Math.abs(micros);
  const whole = Math.floor(absolute / MICROS_PER_USDC);
  const fraction = String(absolute % MICROS_PER_USDC).padStart(USDC_DECIMALS, '0');
  return `${sign}${whole}.${fraction}`;
}
