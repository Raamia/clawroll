/**
 * Reproduce the reconnect storm locally, against whatever code is checked out.
 *
 * Not a test — it needs twenty-five seconds and the machine to itself — but it is the check
 * that should have run before the second deploy of F30 rather than after the third. Twelve
 * agents each open a fresh socket and send `join_table` every ~100 ms, which is exactly what
 * a reconnecting SDK does while the agent is still seated from the socket before. The public
 * API is timed throughout. Afterwards: ledger transactions the storm produced, whether any
 * pool connection was left inside a transaction, and whether the API is healthy without a
 * restart.
 *
 *   DATABASE_URL=postgres://clawroll:clawroll_dev@127.0.0.1:5432/clawroll \
 *   NODE_OPTIONS=--conditions=development npx tsx apps/engine/src/bench/storm.ts
 *
 * `SHARED_POOL=1` puts the archive reads back on the engine's pool, the arrangement that
 * hung the site in production. Numbers from both arrangements are in `features.md`.
 */
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { Ledger, createSql, migrate } from '@clawroll/db';
import { BankrollService } from '../bankroll.js';
import { ClawrollServer, DEFAULT_SERVER_CONFIG } from '../server.js';
import { HandArchive } from '../archive.js';
import { InMemoryAgentDirectory } from '../auth.js';
import type { TableConfig } from '../table.js';

const AGENTS = 12, STORM_MS = 25_000, RECONNECT_EVERY_MS = 100;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))] ?? NaN; };
const mb = (n: number) => (n / 1024 / 1024).toFixed(0) + 'MB';

async function main() {
  const sql = createSql();
  const reads = createSql(undefined, { max: 3, statementTimeoutMs: 15_000 });
  const diag = createSql(undefined, { max: 1 });
  await migrate(sql);
  const ledger = new Ledger(sql);
  const bankroll = new BankrollService(sql, ledger);
  const run = randomUUID().slice(0, 6);
  const table = (id: string): TableConfig => ({ tableId: `storm_${run}_${id}`, smallBlind: 10_000, bigBlind: 20_000, maxSeats: 6, minBuyIn: 1_000_000, maxBuyIn: 5_000_000, actionTimeoutMs: 5_000, seedTimeoutMs: 2_000 });
  const tables = [table('main'), table('high')];
  const directory = new InMemoryAgentDirectory();
  const server = new ClawrollServer({ ...DEFAULT_SERVER_CONFIG, port: 0, tables, autoStartHands: true, handIntervalMs: 2_000 }, directory, bankroll, new HandArchive(sql, process.env['SHARED_POOL'] ? sql : reads));
  const port = await server.start();

  const base = Date.now() % 2 ** 30;
  const keys: { key: string; tableId: string }[] = [];
  for (let i = 0; i < AGENTS; i++) {
    const id = `agent_${randomUUID()}`;
    await sql`INSERT INTO agents (id, display_name, key_prefix, key_hash, derivation_index, deposit_address)
              VALUES (${id}, ${`storm${i}`}, ${randomUUID()}, 'hash', ${base * 1000 + i}, ${`addr_${run}_${i}`})`;
    await ledger.creditDeposit(id, 50_000_000, `sig_${randomUUID()}`);
    keys.push({ key: directory.register(id, `storm${i}`).apiKey, tableId: tables[i % 2]!.tableId });
  }

  const txSince = async (t: Date) => Number((await diag<{ n: string }[]>`SELECT count(*)::text AS n FROM ledger_txs WHERE created_at > ${t}`)[0]!.n);
  const poolState = async () => (await diag<{ state: string; n: string }[]>`
      SELECT coalesce(state,'?') AS state, count(*)::text AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() GROUP BY 1`).map(r => `${r.state}=${r.n}`).join(' ');
  const lockWaits = async () => Number((await diag<{ n: string }[]>`SELECT count(*)::text AS n FROM pg_stat_activity WHERE wait_event_type='Lock'`)[0]!.n);
  const timeApi = async (path: string) => { const a = performance.now(); try { const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(12_000) }); return { ms: performance.now() - a, status: r.status }; } catch { return { ms: performance.now() - a, status: 0 }; } };

  // Baseline: seat everyone once, the normal way.
  const live = new Set<WebSocket>();
  const connectAndJoin = ({ key, tableId }: { key: string; tableId: string }) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent?key=${key}`);
    live.add(ws);
    ws.on('close', () => live.delete(ws));
    ws.on('error', () => {});
    ws.on('message', (raw: Buffer) => { const m = JSON.parse(raw.toString()); if (m.type === 'welcome') ws.send(JSON.stringify({ type: 'join_table', tableId, buyIn: 2_000_000 })); if (m.type === 'action_request') ws.send(JSON.stringify({ type: 'action', handId: m.handId, requestId: m.requestId, action: m.legal.canCheck ? 'check' : 'call' })); if (m.type === 'hand_start') ws.send(JSON.stringify({ type: 'client_seed', handId: m.handId, seed: randomUUID().replace(/-/g,'') + randomUUID().replace(/-/g,'') })); });
    return ws;
  };
  for (const k of keys) connectAndJoin(k);
  await sleep(4_000);
  const seated = () => [...server.tables.values()].map(t => (t.tableState() as any).seats.filter((s: any) => s.playerId).length).join('+');
  console.log(`baseline: seated ${seated()}, rss ${mb(process.memoryUsage().rss)}, pool[${await poolState()}]`);

  // Storm.
  const stormStart = new Date();
  const txBefore = await txSince(stormStart);
  const rssBefore = process.memoryUsage().rss; let rssPeak = rssBefore;
  let connects = 0; const lat: Record<string, number[]> = { '/api/hands': [], '/api/leaderboard': [] }; const bad: Record<string, number> = {};
  const stormers = keys.map(k => (async () => { const end = Date.now() + STORM_MS; while (Date.now() < end) { connectAndJoin(k); connects++; await sleep(RECONNECT_EVERY_MS); } })());
  const prober = (async () => { const end = Date.now() + STORM_MS; while (Date.now() < end) { for (const p of Object.keys(lat)) { const r = await timeApi(p); lat[p]!.push(r.ms); if (r.status !== 200) bad[p] = (bad[p] ?? 0) + 1; } rssPeak = Math.max(rssPeak, process.memoryUsage().rss); await sleep(500); } })();
  await Promise.all([...stormers, prober]);
  const txDuring = await txSince(stormStart) - txBefore;
  console.log(`storm: ${connects} reconnect+join in ${STORM_MS / 1000}s (${(connects / (STORM_MS / 1000)).toFixed(0)}/s), ledger tx produced: ${txDuring}`);
  for (const p of Object.keys(lat)) console.log(`  ${p.padEnd(17)} during storm: p50 ${pct(lat[p]!, 50).toFixed(0)}ms  max ${pct(lat[p]!, 100).toFixed(0)}ms  non-200: ${bad[p] ?? 0}/${lat[p]!.length}`);
  console.log(`  rss before ${mb(rssBefore)} peak ${mb(rssPeak)}; lock waits now ${await lockWaits()}; pool[${await poolState()}]`);

  // After: everything closed, nothing restarted.
  for (const ws of live) ws.close();
  await sleep(3_000);
  const after = await Promise.all(['/api/hands', '/api/leaderboard', '/api/tables'].map(async p => `${p} ${(await timeApi(p)).status}/${(await timeApi(p)).ms.toFixed(0)}ms`));
  console.log(`after (no restart): ${after.join('  ')}`);
  console.log(`  pool[${await poolState()}], lock waits ${await lockWaits()}, rss ${mb(process.memoryUsage().rss)}, seated ${seated()}`);
  const idleInTx = Number((await diag<{ n: string }[]>`SELECT count(*)::text AS n FROM pg_stat_activity WHERE state = 'idle in transaction'`)[0]!.n);
  console.log(`RESULT idle_in_transaction=${idleInTx} ledger_tx_during_storm=${txDuring} api_non200=${Object.values(bad).reduce((a, b) => a + b, 0)}`);

  await server.stop(); await Promise.all([sql.end(), reads.end(), diag.end()]); process.exit(0);
}
main().catch(e => { console.error('storm failed:', e); process.exit(1); });
