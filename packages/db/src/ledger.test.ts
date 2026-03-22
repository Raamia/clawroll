import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Sql, createSql } from './client.js';
import { Ledger, LedgerError } from './ledger.js';
import { migrate } from './migrate.js';

/**
 * These run against real Postgres, not a fake.
 *
 * The UNIQUE constraint on `external_ref`, `SELECT … FOR UPDATE`, and transactional
 * rollback *are* the correctness mechanism here. A double that reimplemented them in
 * memory would be testing the double. Bring the database up with `pnpm dev:infra`.
 */
let sql: Sql;
let ledger: Ledger;

/** Every test uses fresh ids so the suite never depends on ordering or cleanup. */
async function newAgent(): Promise<string> {
  const id = `agent_${randomUUID()}`;
  await sql`
    INSERT INTO agents (id, display_name, key_prefix, key_hash, derivation_index, deposit_address)
    VALUES (${id}, ${'Bot'}, ${randomUUID()}, ${'hash'},
            ${Math.floor(Math.random() * 2 ** 40)}, ${randomUUID()})`;
  return id;
}

beforeAll(async () => {
  sql = createSql();
  await migrate(sql);
}, 30_000);

afterAll(async () => {
  await sql.end();
});

describe('the constraints actually exist on the database', () => {
  // schema.ts and migrate.ts declare the same shapes independently, so they can drift.
  // A constraint that was declared but never created is worse than none, because the
  // application is written trusting it.
  it('has a UNIQUE on ledger_txs.external_ref — the idempotency key', async () => {
    const rows = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'ledger_txs' AND indexdef ILIKE '%external_ref%'`;
    expect(rows.some((r) => r.indexdef.includes('UNIQUE'))).toBe(true);
  });

  it('bounds amounts to what JavaScript can represent exactly', async () => {
    const rows = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE contype = 'c' AND conrelid = 'ledger_entries'::regclass`;
    const names = rows.map((r) => r.conname);
    expect(names).toContain('ledger_entries_amount_safe_range');
    expect(names).toContain('ledger_entries_amount_nonzero');
  });

  it('allows exactly one system account per type', async () => {
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'accounts'`;
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('accounts_agent_type_key');
    expect(names).toContain('accounts_system_type_key');
  });

  it('rejects a zero-amount entry at the database level', async () => {
    const agentId = await newAgent();
    const account = await ledgerFor().ensureAccount(agentId, 'available');
    const txId = `ltx_${randomUUID()}`;
    await sql`INSERT INTO ledger_txs (id, kind) VALUES (${txId}, ${'adjustment'})`;
    await expect(
      sql`INSERT INTO ledger_entries (id, tx_id, account_id, amount_micros)
          VALUES (${`lde_${randomUUID()}`}, ${txId}, ${account}, ${0})`,
    ).rejects.toThrow();
  });
});

function ledgerFor(): Ledger {
  ledger ??= new Ledger(sql);
  return ledger;
}

describe('a transaction must balance', () => {
  it('rejects entries that do not sum to zero', async () => {
    const agentId = await newAgent();
    const available = await ledgerFor().ensureAccount(agentId, 'available');
    const house = await ledgerFor().ensureAccount(null, 'house');

    await expect(
      ledgerFor().postTransaction({
        kind: 'adjustment',
        entries: [
          { accountId: house, amountMicros: -100 },
          { accountId: available, amountMicros: 99 },
        ],
      }),
    ).rejects.toThrow(LedgerError);
  });

  it('rejects a single-sided transaction', async () => {
    const agentId = await newAgent();
    const available = await ledgerFor().ensureAccount(agentId, 'available');
    await expect(
      ledgerFor().postTransaction({
        kind: 'adjustment',
        entries: [{ accountId: available, amountMicros: 100 }],
      }),
    ).rejects.toThrow(/at least 2 entries/);
  });

  it('rejects a fractional amount', async () => {
    const agentId = await newAgent();
    const available = await ledgerFor().ensureAccount(agentId, 'available');
    const house = await ledgerFor().ensureAccount(null, 'house');
    await expect(
      ledgerFor().postTransaction({
        kind: 'adjustment',
        entries: [
          { accountId: house, amountMicros: -0.5 },
          { accountId: available, amountMicros: 0.5 },
        ],
      }),
    ).rejects.toThrow(/safe integer/);
  });

  it('rolls back entirely when a transaction is rejected', async () => {
    const agentId = await newAgent();
    const available = await ledgerFor().ensureAccount(agentId, 'available');
    const before = await ledgerFor().balanceOf(available);

    await expect(
      ledgerFor().postTransaction({
        kind: 'adjustment',
        entries: [
          { accountId: available, amountMicros: -1_000_000 },
          { accountId: await ledgerFor().ensureAccount(null, 'rake'), amountMicros: 1_000_000 },
        ],
      }),
    ).rejects.toThrow(/insufficient funds/);

    expect(await ledgerFor().balanceOf(available)).toBe(before);
  });
});

describe('deposits are idempotent', () => {
  it('credits once no matter how many times it is replayed', async () => {
    // Normal operation, not an error: a scanner sees the same signature again after a
    // restart, a retry, or an overlapping poll window.
    const agentId = await newAgent();
    const signature = `sig_${randomUUID()}`;

    const first = await ledgerFor().creditDeposit(agentId, 5_000_000, signature);
    expect(first.created).toBe(true);

    for (let i = 0; i < 5; i++) {
      const replay = await ledgerFor().creditDeposit(agentId, 5_000_000, signature);
      expect(replay.created).toBe(false);
      expect(replay.txId).toBe(first.txId);
    }

    expect(await ledgerFor().balanceOfAgent(agentId, 'available')).toBe(5_000_000);
  });

  it('credits once under concurrent replay', async () => {
    // The realistic failure: two scanner instances, or one restarting mid-poll, both
    // crediting the same signature at the same moment. The UNIQUE constraint plus the
    // in-transaction lookup is what makes this safe rather than merely unlikely.
    const agentId = await newAgent();
    const signature = `sig_${randomUUID()}`;

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => ledgerFor().creditDeposit(agentId, 1_000_000, signature)),
    );

    // Every caller must succeed, and exactly one must have done the crediting.
    //
    // An earlier version asserted only `succeeded.length > 0` and the correct balance,
    // and passed — while 7 of 8 callers were in fact receiving a raw Postgres 23505.
    // The money was right and the contract was broken, which is precisely the kind of
    // thing a loose assertion hides. `created` is now checked, not just the total.
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toEqual([]);

    const created = results.filter((r) => r.status === 'fulfilled' && r.value.created);
    expect(created).toHaveLength(1);

    const txIds = new Set(
      results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.txId] : [])),
    );
    expect(txIds.size).toBe(1);

    expect(await ledgerFor().balanceOfAgent(agentId, 'available')).toBe(1_000_000);
  });

  it('treats a different signature as a different deposit', async () => {
    const agentId = await newAgent();
    await ledgerFor().creditDeposit(agentId, 1_000_000, `sig_${randomUUID()}`);
    await ledgerFor().creditDeposit(agentId, 2_000_000, `sig_${randomUUID()}`);
    expect(await ledgerFor().balanceOfAgent(agentId, 'available')).toBe(3_000_000);
  });
});

describe('agent accounts cannot go negative', () => {
  it('refuses a withdrawal the agent cannot cover', async () => {
    const agentId = await newAgent();
    await ledgerFor().creditDeposit(agentId, 1_000_000, `sig_${randomUUID()}`);

    await expect(
      ledgerFor().debitWithdrawal(agentId, 2_000_000, randomUUID()),
    ).rejects.toThrow(/insufficient funds/);

    expect(await ledgerFor().balanceOfAgent(agentId, 'available')).toBe(1_000_000);
  });

  it('refuses a buy-in larger than the balance', async () => {
    const agentId = await newAgent();
    await ledgerFor().creditDeposit(agentId, 500_000, `sig_${randomUUID()}`);
    await expect(ledgerFor().buyIn(agentId, 900_000, randomUUID())).rejects.toThrow(
      /insufficient funds/,
    );
  });

  it('permits the house account to run negative — it is a liability position', async () => {
    const agentId = await newAgent();
    await ledgerFor().creditDeposit(agentId, 1_000_000, `sig_${randomUUID()}`);
    const house = await ledgerFor().ensureAccount(null, 'house');
    expect(await ledgerFor().balanceOf(house)).toBeLessThan(0);
  });

  it('leaves no agent account negative, ever', async () => {
    expect(await ledgerFor().findNegativeAgentAccounts()).toEqual([]);
  });
});

describe('concurrent transfers do not deadlock', () => {
  it('survives transfers touching the same accounts in opposite directions', async () => {
    // Without a deterministic lock order these deadlock — reliably, under load, at 3am.
    const agentId = await newAgent();
    await ledgerFor().creditDeposit(agentId, 10_000_000, `sig_${randomUUID()}`);

    const operations = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0
        ? ledgerFor().buyIn(agentId, 100_000, `${randomUUID()}`)
        : ledgerFor().buyIn(agentId, 50_000, `${randomUUID()}`),
    );

    const results = await Promise.allSettled(operations);
    const failures = results.filter(
      (r) => r.status === 'rejected' && !/insufficient funds/.test(String(r.reason)),
    );
    expect(failures).toEqual([]);

    const available = await ledgerFor().balanceOfAgent(agentId, 'available');
    const inPlay = await ledgerFor().balanceOfAgent(agentId, 'in_play');
    expect(available + inPlay).toBe(10_000_000);
  }, 30_000);
});

describe('a full money round trip', () => {
  it('conserves every micro-USDC from deposit to withdrawal', async () => {
    const alice = await newAgent();
    const bob = await newAgent();

    await ledgerFor().creditDeposit(alice, 10_000_000, `sig_${randomUUID()}`);
    await ledgerFor().creditDeposit(bob, 10_000_000, `sig_${randomUUID()}`);

    await ledgerFor().buyIn(alice, 4_000_000, randomUUID());
    await ledgerFor().buyIn(bob, 4_000_000, randomUUID());

    // Alice wins 1 USDC from Bob; the house takes 0.05 rake out of Bob's loss.
    const handId = randomUUID();
    await ledgerFor().settleHand(
      handId,
      [
        { agentId: alice, amountMicros: 1_000_000 },
        { agentId: bob, amountMicros: -1_050_000 },
      ],
      50_000,
    );

    expect(await ledgerFor().balanceOfAgent(alice, 'in_play')).toBe(5_000_000);
    expect(await ledgerFor().balanceOfAgent(bob, 'in_play')).toBe(2_950_000);

    await ledgerFor().cashOut(alice, 5_000_000, randomUUID());
    await ledgerFor().debitWithdrawal(alice, 11_000_000, randomUUID());

    expect(await ledgerFor().balanceOfAgent(alice, 'available')).toBe(0);
    expect(await ledgerFor().balanceOfAgent(alice, 'in_play')).toBe(0);

    await ledgerFor().assertBalanced();
  });

  it('replays a hand settlement without paying twice', async () => {
    // The crash window this closes: the engine writes the hand, the process dies before
    // the ledger acknowledges, and the settlement is retried on restart.
    const alice = await newAgent();
    const bob = await newAgent();
    await ledgerFor().creditDeposit(alice, 5_000_000, `sig_${randomUUID()}`);
    await ledgerFor().creditDeposit(bob, 5_000_000, `sig_${randomUUID()}`);
    await ledgerFor().buyIn(alice, 2_000_000, randomUUID());
    await ledgerFor().buyIn(bob, 2_000_000, randomUUID());

    const handId = randomUUID();
    const deltas = [
      { agentId: alice, amountMicros: 500_000 },
      { agentId: bob, amountMicros: -500_000 },
    ];

    const first = await ledgerFor().settleHand(handId, deltas);
    const replay = await ledgerFor().settleHand(handId, deltas);

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.txId).toBe(first.txId);
    expect(await ledgerFor().balanceOfAgent(alice, 'in_play')).toBe(2_500_000);
  });
});

describe('global invariants', () => {
  it('every entry ever written sums to zero', async () => {
    await expect(ledgerFor().assertBalanced()).resolves.toBeUndefined();
  });

  it('no individual transaction is unbalanced', async () => {
    expect(await ledgerFor().findUnbalancedTransactions()).toEqual([]);
  });
});
