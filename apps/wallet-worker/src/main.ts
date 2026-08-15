/**
 * Production entry point for the wallet worker.
 *
 * Two loops in one process: scan for deposits, advance withdrawals. They share a database
 * pool and a Solana connection and neither is remotely CPU-bound, so splitting them into
 * separate services would double the cost and the deployment surface for no benefit.
 *
 * ## It refuses to start unless the cluster really is devnet
 *
 * `assertDevnet` runs before a key is loaded or a transaction is built. This is the process
 * that holds the master seed and signs transfers, so it is the one place where being wrong
 * about which chain we are on has consequences that cannot be undone.
 */

import { Connection, Keypair } from '@solana/web3.js';
import { Ledger, createSql, migrate } from '@clawroll/db';
import { loadMasterMnemonic } from './master-seed.js';
import { Rebalancer } from './rebalance.js';
import {
  ClusterUnreachableError,
  assertDevnet,
  deriveKeypair,
  masterSeedFromMnemonic,
} from '@clawroll/solana';
import { RpcGateway } from '@clawroll/solana';
import { DepositScanner } from './scanner.js';
import { SolanaWithdrawalGateway } from './solana-gateway.js';
import { WithdrawalWorker } from './withdrawals.js';

/** Derivation index reserved for the treasury; agent deposit addresses start at 1. */
const TREASURY_INDEX = 0;

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got ${raw}`);
  return parsed;
}


async function main(): Promise<void> {
  const rpcUrl = process.env['SOLANA_RPC_URL'] ?? 'https://api.devnet.solana.com';
  const connection = new Connection(rpcUrl, 'finalized');

  // Before anything touches a key. The genesis hash is checked, not the URL — see
  // `@clawroll/solana`. An unreachable RPC fails closed rather than being assumed fine.
  //
  // Retried, but only when the endpoint did not answer. A momentary blip during a deploy
  // would otherwise exit the process, and with an ECS circuit breaker watching, that is not
  // a restart — it is a rollback of the entire stack. Being on the *wrong* chain is the
  // opposite case: it will not fix itself and must stop the deploy, so it is left to throw.
  //
  // Neither path ever proceeds unverified, which is the property that matters.
  for (;;) {
    try {
      await assertDevnet(connection);
      break;
    } catch (error) {
      if (!(error instanceof ClusterUnreachableError)) throw error;
      console.error(`[clawroll] ${(error as Error).message} Retrying in 10s.`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  console.log(`[clawroll] cluster verified as devnet via ${rpcUrl}`);

  // The whole custody position. Never written to disk or logged.
  const masterSeed = masterSeedFromMnemonic(await loadMasterMnemonic({ wait: true }));
  const treasury: Keypair = deriveKeypair(masterSeed, TREASURY_INDEX);
  console.log(`[clawroll] treasury ${treasury.publicKey.toBase58()}`);

  const sql = createSql();
  await migrate(sql);
  const ledger = new Ledger(sql);

  const scanner = new DepositScanner(sql, ledger, new RpcGateway(connection), {
    minimumMicros: number('MIN_DEPOSIT_MICROS', 0),
  });
  const withdrawals = new WithdrawalWorker(
    sql,
    ledger,
    new SolanaWithdrawalGateway(connection, treasury),
  );

  const scanIntervalMs = number('SCAN_INTERVAL_MS', 15_000);
  let running = true;

  // Sequential rather than two independent timers: both hit the same RPC endpoint, and
  // public devnet is rate-limited enough that overlapping bursts cause errors that look
  // like chain problems and are not.
  const loop = async () => {
    while (running) {
      try {
        const summary = await scanner.scanOnce();
        if (summary.depositsCredited > 0 || summary.failures.length > 0) {
          console.log(
            `[clawroll] deposits credited=${summary.depositsCredited} ` +
              `replays=${summary.replaysIgnored} failures=${summary.failures.length}`,
          );
          // Print why, not just how many.
          //
          // `ScanSummary` has carried a reason per failure since it was written and nothing
          // ever logged it, so a scanner failing every cycle produced `failures=1` forever
          // and no way to find out what. A deposit that silently never credits is the worst
          // failure mode in this system; a count with no cause is barely better than silence.
          //
          // One line per failure, capped, because a broken RPC endpoint fails on every
          // address every fifteen seconds and would otherwise bury everything else.
          for (const failure of summary.failures.slice(0, 5)) {
            console.error(`[clawroll]   ${failure.signature}: ${failure.reason}`);
          }
          if (summary.failures.length > 5) {
            console.error(`[clawroll]   … and ${summary.failures.length - 5} more`);
          }
        }

        for (const withdrawal of await withdrawals.pending()) {
          const after = await withdrawals.advance(withdrawal.id);
          if (after.status !== withdrawal.status) {
            console.log(`[clawroll] withdrawal ${after.id} ${withdrawal.status} → ${after.status}`);
          }
        }

        // Loud, because both mean money is stuck somewhere a user can see.
        const stranded = await scanner.findUncreditedDeposits();
        if (stranded.length > 0) {
          console.error(`[clawroll] ALERT ${stranded.length} deposit(s) on chain but uncredited`);
        }
        const stuck = await withdrawals.findStuck();
        if (stuck.length > 0) {
          console.error(`[clawroll] ALERT ${stuck.length} withdrawal(s) repeatedly retried`);
        }
      } catch (error) {
        // Never let one bad pass kill the loop: the next one retries, and everything it does
        // is idempotent.
        console.error(`[clawroll] worker pass failed: ${(error as Error).message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, scanIntervalMs));
    }
  };

  void loop();
  console.log(`[clawroll] wallet worker running, scanning every ${scanIntervalMs}ms`);

  // Keeping the house bots in the game.
  //
  // Lives here rather than in the bot fleet because this is the process that owns money
  // movement and has the database; the fleet is a client and should stay one. Off unless a
  // floor is configured, so a room with no house bots runs exactly as before.
  //
  // Ten minutes is deliberately slow. A bot that busts re-buys from its own bankroll and
  // keeps playing; this only matters once the bankroll itself is gone, which is a slow
  // process. Running it often would mostly be querying to find nothing to do.
  const rebalanceFloor = number('REBALANCE_FLOOR_MICROS', 0);
  if (rebalanceFloor > 0) {
    const rebalancer = new Rebalancer(sql, ledger, {
      floorMicros: rebalanceFloor,
      targetMicros: number('REBALANCE_TARGET_MICROS', rebalanceFloor * 4),
    });
    const rebalanceIntervalMs = number('REBALANCE_INTERVAL_MS', 600_000);

    const rebalanceLoop = async () => {
      while (running) {
        try {
          const result = await rebalancer.runOnce();
          for (const t of result.transfers) {
            // Logged individually. This moves somebody's chips, so it should never be
            // something you have to go digging in the ledger to discover happened.
            console.log(
              `[clawroll] rebalance ${(t.amountMicros / 1_000_000).toFixed(2)} USDC ` +
                `${t.from} → ${t.to}`,
            );
          }
        } catch (error) {
          console.error(`[clawroll] rebalance failed: ${(error as Error).message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, rebalanceIntervalMs));
      }
    };
    void rebalanceLoop();
    console.log(
      `[clawroll] rebalancing house bots below ${(rebalanceFloor / 1_000_000).toFixed(2)} USDC ` +
        `every ${rebalanceIntervalMs}ms`,
    );
  }

  const shutdown = async (signal: string) => {
    console.log(`[clawroll] ${signal} received, shutting down`);
    running = false;
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error('[clawroll] wallet worker failed to start:', error);
  process.exit(1);
});
