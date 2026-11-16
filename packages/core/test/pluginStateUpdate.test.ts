import test from 'node:test';
import assert from 'node:assert/strict';
import type { PluginContext, PluginJsonValue } from '@propr/shared';
import { pluginStateStore } from '../src/plugins/pluginStateStore.js';
import { handOffTicket } from '../../plugins/_shared/trackerIssue.js';
import { readTicket, ticketKey } from '../../plugins/_shared/trackerRecords.js';
import { FIXTURE_ID, pluginHandlerFixture } from './helpers/pluginHandlerFixture.js';

/**
 * `ctx.state.update`: an atomic read-and-replace of one key in
 * `plugin_state`, so handlers running at the same time (each with its own
 * store, as in separate ProPR processes) never overwrite each other's changes.
 * The tracker helper's ticket shards rely on it.
 */

async function guardedStores(t: Parameters<typeof pluginHandlerFixture>[0], count: number) {
  const f = await pluginHandlerFixture(t);
  const installedAt = Number((await f.database('plugin_installations').where({ plugin_id: FIXTURE_ID }).first('installed_at')).installed_at);
  const stores = Array.from({ length: count }, () => pluginStateStore(f.database, FIXTURE_ID, Date.now, { installedAt, signal: new AbortController().signal }));
  return { f, stores, installedAt };
}

const list = (value: PluginJsonValue | undefined): PluginJsonValue[] => (Array.isArray(value) ? value : []);

test('updates of one key from several stores at the same time all apply', async t => {
  const { stores } = await guardedStores(t, 4);
  await Promise.all(Array.from({ length: 40 }, (_, i) => stores[i % stores.length].update('shard', current => [...list(current), i])));
  const stored = list(await stores[0].get('shard')) as number[];
  assert.deepEqual([...stored].sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i));
});

test('update leaves the value unchanged when told to, on a refusal and when the change throws', async t => {
  const { stores: [store] } = await guardedStores(t, 1);
  assert.deepEqual(await store.update('k', () => ['a']), ['a']);
  assert.deepEqual(await store.update('k', () => undefined), ['a'], 'undefined writes nothing');
  await assert.rejects(store.update('k', () => 'x'.repeat(20 * 1024)), { code: 'state_limit' });
  await assert.rejects(store.update('k', () => { throw new Error('changed my mind'); }), /changed my mind/);
  await assert.rejects(store.update('k', (async () => ['late']) as unknown as () => PluginJsonValue), { code: 'invalid_input' }, 'a change that awaits is refused');
  assert.deepEqual(await store.get('k'), ['a']);
  assert.deepEqual(await store.update('fresh', current => (current === undefined ? 1 : 2)), 1, 'a missing key reads as undefined');
});

test('update is refused once the installation is gone', async t => {
  const { f, stores: [store] } = await guardedStores(t, 1);
  await f.store.setEnabled('1', FIXTURE_ID, false);
  await f.store.uninstall('1', FIXTURE_ID, FIXTURE_ID);
  await assert.rejects(store.update('k', () => 1), { code: 'unavailable' });
});

test('tracker hand-offs in separate stores at the same time keep every ticket and create one issue per ticket', async t => {
  const { stores } = await guardedStores(t, 6);
  // Ticket ids sharing one shard, delivered twice each, every delivery with its own store.
  const shard = ticketKey('ticket-0');
  const ids = Array.from({ length: 400 }, (_, i) => `ticket-${i}`).filter(id => ticketKey(id) === shard).slice(0, 4);
  assert.equal(ids.length, 4);
  let issues = 0;
  const created: string[] = [];
  const ctx = (state: PluginContext['state']) => ({
    pluginId: FIXTURE_ID, settings: {}, repositories: null, state, signal: new AbortController().signal,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    propr: { createIssue: async (repository: string, issue: { title: string }) => { await new Promise(r => setTimeout(r, 5)); issues += 1; created.push(issue.title); return { repository, number: issues, url: '' }; } },
  }) as unknown as PluginContext;
  const deliveries = [...ids, ...ids].map((id, i) => handOffTicket(ctx(stores[i % stores.length]), {
    id, reference: `ENG-${id.slice(7)}`, url: null, title: 'Ticket', description: '', repository: 'acme/api', githubLabel: 'AI', service: 'Linear', trigger: 'a label',
  }));
  const results = await Promise.all(deliveries);
  assert.equal(results.filter(r => r.outcome === 'created').length, ids.length);
  assert.equal(created.length, ids.length, 'one issue per ticket');
  assert.equal(new Set(created).size, ids.length);
  for (const id of ids) assert.equal((await readTicket(ctx(stores[0]), id))?.s, 'created', id);
});
