import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Sql, createSql, migrate } from '@clawroll/db';
import { PostgresAgentDirectory } from './agent-directory.js';
import { issueKey } from './auth.js';

let sql: Sql;

/** Register an agent the way the CLI does, and return the key it would have printed. */
async function registerAgent(displayName = 'Bot'): Promise<{ agentId: string; apiKey: string }> {
  const agentId = `agent_${randomUUID()}`;
  const issued = issueKey(agentId, displayName);
  await sql`
    INSERT INTO agents (id, display_name, key_prefix, key_hash, derivation_index, deposit_address)
    VALUES (${agentId}, ${displayName}, ${issued.record.keyPrefix}, ${issued.record.keyHash},
            ${Math.floor(Math.random() * 2 ** 40)}, ${randomUUID()})`;
  return { agentId, apiKey: issued.apiKey };
}

beforeAll(async () => {
  sql = createSql();
  await migrate(sql);
}, 30_000);

afterAll(async () => {
  await sql.end();
});

describe('authenticating against the database', () => {
  it('accepts a registered key', async () => {
    const { agentId, apiKey } = await registerAgent('Persistent Bot');
    const directory = new PostgresAgentDirectory(sql);
    await directory.warm();

    const record = directory.authenticate(apiKey);
    expect(record?.agentId).toBe(agentId);
    expect(record?.displayName).toBe('Persistent Bot');
  });

  it('survives a restart', async () => {
    // The entire point of this class. An SDK user who has to re-register on every redeploy
    // does not have a usable product.
    const { agentId, apiKey } = await registerAgent();
    const first = new PostgresAgentDirectory(sql);
    await first.warm();
    expect(first.authenticate(apiKey)?.agentId).toBe(agentId);

    const afterRestart = new PostgresAgentDirectory(sql);
    await afterRestart.warm();
    expect(afterRestart.authenticate(apiKey)?.agentId).toBe(agentId);
  });

  it('rejects a valid prefix with the wrong secret', async () => {
    const { apiKey } = await registerAgent();
    const directory = new PostgresAgentDirectory(sql);
    await directory.warm();

    const prefix = apiKey.split('_')[1];
    expect(directory.authenticate(`ck_${prefix}_wrongsecret`)).toBeNull();
  });

  it.each([
    ['malformed', 'nonsense'],
    ['wrong scheme', 'sk_abc_def'],
    ['unknown prefix', 'ck_deadbeef_secret'],
    ['empty', ''],
  ])('rejects a %s key', async (_label, key) => {
    const directory = new PostgresAgentDirectory(sql);
    await directory.warm();
    expect(directory.authenticate(key)).toBeNull();
  });

  it('never authenticates an agent it has not loaded', async () => {
    // `authenticate` is synchronous because the socket handler cannot await, so an unwarmed
    // directory must fail closed rather than guess.
    const { apiKey } = await registerAgent();
    const cold = new PostgresAgentDirectory(sql);
    expect(cold.authenticate(apiKey)).toBeNull();
  });

  it('picks up an agent registered after warming, once refreshed', async () => {
    // The quickstart path: register, then connect, without waiting for a redeploy.
    const directory = new PostgresAgentDirectory(sql);
    await directory.warm();

    const { agentId, apiKey } = await registerAgent();
    expect(directory.authenticate(apiKey)).toBeNull();

    await directory.warm();
    expect(directory.authenticate(apiKey)?.agentId).toBe(agentId);
  });

  it('caches records but never caches authentication results', async () => {
    // A cached record must not let a wrong key through: the secret is hashed and compared
    // on every call regardless of what is in the cache.
    const { apiKey } = await registerAgent();
    const directory = new PostgresAgentDirectory(sql);
    await directory.warm();

    expect(directory.authenticate(apiKey)).not.toBeNull();
    const prefix = apiKey.split('_')[1];
    expect(directory.authenticate(`ck_${prefix}_still-wrong`)).toBeNull();
    expect(directory.authenticate(apiKey)).not.toBeNull();
  });
});

describe('the secret is never stored', () => {
  it('keeps only a hash and a lookup prefix in the database', async () => {
    const { agentId, apiKey } = await registerAgent();
    const secret = apiKey.split('_').slice(2).join('_');

    const rows = await sql<{ key_hash: string; key_prefix: string }[]>`
      SELECT key_hash, key_prefix FROM agents WHERE id = ${agentId}`;

    expect(rows[0]?.key_hash).not.toContain(secret);
    expect(rows[0]?.key_prefix).not.toContain(secret);
    expect(JSON.stringify(rows[0])).not.toContain(secret);
  });
});
