import assert from 'node:assert/strict';
import { after, beforeEach, describe, mock, test } from 'node:test';
import knex from 'knex';
import { up, down } from '../src/db/migrations/20261112160000_create_repository_events.js';

const published: Array<Record<string, unknown>> = [];
const warnings: Array<Record<string, unknown>> = [];
const log = { info() {}, warn(entry: Record<string, unknown>) { warnings.push(entry); }, error() {}, debug() {}, withCorrelation: () => log };
await mock.module('../src/utils/logger.js', { defaultExport: log });
await mock.module('../src/utils/eventPublisher.js', { namedExports: {
  getEventPublisher: () => ({ publishActivity: async (activity: Record<string, unknown>) => { published.push(activity); return true; } }),
} });
const {
  appendRepositoryEvent, listRepositoryEvents, pruneRepositoryEvents, getRepositoryEventFloor,
  getRepositoryEventJournalStats, repositoryEventActivity,
} = await import('../src/services/repositoryEventJournal.js');

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await up(database);
after(async () => database.destroy());
beforeEach(async () => {
  await database('repository_events').delete();
  await database('repository_event_floors').delete();
  published.length = 0; warnings.length = 0;
});

const flush = () => new Promise(resolve => setImmediate(resolve));
const event = (overrides: Record<string, unknown> = {}) => ({
  repository: 'acme/app', domain: 'pull_request' as const, type: 'opened', entityId: 7, prNumber: 7, ...overrides,
});

describe('repository event journal', () => {
  test('migration creates the table and its indexes, and down drops them', async () => {
    const scratch = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    try {
      await up(scratch);
      const indexes = (await scratch.raw("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'repository_events'"))
        .map((row: { name: string }) => row.name);
      for (const name of ['repository_events_repository_seq', 'repository_events_entity_seq', 'repository_events_dedupe']) {
        assert.ok(indexes.includes(name), `missing index ${name}`);
      }
      assert.ok(await scratch.schema.hasTable('repository_event_floors'));
      await down(scratch);
      assert.equal(await scratch.schema.hasTable('repository_events'), false);
      assert.equal(await scratch.schema.hasTable('repository_event_floors'), false);
    } finally {
      await scratch.destroy();
    }
  });

  test('appends in seq order, scoped by repository and filterable by domain and entity', async () => {
    await appendRepositoryEvent(database, event());
    await appendRepositoryEvent(database, event({ repository: 'other/repo' }));
    await appendRepositoryEvent(database, event({ type: 'head_changed', headSha: 'abc' }));
    await appendRepositoryEvent(database, { repository: 'acme/app', domain: 'epic_queue', type: 'started', entityId: 'exec-1', planId: 'draft' });
    await appendRepositoryEvent(database, event({ type: 'merged', entityId: 8, prNumber: 8 }));

    const all = await listRepositoryEvents(database, { repository: 'acme/app' });
    assert.deepEqual(all.map(row => row.type), ['opened', 'head_changed', 'started', 'merged']);
    assert.ok(all.every((row, index) => index === 0 || row.seq > all[index - 1].seq));
    assert.ok(all.every(row => row.repository === 'acme/app'));
    assert.equal(all[1].headSha, 'abc');

    const afterCursor = await listRepositoryEvents(database, { repository: 'acme/app', afterSeq: all[1].seq });
    assert.deepEqual(afterCursor.map(row => row.type), ['started', 'merged']);
    const prOnly = await listRepositoryEvents(database, { repository: 'acme/app', domains: ['pull_request'], entityId: 7 });
    assert.deepEqual(prOnly.map(row => row.type), ['opened', 'head_changed']);
    assert.deepEqual((await listRepositoryEvents(database, { repository: 'acme/app', limit: 1 })).map(row => row.type), ['opened']);
  });

  test('a repeated dedupe key appends one row, per repository', async () => {
    const first = await appendRepositoryEvent(database, event({ dedupeKey: 'pr:7:opened' }));
    const second = await appendRepositoryEvent(database, event({ dedupeKey: 'pr:7:opened' }));
    const elsewhere = await appendRepositoryEvent(database, event({ repository: 'other/repo', dedupeKey: 'pr:7:opened' }));
    assert.equal(first.status, 'appended');
    assert.equal(second.status, 'duplicate');
    assert.equal(elsewhere.status, 'appended');
    assert.equal((await listRepositoryEvents(database, { repository: 'acme/app' })).length, 1);
    // Events without a key never collide.
    await appendRepositoryEvent(database, event());
    await appendRepositoryEvent(database, event());
    assert.equal((await listRepositoryEvents(database, { repository: 'acme/app' })).length, 3);
  });

  test('a failed append is logged and counted, never thrown', async () => {
    const before = getRepositoryEventJournalStats().failures;
    const broken = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    try {
      const result = await appendRepositoryEvent(broken, event());
      assert.equal(result.status, 'failed');
      assert.equal(getRepositoryEventJournalStats().failures, before + 1);
      assert.equal(warnings.length, 1);
      // Invalid events are refused the same way.
      assert.equal((await appendRepositoryEvent(database, event({ type: 'not_a_type' }))).status, 'failed');
      assert.equal((await appendRepositoryEvent(database, event({ payload: { blob: 'x'.repeat(5000) } }))).status, 'failed');
      assert.equal(published.length, 0);
    } finally {
      await broken.destroy();
    }
  });

  test('a failed append inside a transaction leaves the caller write intact', async () => {
    // No journal table here: the append's statement fails inside the caller's transaction.
    const scratch = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    try {
      await scratch.schema.createTable('caller_rows', table => { table.integer('id'); });
      await scratch.transaction(async trx => {
        await trx('caller_rows').insert({ id: 1 });
        assert.equal((await appendRepositoryEvent(trx, event())).status, 'failed');
        await trx('caller_rows').insert({ id: 2 });
      });
      assert.deepEqual((await scratch('caller_rows').select('id')).map(row => row.id), [1, 2]);
    } finally {
      await scratch.destroy();
    }
  });

  test('publishes a bare activity event only after the append commits', async () => {
    await database.transaction(async trx => {
      await appendRepositoryEvent(trx, event({ type: 'merged' }));
      await flush();
      assert.equal(published.length, 0, 'published before commit');
    });
    await flush();
    assert.equal(published.length, 1);
    assert.deepEqual(published[0], { domain: 'pull_request', change: 'completed', entityId: '7', repository: 'acme/app' });

    await database.transaction(async trx => {
      await appendRepositoryEvent(trx, event({ type: 'closed' }));
      throw new Error('rolled back');
    }).catch(() => undefined);
    await flush();
    assert.equal(published.length, 1, 'a rolled-back append is never announced');
    assert.equal((await listRepositoryEvents(database, { repository: 'acme/app' })).length, 1);
  });

  test('maps journal events onto the activity envelope', () => {
    assert.equal(repositoryEventActivity(event({ type: 'ultrafix_ended', payload: { outcome: 'stopped' } }))?.change, 'cancelled');
    assert.equal(repositoryEventActivity(event({ type: 'review_scored' }))?.change, 'progressed');
    assert.deepEqual(repositoryEventActivity({ repository: 'acme/app', domain: 'epic_queue', type: 'blocked', entityId: 'e', planId: 'draft' }),
      { domain: 'plan', change: 'blocked', entityId: 'draft', repository: 'acme/app' });
    // Plan issue status writes publish their own plan event.
    assert.equal(repositoryEventActivity({ repository: 'acme/app', domain: 'plan_issue', type: 'status_changed', entityId: 1 }), null);
  });

  test('retention prunes old rows per repository and records the floor', async () => {
    const now = Date.parse('2026-11-12T00:00:00.000Z');
    const day = 24 * 60 * 60 * 1000;
    const old1 = await appendRepositoryEvent(database, event({ occurredAt: new Date(now - 40 * day) }));
    const old2 = await appendRepositoryEvent(database, event({ type: 'merged', occurredAt: new Date(now - 31 * day) }));
    await appendRepositoryEvent(database, event({ repository: 'other/repo', occurredAt: new Date(now - 35 * day) }));
    const fresh = await appendRepositoryEvent(database, event({ type: 'closed', occurredAt: new Date(now - day) }));
    assert.equal(old1.status, 'appended'); assert.equal(old2.status, 'appended'); assert.equal(fresh.status, 'appended');

    assert.equal(await getRepositoryEventFloor(database, 'acme/app'), 1);
    const result = await pruneRepositoryEvents(database, { now: () => now });
    assert.equal(result.deleted, 3);
    const remaining = await listRepositoryEvents(database, { repository: 'acme/app' });
    assert.deepEqual(remaining.map(row => row.type), ['closed']);
    assert.equal(await getRepositoryEventFloor(database, 'acme/app'), (old2 as { seq: number }).seq + 1);
    assert.ok(await getRepositoryEventFloor(database, 'other/repo') > 1);
    assert.equal(await getRepositoryEventFloor(database, 'never/pruned'), 1);

    // A later sweep with nothing expired leaves the floor where it was.
    assert.equal((await pruneRepositoryEvents(database, { now: () => now })).deleted, 0);
    assert.equal(await getRepositoryEventFloor(database, 'acme/app'), (old2 as { seq: number }).seq + 1);
  });

  test('retention keeps unexpired events appended before an older-stamped one', async () => {
    const now = Date.parse('2026-11-12T00:00:00.000Z');
    const day = 24 * 60 * 60 * 1000;
    const repository = 'late/delivery';
    const recent = [];
    for (const type of ['opened', 'head_changed', 'review_scored']) {
      recent.push(await appendRepositoryEvent(database, event({ repository, type, occurredAt: new Date(now - day) })) as { seq: number });
    }
    // A delayed delivery stamped with its original, expired time lands at a higher seq.
    const late = await appendRepositoryEvent(database, event({ repository, type: 'closed', occurredAt: new Date(now - 45 * day) })) as { seq: number };
    const after = await appendRepositoryEvent(database, event({ repository, type: 'merged', occurredAt: new Date(now - day) })) as { seq: number };

    const result = await pruneRepositoryEvents(database, { now: () => now });
    assert.equal(result.deleted, 1);
    assert.deepEqual((await listRepositoryEvents(database, { repository })).map(row => row.seq),
      [...recent.map(row => row.seq), after.seq]);
    // The floor still moves past every deleted seq, so a cursor below it is known to have missed the pruned row.
    assert.equal(await getRepositoryEventFloor(database, repository), late.seq + 1);
    assert.equal(result.floors[repository], late.seq + 1);
  });
});
