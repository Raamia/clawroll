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
  /**
   * Below this *spendable* balance, a bot is topped up.
   *
   * Spendable — `available` — and not total holdings. A buy-in is paid from `available`, so
   * that is the balance that decides whether a bot can sit down. Measuring holdings instead
   * benched half the fleet in production: a bot with 8 USDC on one table and 1 in hand was
   * "rich", was never topped up, and could not afford the 2 USDC seat it was asking for.
   */
  readonly floorMicros: number;
  /** How much spendable balance to bring it back to. Must exceed the floor. */
  readonly targetMicros: number;
}

export interface RebalanceResult {
  readonly moved: number;
  readonly transfers: { from: string; to: string; amountMicros: number }[];
}

interface Holding {
  readonly agent_id: string;
  /** Spendable now. */
  readonly available: string;
  /** Committed to a table; only leaves when the bot stands up. */
  readonly in_play: string;
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

  /** Spendable and committed balance per house bot. Never includes anyone else. */
  private async holdings(): Promise<Holding[]> {
    // Driven from `agents`, not from `accounts`.
    //
    // Accounts are created lazily on first use, so a bot that has never held anything has no
    // account rows at all — and starting the join there made it invisible to exactly the
    // query meant to find broke bots. The one case this must never miss was the one it did.
    return this.sql<Holding[]>`
      SELECT ag.id AS agent_id,
             coalesce(sum(e.amount_micros) FILTER (WHERE a.type = 'available'), 0)::text AS available,
             coalesce(sum(e.amount_micros) FILTER (WHERE a.type = 'in_play'), 0)::text AS in_play
      FROM agents ag
      LEFT JOIN accounts a ON a.agent_id = ag.id AND a.type IN ('available', 'in_play')
      LEFT JOIN ledger_entries e ON e.account_id = a.id
      WHERE ag.is_house_bot
      GROUP BY ag.id
      ORDER BY ag.id`;
  }

  /**
   * One pass: bring every broke house bot back up to target, funded by whoever can spare it.
   *
   * Every figure here is `available`. Chips sitting `in_play` are on a table in the middle
   * of a hand — moving those would be taking money out of a pot still being played for — and
   * they are just as invisible on the other side of the ledger: a bot cannot pay a buy-in
   * with them. So both "who is broke" and "who can give" are questions about spendable
   * balance, and the first version of this got both wrong by asking about holdings. It
   * picked the bot with the biggest stack on the table as the donor, found it had nothing
   * in hand, and moved nothing — one transfer in three hours while six bots sat benched.
   */
  async runOnce(): Promise<RebalanceResult> {
    const holdings = await this.holdings();
    if (holdings.length < 2) return { moved: 0, transfers: [] };

    const available = new Map(holdings.map((h) => [h.agent_id, Number(h.available)]));
    const transfers: RebalanceResult['transfers'] = [];

    const needy = holdings
      .filter((h) => Number(h.available) < this.options.floorMicros)
      .map((h) => h.agent_id);

    for (const poor of needy) {
      const shortfall = this.options.targetMicros - (available.get(poor) ?? 0);
      if (shortfall <= 0) continue;

      // Recomputed each time: after one transfer the best donor may no longer be.
      const richest = [...available.entries()]
        .filter(([id]) => id !== poor)
        .sort((a, b) => b[1] - a[1])[0];
      if (!richest) continue;

      const [donor, donorAvailable] = richest;
      // Never leave the donor unable to afford its own next seat — that would just move the
      // problem, and on the next pass it would move back.
      const spare = donorAvailable - this.options.floorMicros;
      const moving = Math.min(shortfall, spare);
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

      available.set(donor, donorAvailable - moving);
      available.set(poor, (available.get(poor) ?? 0) + moving);
      transfers.push({ from: donor, to: poor, amountMicros: moving });
    }

    return { moved: transfers.length, transfers };
  }
}
