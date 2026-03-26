import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ledger, type Sql, createSql, migrate } from '@clawroll/db';
import { BankrollError, BankrollService } from './bankroll.js';
import type { ServerMessage } from '@clawroll/protocol';
import { type LedgerEvent, type TableConfig, type TableIO, TableRuntime } from './table.js';

let sql: Sql;
let ledger: Ledger;
let bankroll: BankrollService;

/**
 * Unique per run, and every write here is scoped to it.
 *
 * Vitest runs test files in parallel workers against one database, so an unscoped
 * `DELETE FROM hand_settlements` in this file's setup would delete rows another file was
 * mid-way through asserting on.
 */
const TABLE_ID = `bankroll_${randomUUID().slice(0, 8)}`;

async function fundedAgent(micros: number): Promise<string> {
  const agentId = `agent_${randomUUID()}`;
  await sql`
    INSERT INTO agents (id, display_name, key_prefix, key_hash, derivation_index, deposit_address)
    VALUES (${agentId}, 'Bot', ${randomUUID()}, 'hash',
            ${Math.floor(Math.random() * 2 ** 40)}, ${randomUUID()})`;
  await ledger.creditDeposit(agentId, micros, `sig_${randomUUID()}`);
  return agentId;
}

/** Everything an agent owns, wherever it currently sits. */
async function totalHoldings(agentId: string): Promise<number> {
  return (
    (await ledger.balanceOfAgent(agentId, 'available')) +
    (await ledger.balanceOfAgent(agentId, 'in_play'))
  );
}

beforeAll(async () => {
  sql = createSql();
  await migrate(sql);
  ledger = new Ledger(sql);
  bankroll = new BankrollService(sql, ledger);

  // The outbox is shared and `applyPendingSettlements` drains all of it, so a row left
  // permanently unappliable by an earlier run would make every drain here report a
  // failure. Clearing orphans keeps the suite independent of previous runs.
  await sql`
    DELETE FROM hand_settlements
    WHERE applied_ledger_tx_id IS NULL AND table_id = ${TABLE_ID}`;
}, 30_000);

afterAll(async () => {
  await sql.end();
});

describe('chips at a table are already real money', () => {
  it('moves funds from available to in_play before the seat exists', async () => {
    // Not an IOU reconciled later: the chips a player bets with are ledger balances the
    // whole time.
    const agentId = await fundedAgent(10_000_000);
    await bankroll.reserveBuyIn(agentId, TABLE_ID, 4_000_000);

    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(6_000_000);
    expect(await ledger.balanceOfAgent(agentId, 'in_play')).toBe(4_000_000);
    expect(await totalHoldings(agentId)).toBe(10_000_000);
  });

  it('refuses a buy-in the agent cannot cover', async () => {
    const agentId = await fundedAgent(1_000_000);
    await expect(bankroll.reserveBuyIn(agentId, TABLE_ID, 5_000_000)).rejects.toThrow(
      /insufficient funds/,
    );
    expect(await ledger.balanceOfAgent(agentId, 'in_play')).toBe(0);
  });

  it.each([0, -5, 1.5])('refuses a buy-in of %s', async (amount) => {
    const agentId = await fundedAgent(1_000_000);
    await expect(bankroll.reserveBuyIn(agentId, TABLE_ID, amount)).rejects.toThrow(BankrollError);
  });

  it('returns chips when a player leaves', async () => {
    const agentId = await fundedAgent(10_000_000);
    await bankroll.reserveBuyIn(agentId, TABLE_ID, 4_000_000);
    await bankroll.releaseChips(agentId, 4_000_000, `leave:${randomUUID()}`);

    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(10_000_000);
    expect(await ledger.balanceOfAgent(agentId, 'in_play')).toBe(0);
  });

  it('releases nothing for a busted player', async () => {
    const agentId = await fundedAgent(1_000_000);
    await expect(bankroll.releaseChips(agentId, 0, randomUUID())).resolves.toBeUndefined();
  });
});

describe('the settlement outbox', () => {
  it('records and then applies a settlement', async () => {
    const alice = await fundedAgent(10_000_000);
    const bob = await fundedAgent(10_000_000);
    await bankroll.reserveBuyIn(alice, TABLE_ID, 5_000_000);
    await bankroll.reserveBuyIn(bob, TABLE_ID, 5_000_000);

    const handId = `hand_${randomUUID()}`;
    await bankroll.recordSettlement({
      handId,
      tableId: TABLE_ID,
      deltas: [
        { agentId: alice, amountMicros: 1_500_000 },
        { agentId: bob, amountMicros: -1_500_000 },
      ],
      rakeMicros: 0,
    });

    const before = await ledger.balanceOfAgent(alice, 'in_play');
    expect(before).toBe(5_000_000);

    await bankroll.applyPendingSettlements();
    const row = await sql<{ applied_ledger_tx_id: string | null }[]>`
      SELECT applied_ledger_tx_id FROM hand_settlements WHERE hand_id = ${handId}`;
    expect(row[0]?.applied_ledger_tx_id).toBeTruthy();
    expect(await ledger.balanceOfAgent(alice, 'in_play')).toBe(6_500_000);
    expect(await ledger.balanceOfAgent(bob, 'in_play')).toBe(3_500_000);
  });

  it('applies a settlement exactly once however often it is drained', async () => {
    // The drain runs on a loop, so this is the normal case rather than an edge one.
    const alice = await fundedAgent(10_000_000);
    const bob = await fundedAgent(10_000_000);
    await bankroll.reserveBuyIn(alice, TABLE_ID, 5_000_000);
    await bankroll.reserveBuyIn(bob, TABLE_ID, 5_000_000);

    const handId = `hand_${randomUUID()}`;
    await bankroll.recordSettlement({
      handId,
      tableId: TABLE_ID,
      deltas: [
        { agentId: alice, amountMicros: 900_000 },
        { agentId: bob, amountMicros: -900_000 },
      ],
      rakeMicros: 0,
    });

    await bankroll.applyPendingSettlements();
    await bankroll.applyPendingSettlements();
    await bankroll.applyPendingSettlements();

    expect(await ledger.balanceOfAgent(alice, 'in_play')).toBe(5_900_000);
  });

  it('ignores a duplicate record of the same hand', async () => {
    const alice = await fundedAgent(10_000_000);
    const bob = await fundedAgent(10_000_000);
    await bankroll.reserveBuyIn(alice, TABLE_ID, 5_000_000);
    await bankroll.reserveBuyIn(bob, TABLE_ID, 5_000_000);

    const handId = `hand_${randomUUID()}`;
    const settlement = {
      handId,
      tableId: TABLE_ID,
      deltas: [
        { agentId: alice, amountMicros: 250_000 },
        { agentId: bob, amountMicros: -250_000 },
      ],
      rakeMicros: 0,
    };

    await bankroll.recordSettlement(settlement);
    await bankroll.recordSettlement(settlement);
    await bankroll.applyPendingSettlements();

    expect(await ledger.balanceOfAgent(alice, 'in_play')).toBe(5_250_000);
  });

  it('keeps a settlement retryable when applying it fails', async () => {
    // A settlement that cannot post is a real problem; losing it silently would be worse.
    const alice = await fundedAgent(10_000_000);
    const handId = `hand_${randomUUID()}`;
    await bankroll.recordSettlement({
      handId,
      tableId: TABLE_ID,
      // Unbalanced on purpose, so the ledger rejects it.
      deltas: [{ agentId: alice, amountMicros: 1_000_000 }],
      rakeMicros: 0,
    });

    const result = await bankroll.applyPendingSettlements();
    expect(result.failed).toBeGreaterThan(0);

    const stuck = (await bankroll.findStuckSettlements(1)).map((s) => s.handId);
    expect(stuck).toContain(handId);

    const rows = await sql<{ applied_ledger_tx_id: string | null }[]>`
      SELECT applied_ledger_tx_id FROM hand_settlements WHERE hand_id = ${handId}`;
    expect(rows[0]?.applied_ledger_tx_id).toBeNull();

    // Clean up: the drain is global, so a row left permanently unappliable would make
    // every later `applyPendingSettlements()` in this file report a failure.
    await sql`DELETE FROM hand_settlements WHERE hand_id = ${handId}`;
  });

  it('skips a settlement where nothing actually moved', async () => {
    const handId = `hand_${randomUUID()}`;
    await bankroll.recordSettlement({ handId, tableId: TABLE_ID, deltas: [], rakeMicros: 0 });
    const rows = await sql`SELECT 1 FROM hand_settlements WHERE hand_id = ${handId}`;
    expect(rows).toHaveLength(0);
  });
});

describe('reconciling chips stranded by a crash', () => {
  it('returns in_play balances belonging to tables that no longer exist', async () => {
    // Without this they are invisible money: the agent cannot spend it and no table
    // holds it.
    const agentId = await fundedAgent(10_000_000);
    await bankroll.reserveBuyIn(agentId, 'dead-table', 4_000_000);
    await bankroll.trackSeat('dead-table', agentId, 0, 4_000_000);

    const result = await bankroll.reconcileOrphanedChips(['live-table']);

    expect(result.agentsRestored).toBeGreaterThan(0);
    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(10_000_000);
    expect(await ledger.balanceOfAgent(agentId, 'in_play')).toBe(0);
  });

  it('leaves chips at a table that is still being served', async () => {
    const agentId = await fundedAgent(10_000_000);
    await bankroll.reserveBuyIn(agentId, 'live-table', 3_000_000);
    await bankroll.trackSeat('live-table', agentId, 0, 3_000_000);

    await bankroll.reconcileOrphanedChips(['live-table']);

    expect(await ledger.balanceOfAgent(agentId, 'in_play')).toBe(3_000_000);
  });

  it('trusts the ledger rather than the cached stack', async () => {
    // The cached figure can predate the last settlement; `in_play` cannot.
    const agentId = await fundedAgent(10_000_000);
    await bankroll.reserveBuyIn(agentId, 'dead-table', 5_000_000);
    await bankroll.trackSeat('dead-table', agentId, 0, 999_999_999);

    await bankroll.reconcileOrphanedChips([]);
    expect(await totalHoldings(agentId)).toBe(10_000_000);
  });
});

describe('a real hand settles through to Postgres', () => {
  const CONFIG: TableConfig = {
    tableId: `${TABLE_ID}_play`,
    smallBlind: 50_000,
    bigBlind: 100_000,
    maxSeats: 6,
    minBuyIn: 1_000_000,
    maxBuyIn: 20_000_000,
    actionTimeoutMs: 5_000,
    seedTimeoutMs: 1_000,
  };

  it('applies the runtime\u2019s own deltas and leaves the ledger balanced', async () => {
    // The end-to-end wiring proof: chips move at a table and the same movement lands in
    // Postgres, without anyone computing the result twice.
    const requests: { agentId: string; message: ServerMessage }[] = [];
    const io: TableIO = {
      send: (agentId, message) => {
        if (message.type === 'action_request') requests.push({ agentId, message });
      },
      broadcast: () => {},
    };

    let ids = 0;
    const table = new TableRuntime(CONFIG, {
      io,
      now: () => Date.now(),
      nextId: (prefix) => `${prefix}-${randomUUID().slice(0, 8)}-${++ids}`,
    });

    const agents = await Promise.all([fundedAgent(20_000_000), fundedAgent(20_000_000)]);
    for (const agentId of agents) {
      await bankroll.reserveBuyIn(agentId, CONFIG.tableId, 10_000_000);
      expect(table.seat(agentId, agentId, 10_000_000).ok).toBe(true);
    }

    const holdingsBefore = (await Promise.all(agents.map(totalHoldings))).reduce((a, b) => a + b, 0);

    // Play several hands rather than one.
    //
    // A chopped pot where every player committed the same amount leaves every net at zero,
    // so the runtime correctly emits *no* settlement — a ledger transaction that moves
    // nothing is pointless, and `recordSettlement` skips it anyway. Asserting that one hand
    // always produces one settlement was therefore wrong, and failed roughly one run in
    // four when two check-downs happened to tie.
    //
    // Playing until a hand actually moves chips tests the wiring without depending on the
    // outcome of any particular deal.
    const settlements: Extract<LedgerEvent, { type: 'hand_settled' }>[] = [];
    let handsPlayed = 0;

    while (settlements.length === 0 && handsPlayed < 12) {
      expect(table.startHand()).toBe(true);
      const handId = table.currentHandId!;
      for (const agentId of agents) table.submitSeed(agentId, handId, 'a'.repeat(64));
      handsPlayed++;

      let guard = 0;
      while (table.currentPhase === 'betting') {
        const pending = requests.pop();
        if (!pending || pending.message.type !== 'action_request') break;
        const { legal } = pending.message;
        table.submitAction(pending.agentId, {
          handId: pending.message.handId,
          requestId: pending.message.requestId,
          action: legal.canCheck ? 'check' : 'call',
        });
        if (++guard > 200) throw new Error('hand did not finish');
      }
      expect(table.currentPhase).toBe('idle');

      for (const event of table.drainLedgerEvents()) {
        if (event.type === 'hand_settled') settlements.push(event);
      }
    }

    // Twelve check-downs all chopping is not credible; if this fires, something is wrong.
    expect(settlements.length).toBeGreaterThan(0);

    for (const event of settlements) {
      // A hand only redistributes chips between seats, so the deltas must net to zero.
      // This is what keeps the ledger's global total untouched by play.
      expect(event.deltas.reduce((sum, d) => sum + d.amountMicros, 0)).toBe(0);
      expect(event.deltas.length).toBeGreaterThan(0);
      await bankroll.recordSettlement(event);
    }

    await bankroll.applyPendingSettlements();
    const handId = settlements[0]!.handId;

    // Asserted per-hand rather than as a global failure count: the outbox is shared, so a
    // count would couple this test to whatever else happens to be pending.
    const settlementRow = await sql<{ applied_ledger_tx_id: string | null }[]>`
      SELECT applied_ledger_tx_id FROM hand_settlements WHERE hand_id = ${handId}`;
    expect(settlementRow[0]?.applied_ledger_tx_id).toBeTruthy();

    const holdingsAfter = (await Promise.all(agents.map(totalHoldings))).reduce((a, b) => a + b, 0);
    expect(holdingsAfter).toBe(holdingsBefore);

    // And the in_play balances now match the stacks the table is actually holding.
    for (const agentId of agents) {
      const seat = table.seatOf(agentId);
      if (seat === null) continue;
      expect(await ledger.balanceOfAgent(agentId, 'in_play')).toBe(table.stackOf(agentId));
    }

    await ledger.assertBalanced();
    expect(await ledger.findNegativeAgentAccounts()).toEqual([]);
  });
});
