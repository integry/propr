import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import knex from 'knex';
import { startDashboardReadService } from '../services/dashboardReadService.js';
import { advanceOutcomeProjection, installOutcomeProjection, loadCompletedRows, loadOutcomeSummaries,
  OutcomeProjectionError, OUTCOME_TABLES, rebuildOutcomeProjection } from '../routes/dashboardOutcomeQueries.js';
import { collectNarrativeFacts } from '../routes/dashboardNarrative.js';
import { createDashboardRoutes } from '../routes/dashboardRoutes.js';
import { call, createDashboardTestDatabase, seedTask, minutesAgo, NOW } from './dashboardTestHarness.js';

async function fixture(count = 2) {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-reads-'));
  const filename = join(directory, 'fixture.sqlite');
  const source = await createDashboardTestDatabase();
  for (let offset = 0; offset < count; offset += 100) {
    const ids = Array.from({ length: Math.min(100, count - offset) }, (_, index) => offset + index);
    await source('tasks').insert(ids.map(index => ({ task_id: `task-${index}`, repository: index % 2 ? 'acme/other' : 'acme/app',
      task_type: 'issue', issue_number: index, created_at: minutesAgo(index), initial_job_data: JSON.stringify({ title: `Title ${index}` }) })));
    await source('task_history').insert(ids.map(index => ({ task_id: `task-${index}`, state: 'completed', timestamp: minutesAgo(index) })));
  }
  await source.raw('VACUUM INTO ?', [filename]);
  await source.destroy();
  const db = knex({ client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true });
  await db.raw('PRAGMA journal_mode=WAL');
  return { db, close: async () => { await db.destroy(); await rm(directory, { recursive: true, force: true }); } };
}

test('read worker preserves projection/filter results, coalesces only concurrent reads, and sees subsequent writes', async () => {
  const data = await fixture();
  const service = await startDashboardReadService(data.db);
  try {
    const first = service.load('all');
    assert.equal(service.load('all'), first);
    assert.deepEqual(await first, await loadCompletedRows(data.db, 'all'));
    assert.deepEqual(await service.load('acme/app'), await loadCompletedRows(data.db, 'acme/app'));
    await data.db('tasks').where('task_id', 'task-0').update({ initial_job_data: JSON.stringify({ title: 'Änderung' }) });
    const fresh = await service.load('all', { search: 'ÄNDERUNG' });
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].title, 'Änderung');
    assert.deepEqual(fresh, await loadCompletedRows(data.db, 'all', { search: 'ÄNDERUNG' }));
    await data.db.schema.renameTable('tasks', 'temporarily_unavailable_tasks');
    await assert.rejects(service.load('all'), /no such table/);
    await data.db.schema.renameTable('temporarily_unavailable_tasks', 'tasks');
    assert.equal((await service.load('all')).length, 2, 'a query error must not poison the worker');
  } finally { await service.close(); await data.close(); }
  await assert.rejects(service.load('all'), /closed/);
});

test('bounds queued work and rejects outstanding reads on shutdown', async () => {
  const data = await fixture();
  const service = await startDashboardReadService(data.db);
  try {
    const reads = Array.from({ length: 32 }, (_, index) => service.load('all', { search: `query-${index}` }));
    const settled = Promise.allSettled(reads);
    await assert.rejects(service.load('all', { search: 'overflow' }), /queue is full/);
    await service.close();
    assert.ok((await settled).some(result => result.status === 'rejected'));
  } finally { await service.close(); await data.close(); }
});

test('large completion reads allow an API-thread timer and independent SQLite read to complete first', async () => {
  const data = await fixture(6000);
  const service = await startDashboardReadService(data.db);
  try {
    let completed = false;
    const heavy = service.load('all', { limit: 50 }).then(rows => { completed = true; return rows; });
    await new Promise(resolve => setTimeout(resolve, 10));
    const count = await data.db('tasks').count({ total: '*' }).first();
    assert.equal(Number(count?.total), 6000);
    assert.equal(completed, false, 'foreground work should finish during the completion projection');
    assert.equal((await heavy).length, 50);
  } finally { await service.close(); await data.close(); }
});

test('retains the supplied in-memory connection', async () => {
  const db = await createDashboardTestDatabase();
  const service = await startDashboardReadService(db);
  try {
    await seedTask(db, { taskId: 'memory', states: [{ state: 'completed', timestamp: minutesAgo(1) }] });
    assert.equal((await service.load('all'))[0].taskId, 'memory');
  } finally { await service.close(); await db.destroy(); }
});

for (const mode of ['memory', 'disabled', 'legacy'] as const) {
  test(`unmaintained ${mode} connection serves summaries and narrative with embedded history`, async t => {
    const previousMode = process.env.DASHBOARD_OUTCOME_PROJECTION;
    t.after(() => {
      if (previousMode === undefined) delete process.env.DASHBOARD_OUTCOME_PROJECTION;
      else process.env.DASHBOARD_OUTCOME_PROJECTION = previousMode;
    });
    if (mode === 'legacy') process.env.DASHBOARD_OUTCOME_PROJECTION = 'legacy';
    else delete process.env.DASHBOARD_OUTCOME_PROJECTION;
    const data = mode === 'memory' ? undefined : await fixture(0);
    const db = data?.db ?? await createDashboardTestDatabase();
    const service = await startDashboardReadService(db, mode === 'disabled' ? { projection: false } : {});
    try {
      await seedTask(db, { taskId: 'fallback', title: 'Änderung', states: [
        { state: 'completed', timestamp: minutesAgo(3) },
        { state: 'pending', timestamp: minutesAgo(2) },
        { state: 'completed', timestamp: minutesAgo(1), metadata: { notificationRecap: 'Shipped the change.' } },
      ] });
      await seedTask(db, { taskId: 'outside', repository: 'other/repo', states: [{ state: 'completed', timestamp: minutesAgo(0) }] });
      const query = { search: 'ÄNDERUNG', limit: 1 };
      assert.deepEqual(await service.load.summary!('integry/propr', query), await loadCompletedRows(db, 'integry/propr', query));
      const routes = createDashboardRoutes({ db, redisClient: {} as never,
        taskQueue: { isPaused: async () => false, getActiveCount: async () => 0 },
        liveDetails: async () => null, completedRows: service.load, now: () => NOW,
        narrativeModel: async () => ({ id: 'test', generate: async prompt => {
          assert.match(prompt, /Shipped the change/);
          return 'Recent work shipped.';
        } }),
      });
      const response = await call(routes.getOutcomes, { view: 'summary', repository: 'integry/propr', search: 'ÄNDERUNG', limit: '1' });
      assert.equal(response.status, 200);
      const items = response.body.items as Array<{ taskId: string; eventCount: number; earlierUpdates: unknown[] }>;
      assert.equal(items.length, 1);
      assert.equal(items[0].taskId, 'fallback');
      assert.equal(items[0].eventCount, 2);
      assert.equal(items[0].earlierUpdates.length, 1);
      assert.equal((await call(routes.getNarrative, { repository: 'integry/propr' })).body.summary, 'Recent work shipped.');
      await db('tasks').where('task_id', 'fallback').update({ initial_job_data: JSON.stringify({ title: 'Updated title' }) });
      assert.equal((await service.load.summary!('integry/propr'))[0].title, 'Updated title');
      assert.equal(await db.schema.hasTable(OUTCOME_TABLES.state), false);
    } finally { await service.close(); if (data) await data.close(); else await db.destroy(); }
  });
}

test('bounds a stalled read and releases its worker on shutdown', async () => {
  const data = await fixture(2000);
  const service = await startDashboardReadService(data.db, { timeoutMs: 1 });
  try {
    await assert.rejects(service.load('all'), /timed out/);
  } finally { await service.close(); await data.close(); }
});

test('a missing SQLite file fails startup instead of creating an empty database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-missing-'));
  const db = knex({ client: 'better-sqlite3', connection: { filename: join(directory, 'absent.sqlite') }, useNullAsDefault: true });
  try { await assert.rejects(startDashboardReadService(db), /unable to open|does not exist|SQLITE_CANTOPEN/i); }
  finally { await db.destroy(); await rm(directory, { recursive: true, force: true }); }
});


test('outcomes and narrative route their completion reads through the supplied service', async () => {
  const data = await fixture();
  const service = await startDashboardReadService(data.db);
  const calls: Array<{ repository: string; limit?: number; search?: string }> = [];
  const routes = createDashboardRoutes({
    db: data.db, redisClient: {} as never,
    taskQueue: { isPaused: async () => false, getActiveCount: async () => 0 },
    liveDetails: async () => null,
    completedRows: (repository, options) => {
      calls.push({ repository, ...options });
      return service.load(repository, options);
    },
  });
  try {
    assert.equal((await call(routes.getOutcomes, { repository: 'acme/app', search: 'Title', limit: '1' })).status, 200);
    assert.equal((await call(routes.getNarrative, { repository: 'acme/other' })).status, 200);
    assert.deepEqual(calls, [
      { repository: 'acme/app', search: 'Title', limit: 1 },
      { repository: 'acme/other', limit: 8 },
    ]);
  } finally { await service.close(); await data.close(); }
});


for (const summaryLoader of ['supplied', 'direct'] as const) {
  test(`summary requests and narrative remain available during backfill and rebuild (${summaryLoader} loader)`, async t => {
    const previousMode = process.env.DASHBOARD_OUTCOME_PROJECTION;
    delete process.env.DASHBOARD_OUTCOME_PROJECTION;
    t.after(() => {
      if (previousMode === undefined) delete process.env.DASHBOARD_OUTCOME_PROJECTION;
      else process.env.DASHBOARD_OUTCOME_PROJECTION = previousMode;
    });
    const data = await fixture(0);
    // Advance the projection explicitly to exercise each lifecycle state without
    // racing a background producer; legacy reads still use the real read worker.
    const service = await startDashboardReadService(data.db, { projection: false });
    const legacyCalls: Array<{ repository: string; limit?: number; search?: string }> = [];
    const legacy = (repository: string, options?: { limit?: number; search?: string }) => {
      legacyCalls.push({ repository, ...options });
      return service.load(repository, options);
    };
    const completedRows = summaryLoader === 'supplied'
      ? Object.assign(legacy, { summary: (repository: string, options?: { limit?: number; search?: string }) =>
        loadOutcomeSummaries(data.db, repository, options) })
      : legacy;
    const routes = createDashboardRoutes({ db: data.db, redisClient: {} as never,
      taskQueue: { isPaused: async () => false, getActiveCount: async () => 0 },
      liveDetails: async () => null, completedRows, now: () => NOW,
      narrativeModel: async () => ({ id: 'test', generate: async prompt => {
        assert.match(prompt, /Shipped the change/);
        assert.doesNotMatch(prompt, /Outside repository/);
        return 'Recent work shipped.';
      } }),
    });
    try {
      await seedTask(data.db, { taskId: 'fallback', title: 'Änderung', states: [
        { state: 'completed', timestamp: minutesAgo(3) },
        { state: 'pending', timestamp: minutesAgo(2) },
        { state: 'completed', timestamp: minutesAgo(1), metadata: { notificationRecap: 'Shipped the change.' } },
      ] });
      await seedTask(data.db, { taskId: 'outside', repository: 'other/repo', title: 'Outside repository',
        states: [{ state: 'completed', timestamp: minutesAgo(0) }] });
      await seedTask(data.db, { taskId: 'nonmatch', title: 'Unrelated title', issueNumber: 2,
        states: [{ state: 'completed', timestamp: minutesAgo(0) }] });
      const query = { repository: 'integry/propr', search: 'ÄNDERUNG', limit: '1' };
      const expected = await call(routes.getOutcomes, query);
      const drain = async () => {
        for (let attempt = 0; attempt < 20; attempt++) if (!await advanceOutcomeProjection(data.db)) return;
        assert.fail('projection did not drain');
      };
      for (const phase of ['absent', 'backfill', 'failed backfill', 'ready', 'rebuild', 'ready again']) {
        if (phase === 'backfill') {
          await installOutcomeProjection(data.db);
          await advanceOutcomeProjection(data.db);
        }
        if (phase === 'failed backfill') await data.db(OUTCOME_TABLES.state).update({ failures: 1, error: 'parity mismatch' });
        if (phase === 'rebuild') await rebuildOutcomeProjection(data.db);
        if (phase.startsWith('ready')) await drain();
        const ready = phase.startsWith('ready');
        const state = phase === 'absent' ? undefined : await data.db(OUTCOME_TABLES.state).first();
        const dirty = phase === 'absent' ? [] : await data.db(OUTCOME_TABLES.dirty).orderBy('task_id');
        legacyCalls.length = 0;
        for (const negotiation of ['accept', 'query']) {
          const response = await call((req, res) => {
            if (negotiation === 'accept') req.headers = { accept: 'application/vnd.propr.outcome-summaries+json' };
            return routes.getOutcomes(req, res);
          }, { ...query, ...(negotiation === 'query' ? { view: 'summary' } : {}) });
          assert.equal(response.status, 200, phase);
          if (!ready) assert.deepEqual(response.body, expected.body, phase);
          else {
            const items = response.body.items as Array<Record<string, unknown>>;
            assert.deepEqual(items.map(item => item.taskId), ['fallback']);
            assert.equal(items[0].eventCount, 2);
            assert.equal(items[0].earlierUpdates, undefined);
            assert.equal(typeof items[0].revision, 'string');
          }
        }
        assert.deepEqual(legacyCalls, ready ? [] : [
          { repository: query.repository, limit: 1, search: query.search },
          { repository: query.repository, limit: 1, search: query.search },
        ], phase);
        legacyCalls.length = 0;
        assert.equal((await call(routes.getNarrative, { repository: query.repository, refresh: 'true' })).body.summary, 'Recent work shipped.', phase);
        assert.deepEqual(legacyCalls, ready && summaryLoader === 'supplied' ? [] : [
          { repository: query.repository, limit: 8 },
        ], phase);
        if (state) {
          assert.deepEqual(await data.db(OUTCOME_TABLES.state).first(), state, 'fallback does not change projection readiness');
          assert.deepEqual(await data.db(OUTCOME_TABLES.dirty).orderBy('task_id'), dirty, 'fallback does not acknowledge pending work');
        }
      }
    } finally { await service.close(); await data.close(); }
  });
}

test('summary failures other than not-ready do not invoke the legacy fallback', async t => {
  const previousMode = process.env.DASHBOARD_OUTCOME_PROJECTION;
  delete process.env.DASHBOARD_OUTCOME_PROJECTION;
  t.after(() => {
    if (previousMode === undefined) delete process.env.DASHBOARD_OUTCOME_PROJECTION;
    else process.env.DASHBOARD_OUTCOME_PROJECTION = previousMode;
  });
  t.mock.method(console, 'error', () => undefined);
  const db = await createDashboardTestDatabase();
  try {
    for (const error of [new OutcomeProjectionError(409, 'OUTCOME_HISTORY_STALE'), new Error('read failed')]) {
      let legacyCalls = 0;
      const completedRows = Object.assign(async () => { legacyCalls++; return []; }, {
        summary: async () => { await Promise.resolve(); throw error; },
      });
      const routes = createDashboardRoutes({ db, redisClient: {} as never,
        taskQueue: {} as never, liveDetails: async () => null, completedRows });
      const response = await call(routes.getOutcomes, { view: 'summary' });
      assert.equal(response.status, error instanceof OutcomeProjectionError ? 409 : 500);
      await assert.rejects(collectNarrativeFacts(db, 'all', NOW, { completedRows }), caught => caught === error);
      assert.equal(legacyCalls, 0);
    }
  } finally { await db.destroy(); }
});
