import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { Ledger, type Sql, createSql, migrate } from '@clawroll/db';
import type { SignatureRecord, SolanaGateway, TokenTransfer } from '@clawroll/solana';
import { DepositScanner } from './scanner.js';

/**
 * A scriptable Solana.
 *
 * The scanner's job is reasoning about money under partial failure — replays, restarts,
 * cursor gaps, transactions that landed but failed. None of those can be requested from a
 * real RPC on demand, which is exactly why the gateway is an interface.
 */
class FakeGateway implements SolanaGateway {
  private readonly byAddress = new Map<string, SignatureRecord[]>();
  private readonly transfers = new Map<string, TokenTransfer[]>();
  signatureCalls = 0;

  /** Land a successful deposit into `tokenAccount`. */
  deposit(tokenAccount: string, amountMicros: number, slot: number): string {
    const signature = `sig${slot}_${randomUUID().slice(0, 8)}`;
    this.push(tokenAccount, { signature, slot, err: null });
    this.transfers.set(signature, [{ signature, slot, destination: tokenAccount, amountMicros }]);
    return signature;
  }

  /** A transaction that landed but failed — it moved no money. */
  failedTransaction(tokenAccount: string, slot: number): string {
    const signature = `fail${slot}_${randomUUID().slice(0, 8)}`;
    this.push(tokenAccount, { signature, slot, err: { InstructionError: [0, 'Custom'] } });
    return signature;
  }

  /** Touches the account but deposits nothing — an ATA creation, or a sweep out. */
  noopTransaction(tokenAccount: string, slot: number): string {
    const signature = `noop${slot}_${randomUUID().slice(0, 8)}`;
    this.push(tokenAccount, { signature, slot, err: null });
    this.transfers.set(signature, []);
    return signature;
  }

  /** Two transfers to the same account inside one transaction. */
  splitDeposit(tokenAccount: string, parts: readonly number[], slot: number): string {
    const signature = `split${slot}_${randomUUID().slice(0, 8)}`;
    this.push(tokenAccount, { signature, slot, err: null });
    this.transfers.set(
      signature,
      parts.map((amountMicros) => ({ signature, slot, destination: tokenAccount, amountMicros })),
    );
    return signature;
  }

  private push(tokenAccount: string, record: SignatureRecord): void {
    const existing = this.byAddress.get(tokenAccount) ?? [];
    // Newest first, matching what Solana returns.
    this.byAddress.set(tokenAccount, [record, ...existing]);
  }

  async getSignaturesForAddress(address: PublicKey, until?: string): Promise<SignatureRecord[]> {
    this.signatureCalls++;
    const all = this.byAddress.get(address.toBase58()) ?? [];
    if (until === undefined) return [...all];
    const stop = all.findIndex((r) => r.signature === until);
    return stop === -1 ? [...all] : all.slice(0, stop);
  }

  async getTokenTransfers(signature: string): Promise<TokenTransfer[]> {
    return this.transfers.get(signature) ?? [];
  }
}

let sql: Sql;
let ledger: Ledger;

async function newAgentWithAddress(): Promise<{ agentId: string; tokenAccount: string }> {
  const agentId = `agent_${randomUUID()}`;
  const tokenAccount = Keypair.generate().publicKey.toBase58();
  await sql`
    INSERT INTO agents (id, display_name, key_prefix, key_hash, derivation_index, deposit_address)
    VALUES (${agentId}, 'Bot', ${randomUUID()}, 'hash',
            ${Math.floor(Math.random() * 2 ** 40)}, ${tokenAccount})`;
  return { agentId, tokenAccount };
}

/** Scanner scoped to a single agent, so cases never interfere. */
function scannerFor(gateway: SolanaGateway, agentId: string): DepositScanner {
  const scanner = new DepositScanner(sql, ledger, gateway);
  scanner.targets = async () => {
    const rows = await sql<{ id: string; deposit_address: string }[]>`
      SELECT id, deposit_address FROM agents WHERE id = ${agentId}`;
    return rows.map((r) => ({ agentId: r.id, tokenAccount: r.deposit_address }));
  };
  return scanner;
}

beforeAll(async () => {
  sql = createSql();
  await migrate(sql);
  ledger = new Ledger(sql);
}, 30_000);

afterAll(async () => {
  await sql.end();
});

describe('crediting deposits', () => {
  it('credits a new deposit once', async () => {
    const { agentId, tokenAccount } = await newAgentWithAddress();
    const gateway = new FakeGateway();
    gateway.deposit(tokenAccount, 5_000_000, 100);

    const summary = await scannerFor(gateway, agentId).scanOnce();
    expect(summary.depositsCredited).toBe(1);
    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(5_000_000);
  });

  it('sums several transfers arriving in one transaction', async () => {
    const { agentId, tokenAccount } = await newAgentWithAddress();
    const gateway = new FakeGateway();
    gateway.splitDeposit(tokenAccount, [1_000_000, 2_500_000], 100);

    await scannerFor(gateway, agentId).scanOnce();
    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(3_500_000);
  });

  it('credits several separate deposits', async () => {
    const { agentId, tokenAccount } = await newAgentWithAddress();
    const gateway = new FakeGateway();
    gateway.deposit(tokenAccount, 1_000_000, 100);
    gateway.deposit(tokenAccount, 2_000_000, 101);
    gateway.deposit(tokenAccount, 3_000_000, 102);

    const summary = await scannerFor(gateway, agentId).scanOnce();
    expect(summary.depositsCredited).toBe(3);
    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(6_000_000);
  });

  it('ignores a transaction that landed but failed', async () => {
    const { agentId, tokenAccount } = await newAgentWithAddress();
    const gateway = new FakeGateway();
    gateway.failedTransaction(tokenAccount, 100);

    const summary = await scannerFor(gateway, agentId).scanOnce();
    expect(summary.depositsCredited).toBe(0);
    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(0);
  });

  it('ignores a transaction that touches the account without depositing', async () => {
    // An ATA creation, or a sweep out. Both touch the address and move nothing in.
    const { agentId, tokenAccount } = await newAgentWithAddress();
    const gateway = new FakeGateway();
    gateway.noopTransaction(tokenAccount, 100);

    await scannerFor(gateway, agentId).scanOnce();
    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(0);
  });

  it('ignores a deposit to somebody else’s address', async () => {
    const mine = await newAgentWithAddress();
    const gateway = new FakeGateway();
    const foreign = Keypair.generate().publicKey.toBase58();
    // Same signature list, but the transfer lands elsewhere.
    const signature = gateway.deposit(foreign, 9_000_000, 100);
    expect(signature).toBeTruthy();

    await scannerFor(gateway, mine.agentId).scanOnce();
    expect(await ledger.balanceOfAgent(mine.agentId, 'available')).toBe(0);
  });
});

describe('replays never double-credit', () => {
  it('credits once across repeated scans', async () => {
    // Normal operation: overlapping poll windows and restarts re-present signatures.
    const { agentId, tokenAccount } = await newAgentWithAddress();
    const gateway = new FakeGateway();
    gateway.deposit(tokenAccount, 4_000_000, 100);
    const scanner = scannerFor(gateway, agentId);

    const first = await scanner.scanOnce();
    const second = await scanner.scanOnce();
    const third = await scanner.scanOnce();

    expect(first.depositsCredited).toBe(1);
    expect(second.depositsCredited).toBe(0);
    expect(third.depositsCredited).toBe(0);
    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(4_000_000);
  });

  it('survives losing the cursor entirely', async () => {
    // A crash can lose the sighting rows. The scan then re-reads history from the start,
    // and the ledger absorbs every duplicate: losing the cursor costs time, never money.
    const { agentId, tokenAccount } = await newAgentWithAddress();
    const gateway = new FakeGateway();
    gateway.deposit(tokenAccount, 1_000_000, 100);
    gateway.deposit(tokenAccount, 2_000_000, 101);

    const scanner = scannerFor(gateway, agentId);
    await scanner.scanOnce();
    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(3_000_000);

    await sql`DELETE FROM deposit_sightings WHERE agent_id = ${agentId}`;

    const rescan = await scanner.scanOnce();
    expect(rescan.replaysIgnored).toBe(2);
    expect(rescan.depositsCredited).toBe(0);
    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(3_000_000);
  });

  it('recovers when a crash lands between crediting and recording', async () => {
    // This is why crediting comes first. Recording first would mean a crash in between
    // permanently skips a real deposit: the next poll would see the signature as handled
    // and never credit it. In this order the deposit is already paid, and the re-scan
    // simply restores the record.
    const { agentId, tokenAccount } = await newAgentWithAddress();
    const gateway = new FakeGateway();
    const signature = gateway.deposit(tokenAccount, 7_000_000, 100);
    const scanner = scannerFor(gateway, agentId);

    await scanner.scanOnce();
    // Simulate the crash: money credited, sighting lost.
    await sql`DELETE FROM deposit_sightings WHERE signature = ${signature}`;

    const recovery = await scanner.scanOnce();
    expect(recovery.replaysIgnored).toBe(1);
    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(7_000_000);

    const restored = await sql<{ credited_tx_id: string | null }[]>`
      SELECT credited_tx_id FROM deposit_sightings WHERE signature = ${signature}`;
    expect(restored[0]?.credited_tx_id).toBeTruthy();
  });

  it('credits once when two scanners run concurrently', async () => {
    // Two worker instances, or one restarting mid-poll.
    const { agentId, tokenAccount } = await newAgentWithAddress();
    const gateway = new FakeGateway();
    gateway.deposit(tokenAccount, 6_000_000, 100);

    const results = await Promise.allSettled([
      scannerFor(gateway, agentId).scanOnce(),
      scannerFor(gateway, agentId).scanOnce(),
      scannerFor(gateway, agentId).scanOnce(),
    ]);

    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(6_000_000);
  });
});

describe('the cursor', () => {
  it('only fetches what is new on a later scan', async () => {
    const { agentId, tokenAccount } = await newAgentWithAddress();
    const gateway = new FakeGateway();
    gateway.deposit(tokenAccount, 1_000_000, 100);
    const scanner = scannerFor(gateway, agentId);

    await scanner.scanOnce();
    const afterFirst = await scanner.scanOnce();
    expect(afterFirst.signaturesSeen).toBe(0);

    gateway.deposit(tokenAccount, 2_000_000, 101);
    const afterNew = await scanner.scanOnce();
    expect(afterNew.signaturesSeen).toBe(1);
    expect(afterNew.depositsCredited).toBe(1);
    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(3_000_000);
  });

  it('advances past a failed transaction so it is not re-fetched forever', async () => {
    const { agentId, tokenAccount } = await newAgentWithAddress();
    const gateway = new FakeGateway();
    gateway.failedTransaction(tokenAccount, 100);
    const scanner = scannerFor(gateway, agentId);

    await scanner.scanOnce();
    expect((await scanner.scanOnce()).signaturesSeen).toBe(0);
  });
});

describe('dust', () => {
  it('does not credit below the configured minimum', async () => {
    const { agentId, tokenAccount } = await newAgentWithAddress();
    const gateway = new FakeGateway();
    gateway.deposit(tokenAccount, 500, 100);

    const scanner = new DepositScanner(sql, ledger, gateway, { minimumMicros: 1_000 });
    scanner.targets = async () => [{ agentId, tokenAccount }];

    await scanner.scanOnce();
    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(0);
  });
});

describe('observability', () => {
  it('reports nothing uncredited when every deposit landed', async () => {
    const { agentId, tokenAccount } = await newAgentWithAddress();
    const gateway = new FakeGateway();
    gateway.deposit(tokenAccount, 1_000_000, 100);
    const scanner = scannerFor(gateway, agentId);
    await scanner.scanOnce();

    const uncredited = (await scanner.findUncreditedDeposits()).filter((d) => d.agentId === agentId);
    expect(uncredited).toEqual([]);
  });

  it('surfaces money that arrived on chain but was never credited', async () => {
    // The one failure a user notices immediately, so it is worth alerting on rather than
    // learning about from a support message.
    const { agentId, tokenAccount } = await newAgentWithAddress();
    await sql`
      INSERT INTO deposit_sightings (signature, agent_id, amount_micros, slot, credited_tx_id)
      VALUES (${`orphan_${randomUUID()}`}, ${agentId}, ${5_000_000}, ${1}, ${null})`;

    const scanner = scannerFor(new FakeGateway(), agentId);
    const uncredited = (await scanner.findUncreditedDeposits()).filter((d) => d.agentId === agentId);
    expect(uncredited).toHaveLength(1);
    expect(uncredited[0]?.amountMicros).toBe(5_000_000);
    expect(tokenAccount).toBeTruthy();
  });
});
