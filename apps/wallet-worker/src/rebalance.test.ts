import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Ledger, type Sql, createSql, migrate } from '@clawroll/db';
import { Rebalancer } from './rebalance.js';

/**
 * Keeping the house bots solvent, and never touching anyone else.
 *
 * The safety property is the important one here. This code moves other people's chips by
 * design, so the test that matters is not "does it top up a broke bot" — it is "is it
 * incapable of touching an agent nobody marked as a house bot".
 */
let sql: Sql;
let ledger: Ledger;

const FLOOR = 2_000_000;
const TARGET = 5_000_000;

beforeAll(async () => {
  sql = createSql();
  await migrate(sql);
  ledger = new Ledger(sql);
}, 30_000);

// House bots accumulate across tests in a shared database, and the rebalancer looks at all
// of them — so without this, one test's donor funds another test's assertions.
beforeEach(async () => {
  await sql`UPDATE agents SET is_house_bot = false WHERE is_house_bot`;
});

afterAll(async () => {
  await sql.end();
});

async function agent(depositMicros: number, isHouseBot: boolean): Promise<string> {
  const id = `rb_${randomUUID()}`;
  await sql`
    INSERT INTO agents (id, display_name, key_prefix, key_hash, derivation_index,
                        deposit_address, is_house_bot)
    VALUES (${id}, ${id}, ${randomUUID()}, 'hash',
            ${Math.floor(Math.random() * 2 ** 40)}, ${randomUUID()}, ${isHouseBot})`;
  if (depositMicros > 0) await ledger.creditDeposit(id, depositMicros, `sig_${randomUUID()}`);
  return id;
}

const rebalancer = () => new Rebalancer(sql, ledger, { floorMicros: FLOOR, targetMicros: TARGET });

const held = async (id: string) =>
  (await ledger.balanceOfAgent(id, 'available')) + (await ledger.balanceOfAgent(id, 'in_play'));

describe('it never touches money that is not the house’s', () => {
  it('leaves a broke real player broke', async () => {
    // The whole reason `is_house_bot` exists. Someone who deposited their own money and lost
    // it must stay lost — topping them up would be inventing a refund nobody asked for, out
    // of somebody else's balance.
    const player = await agent(500_000, false);
    const bot = await agent(50_000_000, true);

    await rebalancer().runOnce();

    expect(await held(player)).toBe(500_000);
    expect(await held(bot)).toBe(50_000_000);
  });

  it('never funds a top-up from a real player', async () => {
    // The other direction, and the worse one: a rich stranger must not be quietly used as
    // the source when a house bot goes broke.
    const rich = await agent(80_000_000, false);
    const brokeBot = await agent(100_000, true);
    const otherBot = await agent(40_000_000, true);

    await rebalancer().runOnce();

    expect(await held(rich)).toBe(80_000_000);
    // Topped up, from the other bot rather than the stranger.
    expect(await held(brokeBot)).toBe(TARGET);
    expect(await held(otherBot)).toBe(40_000_000 - (TARGET - 100_000));
  });
});

describe('keeping bots in the game', () => {
  it('tops a broke bot back up to target from the richest', async () => {
    const broke = await agent(0, true);
    const rich = await agent(60_000_000, true);

    const result = await rebalancer().runOnce();

    expect(result.moved).toBe(1);
    expect(await held(broke)).toBe(TARGET);
    expect(await held(rich)).toBe(60_000_000 - TARGET);
  });

  it('conserves the total exactly', async () => {
    // The point of moving rather than granting: the ledger keeps describing devnet USDC that
    // genuinely exists on chain. If this ever created value, withdrawals would be claims
    // against a treasury that cannot pay them.
    const broke = await agent(0, true);
    const rich = await agent(30_000_000, true);
    const before = (await held(broke)) + (await held(rich));

    await rebalancer().runOnce();

    expect((await held(broke)) + (await held(rich))).toBe(before);
    await ledger.assertBalanced();
  });

  it('does not push the donor below the floor', async () => {
    // Otherwise the pass just moves the problem, and the next one moves it back.
    const broke = await agent(0, true);
    const barelyOk = await agent(FLOOR + 500_000, true);

    await rebalancer().runOnce();

    expect(await held(barelyOk)).toBeGreaterThanOrEqual(FLOOR);
  });

  it('leaves a bot above the floor alone', async () => {
    const fine = await agent(FLOOR + 3_000_000, true);
    const rich = await agent(20_000_000, true);
    const before = await held(fine);

    await rebalancer().runOnce();

    expect(await held(fine)).toBe(before);
    expect(await held(rich)).toBe(20_000_000);
  });

  it('does nothing when there is only one house bot', async () => {
    // Nobody to move money from. Must not throw, and must not invent any.
    const lonely = await agent(100_000, true);

    const result = await rebalancer().runOnce();

    expect(result.moved).toBe(0);
    expect(await held(lonely)).toBe(100_000);
  });

  it('refuses a target that does not exceed the floor', () => {
    // Otherwise every pass tops up to a level that is still below the floor, forever.
    expect(() => new Rebalancer(sql, ledger, { floorMicros: 5, targetMicros: 5 })).toThrow();
  });
});
