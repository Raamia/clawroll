/**
 * Keeps the house bots solvent, without inventing money.
 *
 * ## The problem this solves
 *
 * With no rake, bot poker is zero-sum: the chips circulate and nothing leaves. That is what
 * makes a permanently-running room possible at all. It does not make it permanent. Two things
 * still end it.
 *
 * *Variance*, because a random walk with an absorbing barrier at zero eventually absorbs —
 * gambler's ruin, one bot ends up with everything. More bankroll delays this quadratically
 * but never prevents it.
 *
 * *Skill*, which is worse. The strategies are not equal — one calls almost anything, another
 * folds bad spots — and a steady edge is a drift, not a walk. Drift beats bankroll. At
 * thousands of hands a day, the weakest bot bleeds out on a schedule.
 *
 * Either way the tables go quiet, and the first anyone knows is opening the site and finding
 * nobody playing.
 *
 * ## Why it moves money rather than granting it
 *
 * The obvious fix is to top a broke bot up from the treasury, and it is the wrong one. Every
 * micro-USDC in this ledger corresponds to devnet USDC that was actually deposited on chain.
 * Crediting a balance that was never deposited would make the ledger claim holdings that do
 * not exist — withdrawals would fail against an empty treasury, and the system's whole claim
 * to be checkable would quietly become false.
 *
 * So this moves chips *between house bots*. The total is untouched, every transaction still
 * sums to zero, and the ledger keeps meaning exactly what it says.
 *
 * ## Why it can never touch a real player
 *
 * Every query here is gated on `is_house_bot`. The operator's own bots opt in explicitly;
 * anyone who deposited their own money is, by default, not one — so their balance cannot be
 * moved by anything but their own play. That boundary is the point of the column, and there
 * is a test for it.
 */

import type { Ledger, Sql } from '@clawroll/db';

export interface RebalanceOptions {
  /** Below this total (available + in_play), a bot is topped up. */
  readonly floorMicros: number;
  /** How much to bring it back to. Must exceed the floor. */
  readonly targetMicros: number;
}

export interface RebalanceResult {
  readonly moved: number;
  readonly transfers: { from: string; to: string; amountMicros: number }[];
}

interface Holding {
  readonly agent_id: string;
  readonly total: string;
}

export class Rebalancer {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: Ledger,
    private readonly options: RebalanceOptions,
  ) {
    if (options.targetMicros <= options.floorMicros) {
      throw new Error('targetMicros must exceed floorMicros, or every pass tops up forever');
    }
  }

  /** Total holdings per house bot, richest first. Never includes anyone else. */
  private async holdings(): Promise<Holding[]> {
    // Driven from `agents`, not from `accounts`.
    //
    // Accounts are created lazily on first use, so a bot that has never held anything has no
    // account rows at all — and starting the join there made it invisible to exactly the
    // query meant to find broke bots. The one case this must never miss was the one it did.
    return this.sql<Holding[]>`
      SELECT ag.id AS agent_id, coalesce(sum(e.amount_micros), 0)::text AS total
      FROM agents ag
      LEFT JOIN accounts a ON a.agent_id = ag.id AND a.type IN ('available', 'in_play')
      LEFT JOIN ledger_entries e ON e.account_id = a.id
      WHERE ag.is_house_bot
      GROUP BY ag.id
      ORDER BY coalesce(sum(e.amount_micros), 0) DESC`;
  }

  /**
   * One pass: bring every broke house bot back up to target, funded by the richest.
   *
   * Takes from `available` only. Chips sitting `in_play` are on a table in the middle of a
   * hand, and moving those would be taking money out of a pot that is still being played for.
   */
  async runOnce(): Promise<RebalanceResult> {
    const holdings = await this.holdings();
    if (holdings.length < 2) return { moved: 0, transfers: [] };

    const totals = new Map(holdings.map((h) => [h.agent_id, Number(h.total)]));
    const transfers: RebalanceResult['transfers'] = [];

    const needy = holdings
      .filter((h) => Number(h.total) < this.options.floorMicros)
      .map((h) => h.agent_id);

    for (const poor of needy) {
      const shortfall = this.options.targetMicros - (totals.get(poor) ?? 0);
      if (shortfall <= 0) continue;

      // Recomputed each time: after one transfer the richest may no longer be.
      const richest = [...totals.entries()]
        .filter(([id]) => id !== poor)
        .sort((a, b) => b[1] - a[1])[0];
      if (!richest) continue;

      const [donor, donorTotal] = richest;
      // Never leave the donor below the floor itself — that would just move the problem, and
      // on the next pass it would move back.
      const spare = donorTotal - this.options.floorMicros;
      const amount = Math.min(shortfall, spare);
      if (amount <= 0) continue;

      // Only what is actually spendable. `in_play` is committed to a live hand.
      const donorAvailable = await this.ledger.balanceOfAgent(donor, 'available');
      const moving = Math.min(amount, donorAvailable);
      if (moving <= 0) continue;

      // The ref carries both parties and the amount, so a retried pass is idempotent while a
      // genuinely new transfer is not mistaken for one.
      await this.ledger.postTransaction({
        kind: 'rebalance',
        externalRef: `rebalance:${donor}:${poor}:${Date.now()}`,
        entries: [
          { accountId: await this.ledger.ensureAccount(donor, 'available'), amountMicros: -moving },
          { accountId: await this.ledger.ensureAccount(poor, 'available'), amountMicros: moving },
        ],
      });

      totals.set(donor, donorTotal - moving);
      totals.set(poor, (totals.get(poor) ?? 0) + moving);
      transfers.push({ from: donor, to: poor, amountMicros: moving });
    }

    return { moved: transfers.length, transfers };
  }
}
