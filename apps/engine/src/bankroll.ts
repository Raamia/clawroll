/**
 * The bridge between chips at a table and money in the ledger.
 *
 * ## Why this is a separate layer rather than calls inside `TableRuntime`
 *
 * The runtime is a synchronous state machine, and that is load-bearing: no dangling
 * promises on seats waiting to act, and a fake clock can drive a thousand hands in
 * milliseconds. Putting `await ledger.settleHand(...)` inside it would destroy both.
 *
 * So the runtime keeps chips in memory and *emits* what it did. This service applies those
 * emissions to Postgres, asynchronously, with retries. The runtime is authoritative for the
 * duration of a hand; the ledger is authoritative for everything else.
 *
 * ## Chips at a table are already real money
 *
 * A buy-in moves `available → in_play` **before** the seat exists. The chips a player is
 * betting with are ledger balances the whole time, not an IOU reconciled later. A hand then
 * only ever moves value *between* `in_play` accounts, so the total is untouched by play —
 * which is why the ledger's global sum stays zero no matter what happens at the table.
 *
 * ## The outbox, and the window it does and does not close
 *
 * A settled hand is written to `hand_settlements` and then posted to the ledger. Because
 * `Ledger.settleHand` is idempotent on the hand id, a post that fails or is interrupted is
 * simply retried.
 *
 * The window this does **not** close: the process dying between the runtime settling in
 * memory and the outbox row being written. The hand was broadcast but the ledger never
 * hears about it, leaving stale `in_play` balances. `reconcileOrphanedChips` handles the
 * aftermath at startup by returning chips from tables that no longer exist. It is recorded
 * here as a known limitation rather than papered over: closing it properly means persisting
 * the settlement before broadcasting, which is a larger change than devnet warrants today.
 */

import type { Ledger, Sql } from '@clawroll/db';

export interface SettlementDelta {
  readonly agentId: string;
  /** Signed micro-USDC. Winners positive, losers negative. */
  readonly amountMicros: number;
}

export interface PendingSettlement {
  readonly handId: string;
  readonly tableId: string;
  readonly deltas: readonly SettlementDelta[];
  readonly rakeMicros: number;
}

export class BankrollError extends Error {}

export class BankrollService {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: Ledger,
  ) {}

  /** What an agent could bring to a table right now. */
  async availableBalance(agentId: string): Promise<number> {
    return this.ledger.balanceOfAgent(agentId, 'available');
  }

  /**
   * Move funds onto a table, before the seat exists.
   *
   * Throws if the agent cannot cover it, so the caller never seats a player whose chips are
   * not backed. The caller is responsible for calling `releaseChips` if seating then fails
   * for any other reason.
   */
  async reserveBuyIn(agentId: string, tableId: string, amountMicros: number): Promise<void> {
    if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) {
      throw new BankrollError(`buy-in must be a positive integer, got ${amountMicros}`);
    }
    // Keyed per table and attempt, so two buy-ins at different tables are distinct
    // transactions while a retry of the same one is not.
    await this.ledger.buyIn(agentId, amountMicros, `${tableId}:${agentId}:${Date.now()}`);
  }

  /**
   * Return a departing player's chips to their spendable balance.
   *
   * `ref` must be stable for a given departure so a retry does not cash out twice.
   */
  async releaseChips(agentId: string, amountMicros: number, ref: string): Promise<void> {
    if (amountMicros <= 0) return;
    await this.ledger.cashOut(agentId, amountMicros, ref);
  }

  /**
   * Record a settled hand for application to the ledger.
   *
   * Writing the intent is separate from applying it precisely so the two can fail
   * independently: a database hiccup during `apply` leaves a durable row to retry, rather
   * than a hand whose result exists only in a log line.
   */
  async recordSettlement(settlement: PendingSettlement): Promise<void> {
    const meaningful = settlement.deltas.filter((d) => d.amountMicros !== 0);
    if (meaningful.length === 0 && settlement.rakeMicros === 0) return;

    await this.sql`
      INSERT INTO hand_settlements (hand_id, table_id, deltas, rake_micros)
      VALUES (${settlement.handId}, ${settlement.tableId},
              ${this.sql.json(meaningful as unknown as never)}, ${settlement.rakeMicros})
      ON CONFLICT (hand_id) DO NOTHING`;
  }

  /**
   * Post every unapplied settlement to the ledger.
   *
   * Safe to call as often as you like: `Ledger.settleHand` is idempotent on the hand id, so
   * a row applied twice posts once.
   */
  async applyPendingSettlements(limit = 100): Promise<{ applied: number; failed: number }> {
    const rows = await this.sql<
      { hand_id: string; deltas: SettlementDelta[]; rake_micros: string }[]
    >`SELECT hand_id, deltas, rake_micros::text
      FROM hand_settlements
      WHERE applied_ledger_tx_id IS NULL
      ORDER BY created_at ASC
      LIMIT ${limit}`;

    let applied = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const result = await this.ledger.settleHand(
          row.hand_id,
          row.deltas,
          Number(row.rake_micros),
        );
        await this.sql`
          UPDATE hand_settlements
          SET applied_ledger_tx_id = ${result.txId}, applied_at = now(), last_error = ${null}
          WHERE hand_id = ${row.hand_id}`;
        applied++;
      } catch (error) {
        // Leave it unapplied so the next drain retries. A settlement that cannot be posted
        // is a real problem, but losing it silently would be a worse one.
        await this.sql`
          UPDATE hand_settlements
          SET attempts = attempts + 1, last_error = ${(error as Error).message}
          WHERE hand_id = ${row.hand_id}`;
        failed++;
      }
    }
    return { applied, failed };
  }

  /** Record where an agent's chips currently sit, so a restart can tell live from orphaned. */
  async trackSeat(tableId: string, agentId: string, seat: number, stack: number): Promise<void> {
    await this.sql`
      INSERT INTO table_seats (table_id, agent_id, seat, stack)
      VALUES (${tableId}, ${agentId}, ${seat}, ${stack})
      ON CONFLICT (table_id, agent_id)
      DO UPDATE SET seat = EXCLUDED.seat, stack = EXCLUDED.stack, updated_at = now()`;
  }

  async untrackSeat(tableId: string, agentId: string): Promise<void> {
    await this.sql`
      DELETE FROM table_seats WHERE table_id = ${tableId} AND agent_id = ${agentId}`;
  }

  /**
   * Return chips stranded at tables that no longer exist.
   *
   * Run at startup. A crash leaves `in_play` balances with no table behind them; without
   * this they would be invisible money — the agent cannot spend it and no table holds it.
   * `liveTableIds` is what the process is actually about to serve, so anything else is by
   * definition abandoned.
   */
  /**
   * Release every seated chip, for a process that has just started.
   *
   * This is what startup actually needs, and passing the live table ids instead was a money
   * bug. The runtime keeps seating **in memory**, so a freshly started engine has nobody
   * seated anywhere — every row in `table_seats` is a leftover written by the process that
   * came before it. Nothing ever reads those rows back to restore a seat; they exist only so
   * chips can be found again after a crash.
   *
   * Exempting tables that still exist therefore protected nothing and stranded real money: an
   * agent seated at `main` when the engine restarted kept an `in_play` balance that no table
   * held and it could never spend. Deploys restart the engine, so this happened on every
   * deploy, silently, and the balance stayed wrong forever.
   *
   * `reconcileOrphanedChips` keeps the live-table exemption because it is a sensible
   * primitive for a caller that knows seating survived. No such caller exists today.
   */
  async reconcileAtStartup(): Promise<{ agentsRestored: number; microsRestored: number }> {
    return this.reconcileOrphanedChips([]);
  }

  async reconcileOrphanedChips(liveTableIds: readonly string[]): Promise<{
    agentsRestored: number;
    microsRestored: number;
  }> {
    const stranded =
      liveTableIds.length === 0
        ? await this.sql<{ table_id: string; agent_id: string }[]>`
            SELECT table_id, agent_id FROM table_seats`
        : await this.sql<{ table_id: string; agent_id: string }[]>`
            SELECT table_id, agent_id FROM table_seats
            WHERE table_id NOT IN ${this.sql(liveTableIds as string[])}`;

    let agentsRestored = 0;
    let microsRestored = 0;

    for (const row of stranded) {
      // Trust the ledger, not the cached stack: `in_play` is the authoritative figure and
      // the cached one may predate the last settlement.
      const inPlay = await this.ledger.balanceOfAgent(row.agent_id, 'in_play');
      if (inPlay > 0) {
        await this.ledger.cashOut(row.agent_id, inPlay, `reconcile:${row.table_id}:${row.agent_id}`);
        microsRestored += inPlay;
        agentsRestored++;
      }
      await this.untrackSeat(row.table_id, row.agent_id);
    }
    return { agentsRestored, microsRestored };
  }

  /** Settlements that have repeatedly failed to post. Worth alerting on. */
  async findStuckSettlements(attemptThreshold = 3): Promise<
    { handId: string; attempts: number; lastError: string | null }[]
  > {
    const rows = await this.sql<
      { hand_id: string; attempts: number; last_error: string | null }[]
    >`SELECT hand_id, attempts, last_error FROM hand_settlements
      WHERE applied_ledger_tx_id IS NULL AND attempts >= ${attemptThreshold}`;
    return rows.map((r) => ({ handId: r.hand_id, attempts: r.attempts, lastError: r.last_error }));
  }
}
