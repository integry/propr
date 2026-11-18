import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import knex, { type Knex } from 'knex';
import type { PluginJsonValue } from '@propr/shared';
import { installSqliteRetry } from '../src/db/sqliteRetry.js';
import { pluginStateStore } from '../src/plugins/pluginStateStore.js';

/**
 * `ctx.state.update` from two processes: the API process (webhook handlers)
 * and the daemon (event handlers) write one plugin's state through separate
 * SQLite connections to one WAL database. `update` reads and then writes in
 * one transaction; with knex's deferred `BEGIN` the read takes a snapshot,
 * and the write then fails with SQLITE_BUSY (a snapshot conflict) when the
 * other connection committed in between, without waiting. The instance
 * database (`db/connection.ts`) installs the SQLite retry layer, which opens
 * every outermost transaction with `BEGIN IMMEDIATE`: the write lock is taken
 * before the read, so contention is a wait (an asynchronous retry of `BEGIN`)
 * instead of a failed delivery. Two knex instances stand in for the two
 * processes; the busy timeout is short so the test runs fast.
 */

const PLUGIN = 'example-pack';

async function connection(file: string, retry: boolean): Promise<Knex> {
  const database = knex({
    client: 'better-sqlite3', connection: { filename: file }, useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate(conn: { pragma: (sql: string) => unknown }, done: (error: Error | null, conn: unknown) => void) {
      conn.pragma('busy_timeout = 20'); conn.pragma('journal_mode = WAL'); done(null, conn);
    } },
  });
  if (retry) installSqliteRetry(database, { maxTotalMs: 10_000, baseDelayMs: 1, maxDelayMs: 5 });
  return database;
}

async function twoProcesses(t: test.TestContext, retry: boolean) {
  const directory = mkdtempSync(path.join(tmpdir(), 'plugin-state-'));
  const file = path.join(directory, 'instance.sqlite');
  const api = await connection(file, retry); const daemon = await connection(file, retry);
  t.after(async () => { await api.destroy(); await daemon.destroy(); rmSync(directory, { recursive: true, force: true }); });
  await api.schema.createTable('plugin_state', table => {
    table.string('plugin_id').notNullable(); table.string('state_key', 200).notNullable(); table.text('value').notNullable();
    table.integer('bytes').notNullable(); table.bigInteger('updated_at').notNullable(); table.primary(['plugin_id', 'state_key']);
  });
  return [pluginStateStore(api, PLUGIN), pluginStateStore(daemon, PLUGIN)];
}

const list = (value: PluginJsonValue | undefined): number[] => (Array.isArray(value) ? value as number[] : []);
const concurrentUpdates = (stores: ReturnType<typeof pluginStateStore>[], count: number) =>
  Promise.allSettled(Array.from({ length: count }, (_, i) => stores[i % stores.length].update('shard', current => [...list(current), i])));

test('updates of one key from two connections to the instance database wait for each other and all apply', async t => {
  const stores = await twoProcesses(t, true);
  const results = await concurrentUpdates(stores, 40);
  assert.deepEqual(results.filter(r => r.status === 'rejected'), [], 'no update fails on contention');
  assert.deepEqual(list(await stores[1].get('shard')).sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i));
});

test('negative check: with deferred transactions (no retry layer) the same updates fail on contention', async t => {
  const stores = await twoProcesses(t, false);
  const results = await concurrentUpdates(stores, 40);
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  assert.ok(failed.length > 0, 'a deferred read-then-write transaction loses the race instead of waiting');
  assert.ok(failed.every(r => /SQLITE_BUSY/.test(String((r.reason as { code?: string }).code ?? r.reason))), String(failed[0]?.reason));
});
