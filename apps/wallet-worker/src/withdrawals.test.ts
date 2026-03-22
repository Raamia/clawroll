import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Ledger, type Sql, createSql, migrate } from '@clawroll/db';
import {
  type SignatureOutcome,
  type SignedTransfer,
  type WithdrawalGateway,
  WithdrawalError,
  WithdrawalWorker,
} from './withdrawals.js';

/**
 * A scriptable chain.
 *
 * Every scenario that matters for withdrawals is a *partial failure*: a send that errors but
 * lands anyway, a crash between signing and broadcasting, a blockhash expiring mid-flight.
 * None can be requested from a real RPC, which is the entire reason the gateway is an
 * interface.
 */
class FakeChain implements WithdrawalGateway {
  blockHeight = 1_000;
  validityWindow = 150;
  /** Signature → outcome. Absent means the chain has never heard of it. */
  readonly outcomes = new Map<string, SignatureOutcome>();
  readonly sent: string[] = [];

  sendBehaviour: 'ok' | 'throw' | 'throw-but-lands' = 'ok';
  private lastSigned: SignedTransfer | null = null;

  async buildAndSign(_destination: string, _amountMicros: number): Promise<SignedTransfer> {
    const signature = `wsig_${randomUUID().slice(0, 12)}`;
    const signed: SignedTransfer = {
      signature,
      blockhash: `bh_${randomUUID().slice(0, 8)}`,
      lastValidBlockHeight: this.blockHeight + this.validityWindow,
      rawTransaction: new TextEncoder().encode(signature),
    };
    this.lastSigned = signed;
    return signed;
  }

  async send(rawTransaction: Uint8Array): Promise<void> {
    const signature = new TextDecoder().decode(rawTransaction);
    if (this.sendBehaviour === 'throw') {
      throw new Error('node is behind');
    }
    if (this.sendBehaviour === 'throw-but-lands') {
      // The nastiest real case: the RPC errors and the transaction lands anyway.
      this.sent.push(signature);
      this.outcomes.set(signature, { landed: true, err: null });
      throw new Error('timeout waiting for confirmation');
    }
    this.sent.push(signature);
  }

  async getSignatureOutcome(signature: string): Promise<SignatureOutcome | null> {
    return this.outcomes.get(signature) ?? null;
  }

  async getBlockHeight(): Promise<number> {
    return this.blockHeight;
  }

  /** Land the most recently signed transaction, optionally with an on-chain error. */
  land(err: unknown = null): void {
    if (!this.lastSigned) throw new Error('nothing signed yet');
    this.outcomes.set(this.lastSigned.signature, { landed: true, err });
  }

  /** Move the chain past every current blockhash's validity. */
  expireBlockhashes(): void {
    this.blockHeight += this.validityWindow + 1;
  }
}

let sql: Sql;
let ledger: Ledger;

async function fundedAgent(micros: number): Promise<string> {
  const agentId = `agent_${randomUUID()}`;
  await sql`
    INSERT INTO agents (id, display_name, key_prefix, key_hash, derivation_index, deposit_address)
    VALUES (${agentId}, 'Bot', ${randomUUID()}, 'hash',
            ${Math.floor(Math.random() * 2 ** 40)}, ${Keypair.generate().publicKey.toBase58()})`;
  await ledger.creditDeposit(agentId, micros, `sig_${randomUUID()}`);
  return agentId;
}

const destination = () => Keypair.generate().publicKey.toBase58();

beforeAll(async () => {
  sql = createSql();
  await migrate(sql);
  ledger = new Ledger(sql);
}, 30_000);

afterAll(async () => {
  await sql.end();
});

describe('requesting a withdrawal', () => {
  it('debits before anything touches the chain', async () => {
    // An agent must never have a transfer in flight for money it does not hold.
    const agentId = await fundedAgent(10_000_000);
    const chain = new FakeChain();
    const worker = new WithdrawalWorker(sql, ledger, chain);

    const withdrawal = await worker.request(agentId, destination(), 3_000_000);

    expect(withdrawal.status).toBe('debited');
    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(7_000_000);
    expect(chain.sent).toEqual([]);
  });

  it('refuses more than the agent holds, without sending anything', async () => {
    const agentId = await fundedAgent(1_000_000);
    const chain = new FakeChain();
    const worker = new WithdrawalWorker(sql, ledger, chain);

    await expect(worker.request(agentId, destination(), 5_000_000)).rejects.toThrow(
      /insufficient funds/,
    );
    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(1_000_000);
    expect(chain.sent).toEqual([]);
  });

  it.each([0, -1, 1.5])('refuses an amount of %s', async (amount) => {
    const agentId = await fundedAgent(1_000_000);
    const worker = new WithdrawalWorker(sql, ledger, new FakeChain());
    await expect(worker.request(agentId, destination(), amount)).rejects.toThrow(WithdrawalError);
  });
});

describe('the happy path', () => {
  it('signs, records the signature, sends, then confirms', async () => {
    const agentId = await fundedAgent(10_000_000);
    const chain = new FakeChain();
    const worker = new WithdrawalWorker(sql, ledger, chain);

    const requested = await worker.request(agentId, destination(), 2_000_000);
    const signed = await worker.advance(requested.id);

    expect(signed.status).toBe('sent');
    expect(signed.signature).toMatch(/^wsig_/);
    expect(chain.sent).toContain(signed.signature);

    chain.land();
    const confirmed = await worker.advance(requested.id);
    expect(confirmed.status).toBe('confirmed');
    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(8_000_000);
  });

  it('is a no-op once confirmed', async () => {
    const agentId = await fundedAgent(5_000_000);
    const chain = new FakeChain();
    const worker = new WithdrawalWorker(sql, ledger, chain);

    const requested = await worker.request(agentId, destination(), 1_000_000);
    await worker.advance(requested.id);
    chain.land();
    await worker.advance(requested.id);

    const again = await worker.advance(requested.id);
    expect(again.status).toBe('confirmed');
    expect(chain.sent).toHaveLength(1);
  });
});

describe('a send whose fate is unknown', () => {
  it('does not rebuild while the blockhash is still valid', async () => {
    // The naive recovery — "the send errored, so retry it" — builds a second transaction,
    // and if the first lands the agent is paid twice. The worker waits instead.
    const agentId = await fundedAgent(10_000_000);
    const chain = new FakeChain();
    chain.sendBehaviour = 'throw';
    const worker = new WithdrawalWorker(sql, ledger, chain);

    const requested = await worker.request(agentId, destination(), 2_000_000);
    const afterSend = await worker.advance(requested.id);
    expect(afterSend.status).toBe('signed');
    expect(afterSend.signature).toBeTruthy();

    const afterCheck = await worker.advance(requested.id);
    expect(afterCheck.status).toBe('signed');
    // Same signature, no second transaction built.
    expect(afterCheck.signature).toBe(afterSend.signature);
    expect(afterCheck.attempts).toBe(1);
  });

  it('confirms a transaction that landed even though the send reported an error', async () => {
    // The nastiest real case, and precisely why the worker asks the chain rather than
    // trusting the return value of `send`.
    const agentId = await fundedAgent(10_000_000);
    const chain = new FakeChain();
    chain.sendBehaviour = 'throw-but-lands';
    const worker = new WithdrawalWorker(sql, ledger, chain);

    const requested = await worker.request(agentId, destination(), 2_000_000);
    const afterSend = await worker.advance(requested.id);
    expect(afterSend.status).toBe('signed');

    const afterCheck = await worker.advance(requested.id);
    expect(afterCheck.status).toBe('confirmed');
    expect(chain.sent).toHaveLength(1);
    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(8_000_000);
  });

  it('rebuilds only once the blockhash has provably expired', async () => {
    // Expiry is the one signal that turns "I don't know whether it landed" into "it
    // definitively did not". A Solana transaction past its lastValidBlockHeight can never
    // be included — not "probably won't": cannot.
    const agentId = await fundedAgent(10_000_000);
    const chain = new FakeChain();
    chain.sendBehaviour = 'throw';
    const worker = new WithdrawalWorker(sql, ledger, chain);

    const requested = await worker.request(agentId, destination(), 2_000_000);
    const first = await worker.advance(requested.id);
    const firstSignature = first.signature;

    // Still valid: no rebuild.
    expect((await worker.advance(requested.id)).signature).toBe(firstSignature);

    chain.expireBlockhashes();
    const cleared = await worker.advance(requested.id);
    expect(cleared.status).toBe('debited');
    expect(cleared.signature).toBeNull();

    // Now a fresh attempt is safe.
    chain.sendBehaviour = 'ok';
    const retried = await worker.advance(requested.id);
    expect(retried.status).toBe('sent');
    expect(retried.signature).not.toBe(firstSignature);
    expect(retried.attempts).toBe(2);

    chain.land();
    expect((await worker.advance(requested.id)).status).toBe('confirmed');
    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(8_000_000);
  });

  it('never sends twice across a crash between signing and broadcasting', async () => {
    // Simulated by signing, then advancing again as a fresh worker would after restart.
    const agentId = await fundedAgent(10_000_000);
    const chain = new FakeChain();
    chain.sendBehaviour = 'throw';
    const worker = new WithdrawalWorker(sql, ledger, chain);

    const requested = await worker.request(agentId, destination(), 2_000_000);
    await worker.advance(requested.id);

    const recovered = new WithdrawalWorker(sql, ledger, chain);
    await recovered.advance(requested.id);
    await recovered.advance(requested.id);

    expect(chain.sent).toEqual([]);
    const state = await recovered.load(requested.id);
    expect(state.attempts).toBe(1);
  });
});

describe('a transaction that lands and fails', () => {
  it('refunds the agent, because the money never left', async () => {
    const agentId = await fundedAgent(10_000_000);
    const chain = new FakeChain();
    const worker = new WithdrawalWorker(sql, ledger, chain);

    const requested = await worker.request(agentId, destination(), 3_000_000);
    await worker.advance(requested.id);
    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(7_000_000);

    chain.land({ InstructionError: [0, 'InsufficientFunds'] });
    const outcome = await worker.advance(requested.id);

    expect(outcome.status).toBe('refunded');
    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(10_000_000);
  });

  it('refunds only once even if advanced repeatedly', async () => {
    const agentId = await fundedAgent(10_000_000);
    const chain = new FakeChain();
    const worker = new WithdrawalWorker(sql, ledger, chain);

    const requested = await worker.request(agentId, destination(), 3_000_000);
    await worker.advance(requested.id);
    chain.land({ InstructionError: [0, 'Custom'] });

    await worker.advance(requested.id);
    await worker.advance(requested.id);
    await worker.advance(requested.id);

    expect(await ledger.balanceOfAgent(agentId, 'available')).toBe(10_000_000);
  });
});

describe('queue and observability', () => {
  it('lists work that still needs doing', async () => {
    const agentId = await fundedAgent(10_000_000);
    const chain = new FakeChain();
    const worker = new WithdrawalWorker(sql, ledger, chain);
    const requested = await worker.request(agentId, destination(), 1_000_000);

    const pending = (await worker.pending()).map((w) => w.id);
    expect(pending).toContain(requested.id);

    await worker.advance(requested.id);
    chain.land();
    await worker.advance(requested.id);

    expect((await worker.pending()).map((w) => w.id)).not.toContain(requested.id);
  });

  it('surfaces a withdrawal that keeps being rebuilt', async () => {
    // Usually means the treasury is out of SOL for fees, or the destination cannot receive
    // the token. Worth paging on rather than discovering from a support message.
    const agentId = await fundedAgent(10_000_000);
    const chain = new FakeChain();
    chain.sendBehaviour = 'throw';
    const worker = new WithdrawalWorker(sql, ledger, chain);
    const requested = await worker.request(agentId, destination(), 1_000_000);

    for (let i = 0; i < 6; i++) {
      await worker.advance(requested.id);
      chain.expireBlockhashes();
      await worker.advance(requested.id);
    }

    const stuck = (await worker.findStuck(5)).map((w) => w.id);
    expect(stuck).toContain(requested.id);
  });
});

describe('the ledger stays balanced throughout', () => {
  it('after successes, failures and refunds alike', async () => {
    await expect(ledger.assertBalanced()).resolves.toBeUndefined();
    expect(await ledger.findNegativeAgentAccounts()).toEqual([]);
  });
});
