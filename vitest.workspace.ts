/**
 * Two projects: pure tests run in parallel, database tests run one at a time.
 *
 * Every suite that touches Postgres shares a single local instance. Run in parallel they
 * contend for connections and CPU, and the symptom is not a clear failure — it is an
 * integration test timing out while waiting for a drain loop that is simply starved. That
 * looks exactly like a logic bug and is not, which is the most expensive kind of flake.
 *
 * The history here is worth recording. The first mitigation was a longer polling timeout,
 * which held until a new suite was added and then failed again — because the problem was
 * never the timeout, it was unbounded concurrency against one database. Adding the SDK suite
 * pushed it back over the line. Serialising the database project removes the contention
 * rather than out-waiting it.
 *
 * The pure project keeps full parallelism, which is where nearly all the wall-clock is: the
 * shuffle statistics and the evaluator's brute-force cross-check.
 */
export default [
  {
    test: {
      name: 'pure',
      include: [
        'packages/poker/src/**/*.test.ts',
        'packages/shuffle/src/**/*.test.ts',
        'packages/protocol/src/**/*.test.ts',
        'packages/solana/src/**/*.test.ts',
        'apps/engine/src/table.test.ts',
        'apps/engine/src/server.test.ts',
        'apps/engine/src/bots/**/*.test.ts',
        'apps/wallet-worker/src/solana-gateway.test.ts',
      ],
      pool: 'threads',
    },
  },
  {
    test: {
      name: 'database',
      include: [
        'packages/db/src/**/*.test.ts',
        'packages/sdk-ts/src/**/*.test.ts',
        'apps/engine/src/bankroll.test.ts',
        'apps/engine/src/wired.test.ts',
        'apps/engine/src/archive.test.ts',
        'apps/engine/src/agent-directory.test.ts',
        'apps/wallet-worker/src/scanner.test.ts',
        'apps/wallet-worker/src/withdrawals.test.ts',
      ],
      // One file at a time against one Postgres.
      fileParallelism: false,
      pool: 'threads',
      poolOptions: { threads: { singleThread: true } },
    },
  },
];
