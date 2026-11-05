/** Offline projection parity/performance harness and explicit rebuild command. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import knex, { type Knex } from 'knex';
import {
  type OutcomeReadRow, compactOutcome, advanceOutcomeProjection, installOutcomeProjection, loadCompletedRows, loadOutcomeSummaries,
  loadOutcomeHistory, outcomeProjectionStatus, OUTCOME_TABLES as T, rebuildOutcomeProjection,
} from '../packages/api/routes/dashboardOutcomeQueries.js';
import { startDashboardReadService, setOutcomeActivityPublisher, type DashboardReadService } from '../packages/api/services/dashboardReadService.js';

async function catchUp(db: Knex) {
  while (await advanceOutcomeProjection(db)) { /* bounded transactions; persistent progress */ }
}

/** Both readers and every history page see exactly the same SQLite snapshot. */
async function parity(db: Knex, repository = 'all', search?: string) {
  await db.transaction(async tx => {
    const old = await loadCompletedRows(tx, repository, { limit: 100, search });
    const summaries = await loadOutcomeSummaries(tx, repository, { limit: 100, search });
    assert.equal(summaries.length, old.length);
    for (const [index, summary] of summaries.entries()) {
      const { entityId, revision, ...visible } = summary;
      const { earlierUpdates, ...expected } = old[index];
      // The oracle leaks its internal grouping key into its private row type;
      // it has never been a visible API field.
      delete (expected as unknown as Record<string, unknown>).entityKey;
      assert.deepEqual(visible, { ...compactOutcome(expected), eventCount: expected.eventCount });
      assert.ok(!('earlierUpdates' in summary));
      const history = [];
      let cursor: string | null = null;
      do {
        const page = await loadOutcomeHistory(tx, summary.repository, entityId, revision, { limit: 2, cursor: cursor ?? undefined });
        history.push(...page.updates);
        cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual(history, earlierUpdates.map(compactOutcome));
    }
  });
}

async function selfTest() {
  const { createDashboardTestDatabase, seedTask, minutesAgo, call } = await import('../packages/api/test/dashboardTestHarness.js');
  const { createDashboardRoutes } = await import('../packages/api/routes/dashboardRoutes.js');
  const directory = await mkdtemp(join(tmpdir(), 'outcome-projection-'));
  const path = join(directory, 'test.sqlite');
  const fixture = await createDashboardTestDatabase();
  // Same task, distinct review/follow-up runs; duplicate completions; no recap leakage.
  await seedTask(fixture, {
    taskId: 'reused', prNumber: 42, taskType: 'pr-comment', title: 'Änderung', states: [
      { state: 'processing', timestamp: minutesAgo(10), metadata: { commandMode: 'review' } },
      { state: 'completed', timestamp: minutesAgo(9), metadata: { notificationRecap: 'Score 8/10 · Fixed boundary' } },
      { state: 'completed', timestamp: minutesAgo(8) },
      { state: 'pending', timestamp: minutesAgo(7), metadata: { commandMode: 'default' } },
      { state: 'completed', timestamp: minutesAgo(6) },
      { state: 'processing', timestamp: minutesAgo(5), metadata: { commandMode: 'review' } },
      { state: 'completed', timestamp: minutesAgo(4), metadata: { notificationRecap: 'Scores 9/10, 6/10 · 2 issues found' } },
    ]
  });
  for (const [taskId, repository, taskType, reason] of [
    ['other-repo', 'acme/other', 'review', null], ['skip', 'integry/propr', 'pr-comment', 'PR comment job skipped: done'],
    ['goal', 'integry/propr', 'goal', null], ['pr-comments-legacy', 'integry/propr', 'issue', null],
    ['final-result', 'integry/propr', 'issue', null],
  ]) await seedTask(fixture, {
    taskId: taskId!, repository: repository!, taskType: taskType!, issueNumber: 42,
    states: [{ state: 'completed', timestamp: minutesAgo(3), reason: reason ?? undefined }]
  });
  await fixture('tasks').where('task_id', 'final-result').update({ final_result: JSON.stringify({ postProcessing: { pr: { number: 42 } } }) });
  await seedTask(fixture, {
    taskId: 'fallback-old', prNumber: 123, taskType: 'pr-comment',
    title: 'Review PR #123: Fallback title', states: [{ state: 'completed', timestamp: minutesAgo(15) }]
  });
  await seedTask(fixture, {
    taskId: 'fallback-new', prNumber: 123, taskType: 'pr-comment', title: ' ',
    states: [{ state: 'completed', timestamp: minutesAgo(14), metadata: { notificationRecap: 'Score 8/10 · Fallback review' } }]
  });
  await seedTask(fixture, { taskId: 'numeric-time', issueNumber: 321,
    states: Array.from({ length: 4 }, (_, run) => [
      { state: 'processing', timestamp: minutesAgo(20 - run * 2) },
      { state: 'completed', timestamp: minutesAgo(19 - run * 2) },
    ]).flat() });
  for (const row of await fixture('task_history').where('task_id', 'numeric-time')) {
    await fixture('task_history').where('history_id', row.history_id).update({ timestamp: Date.UTC(2026, 8, 29) + row.history_id * 1000 });
  }
  await fixture.raw('VACUUM INTO ?', [path]);
  await fixture.destroy();
  let db = knex({ client: 'better-sqlite3', connection: { filename: path }, useNullAsDefault: true });
  let service: DashboardReadService | undefined;
  let peer: DashboardReadService | undefined;
  try {
    await db.raw('PRAGMA journal_mode=WAL');
    await installOutcomeProjection(db);
    await assert.rejects(loadOutcomeSummaries(db, 'all'), /OUTCOMES_NOT_READY/);
    await advanceOutcomeProjection(db); // Stop during backfill; a new process resumes.
    await db.destroy();
    db = knex({ client: 'better-sqlite3', connection: { filename: path }, useNullAsDefault: true });
    await seedTask(db, {
      taskId: 'aaa-import-during-backfill', issueNumber: 42, prNumber: 42,
      states: [{ state: 'completed', timestamp: minutesAgo(2) }]
    });
    await catchUp(db);
    await parity(db);
    await parity(db, 'integry/propr', 'ÄNDERUNG');
    assert.ok((await outcomeProjectionStatus(db)).ready);
    const first = (await loadOutcomeSummaries(db, 'integry/propr'))[0];
    const firstPage = await loadOutcomeHistory(db, first.repository, first.entityId, first.revision, { limit: 1 });
    assert.ok(firstPage.nextCursor);
    await assert.rejects(loadOutcomeHistory(db, 'acme/other', first.entityId, first.revision), /NOT_FOUND/);
    await assert.rejects(loadOutcomeHistory(db, 'all', first.entityId, first.revision), /REPOSITORY_REQUIRED/);
    await assert.rejects(loadOutcomeHistory(db, first.repository, first.entityId, first.revision, { cursor: 'junk' }), /INVALID_HISTORY_CURSOR/);
    const other = (await loadOutcomeSummaries(db, 'acme/other'))[0];
    await assert.rejects(loadOutcomeHistory(db, other.repository, other.entityId, other.revision, { cursor: firstPage.nextCursor! }), /INVALID_HISTORY_CURSOR/);
    // Replay unchanged task updates must preserve revision and not double-count.
    await db('tasks').where('task_id', 'reused').update({ task_type: 'pr-comment' });
    await catchUp(db);
    assert.equal((await loadOutcomeSummaries(db, 'integry/propr'))[0].revision, first.revision);
    // Late metadata, restart and deletion all reconcile against the oracle.
    await db('task_history').where({ task_id: 'reused', timestamp: minutesAgo(4) })
      .update({ metadata: JSON.stringify({ notificationRecap: 'Score 7/10 · Late recap' }) });
    await catchUp(db);
    await assert.rejects(loadOutcomeHistory(db, first.repository, first.entityId, first.revision, { cursor: firstPage.nextCursor! }), /HISTORY_STALE/);
    await parity(db);
    await db('task_history').insert({ task_id: 'reused', state: 'processing', timestamp: minutesAgo(1) });
    await catchUp(db);
    await parity(db);
    await db('tasks').where('task_id', 'reused').update({ pr_number: 99, initial_job_data: JSON.stringify({ title: 'Corrected title' }) });
    await catchUp(db);
    await parity(db);
    await db('task_history').where('task_id', 'reused').where('timestamp', '<', minutesAgo(6)).delete();
    await db('tasks').where('task_id', 'final-result').delete();
    await catchUp(db);
    await parity(db);
    await db('tasks').where('task_id', 'reused').update({ repository: 'acme/moved' });
    await catchUp(db);
    await parity(db);
    // A source writer commits in the middle of the projection's read snapshot.
    // The stale calculation must not acknowledge that newer dirty token.
    const otherDb = knex({ client: 'better-sqlite3', connection: { filename: path }, useNullAsDefault: true });
    const writer = await otherDb.client.acquireConnection();
    await db('tasks').where('task_id', 'reused').update({ initial_job_data: JSON.stringify({ title: 'Before concurrent write' }) });
    let raced = false;
    const race = (_rows: unknown, query: { sql: string }) => {
      if (!raced && query.sql.includes('completion_history')) {
        raced = true;
        writer.prepare('UPDATE tasks SET initial_job_data = ? WHERE task_id = ?')
          .run(JSON.stringify({ title: 'Concurrent correction' }), 'reused');
      }
    };
    db.on('query-response', race);
    try { await advanceOutcomeProjection(db); }
    finally { db.off('query-response', race); await otherDb.client.releaseConnection(writer); await otherDb.destroy(); }
    assert.ok(raced);
    assert.ok(await db(T.dirty).where('task_id', 'reused').first(), 'new source token must remain queued');
    await catchUp(db);
    assert.equal((await loadOutcomeSummaries(db, 'all', { search: 'Concurrent correction' })).length, 1);
    await parity(db);
    const countBeforeRollback = await db(T.dirty).count({ count: '*' }).first();
    await assert.rejects(db.transaction(async tx => {
      await tx('task_history').insert({ task_id: 'reused', state: 'completed', timestamp: minutesAgo(-2) });
      throw new Error('rollback source write');
    }), /rollback source write/);
    assert.deepEqual(await db(T.dirty).count({ count: '*' }).first(), countBeforeRollback);
    const routes = createDashboardRoutes({
      db, redisClient: {} as never,
      taskQueue: { isPaused: async () => false, getActiveCount: async () => 0 }
    });
    const summaryResponse = await call(routes.getOutcomes, { view: 'summary', repository: 'integry/propr' });
    assert.equal(summaryResponse.status, 200);
    assert.ok((summaryResponse.body.items as object[]).every(row => !('earlierUpdates' in row)));
    const legacy = await call(routes.getOutcomes, { repository: 'integry/propr' });
    assert.ok((legacy.body.items as object[]).every(row => 'earlierUpdates' in row));
    const scoped = (await loadOutcomeSummaries(db, 'integry/propr'))[0];
    assert.equal((await call(routes.getOutcomes, { view: 'history', repository: 'acme/other', entityId: scoped.entityId, revision: scoped.revision })).status, 404);
    assert.equal((await call(routes.getOutcomes, { view: 'history', repository: scoped.repository, entityId: scoped.entityId, revision: scoped.revision, limit: '51' })).status, 400);
    let projectedNarrativeRead = false;
    const projectedRoutes = createDashboardRoutes({ db, redisClient: {} as never, liveDetails: async () => null,
      taskQueue: { isPaused: async () => false, getActiveCount: async () => 0 },
      completedRows: Object.assign(async () => { throw new Error('Narrative used the legacy completion reader'); }, {
        summary: async (repository: string, options?: { limit?: number; search?: string }) => {
          projectedNarrativeRead = true;
          return loadOutcomeSummaries(db, repository, options);
        },
      }),
    });
    await call(projectedRoutes.getNarrative);
    assert.ok(projectedNarrativeRead);
    // Read traces prove normal serving cannot hydrate source payloads.
    const statements: string[] = [];
    const trace = (query: { sql: string }) => statements.push(query.sql);
    db.on('query', trace);
    await loadOutcomeSummaries(db, 'all');
    await loadOutcomeHistory(db, scoped.repository, scoped.entityId, scoped.revision);
    db.off('query', trace);
    assert.ok(statements.every(sql => !/\b(tasks|task_history)\b/.test(sql)));
    // Rebuild preserves source changes and incomplete state remains unavailable.
    await rebuildOutcomeProjection(db);
    await assert.rejects(loadOutcomeSummaries(db, 'all'), /NOT_READY/);
    await seedTask(db, { taskId: 'new-during-rebuild', states: [{ state: 'completed', timestamp: minutesAgo(0) }] });
    await catchUp(db);
    await parity(db);
    // Separate background worker + concurrent writer, including process restart.
    let rejectedPublication = false;
    const published: string[] = [];
    setOutcomeActivityPublisher(async repository => {
      assert.ok((await outcomeProjectionStatus(db)).ready, 'publication must follow readiness commit');
      if (!rejectedPublication) { rejectedPublication = true; throw new Error('temporary delivery failure'); }
      published.push(repository);
    });
    service = await startDashboardReadService(db);
    const sharedSummary = service.load.summary!('all');
    assert.equal(service.load.summary!('all'), sharedSummary);
    await sharedSummary;
    peer = await startDashboardReadService(db);
    await db('tasks').where('task_id', 'reused').update({ initial_job_data: JSON.stringify({ title: 'Worker catch-up' }) });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !(await loadOutcomeSummaries(db, 'all', { search: 'Worker catch-up' })).length) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal((await loadOutcomeSummaries(db, 'all', { search: 'Worker catch-up' })).length, 1);
    await parity(db);
    while (Date.now() < deadline && await db(T.outbox).first()) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(rejectedPublication && published.length > 0);
    assert.equal(await db(T.outbox).first(), undefined, 'successful retry must acknowledge durable outbox');
    await peer.close(); peer = undefined;
    await service.close(); service = undefined;
    await db('task_history').insert({ task_id: 'reused', state: 'completed', timestamp: minutesAgo(-1) });
    service = await startDashboardReadService(db);
    while (Date.now() < deadline && Number((await db(T.dirty).count({ count: '*' }).first())?.count)) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await parity(db);
    console.log('PASS: parity, run metadata, replay, identity, retention, scoped cursors, routes, read trace, backfill and worker restart');
  } finally { await peer?.close(); await service?.close(); await db.destroy(); await rm(directory, { recursive: true, force: true }); }
}

const p95 = (values: number[]): number | null => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1] : null;
async function benchmark(db: Knex, repository: string, search: string | undefined, projected: boolean, worker?: DashboardReadService) {
  const { toOutcomeItem, toOutcomeUpdate } = await import('../packages/api/routes/dashboardRoutes.js');
  const samples = Math.max(30, Number(option('samples')) || 30);
  const durations: number[] = [], histories: number[] = [], concurrent: number[] = [];
  for (let iteration = 0; iteration <= samples; iteration++) {
    const start = performance.now();
    const probe = new Promise<number>(resolve => setTimeout(() => resolve(performance.now() - start), 10));
    const rows: OutcomeReadRow[] = projected ? await loadOutcomeSummaries(db, repository, { limit: 50, search })
      : await (worker ? worker.load(repository, { limit: 50, search }) : loadCompletedRows(db, repository, { limit: 50, search }));
    const milliseconds = performance.now() - start;
    if (iteration) durations.push(milliseconds);
    const entity = rows.find(row => 'entityId' in row);
    const historyStart = performance.now();
    const page = entity?.entityId && entity.revision
      ? await loadOutcomeHistory(db, entity.repository, entity.entityId, entity.revision) : null;
    const historyMs = performance.now() - historyStart;
    const concurrentStart = performance.now();
    if (projected) await Promise.all([loadOutcomeSummaries(db, repository, { limit: 50 }), loadOutcomeSummaries(db, repository, { limit: 8 })]);
    const concurrentMs = performance.now() - concurrentStart;
    if (iteration && page) histories.push(historyMs);
    if (iteration && projected) concurrent.push(concurrentMs);
    console.log(JSON.stringify({
      iteration, firstRead: iteration === 0, milliseconds, entities: rows.length,
      foregroundProbeMilliseconds: await probe,
      payloadBytes: Buffer.byteLength(JSON.stringify({ repository, limit: 50, search: search ?? '', items: rows.map(toOutcomeItem) })), historyMs: page ? historyMs : null,
      historyBytes: page && entity ? Buffer.byteLength(JSON.stringify({ repository: entity.repository, entityId: entity.entityId, revision: entity.revision, items: page.updates.map(toOutcomeUpdate), nextCursor: page.nextCursor })) : null,
      concurrentFeedNarrativeMs: projected ? concurrentMs : null
    }));
  }
  console.log(JSON.stringify({
    samples, warmP95Ms: p95(durations), historyP95Ms: p95(histories), concurrentP95Ms: p95(concurrent),
    measurement: 'Local DB reader wall time; excludes HTTP queueing, network, transfer and rendering. First read is reported separately; OS cache is not evicted.'
  }));
  if (projected) for (const sql of [
    `SELECT payload FROM ${T.entities} ORDER BY sort_at DESC, task_id DESC, completion_id DESC, entity_id LIMIT 50`,
    `SELECT payload FROM ${T.entities} WHERE repository = 'integry/propr' ORDER BY sort_at DESC, task_id DESC, completion_id DESC, entity_id LIMIT 50`,
    `SELECT payload FROM ${T.runs} WHERE entity_id = 'example' AND (sort_at, task_id, completion_id) < ('2026', 'task', 100) ORDER BY sort_at DESC, task_id DESC, completion_id DESC LIMIT 21`,
  ]) console.log(await db.raw(`EXPLAIN QUERY PLAN ${sql}`));
}

async function syntheticBenchmark() {
  const { createDashboardTestDatabase } = await import('../packages/api/test/dashboardTestHarness.js');
  for (const depth of [20, 200]) {
    const db = await createDashboardTestDatabase();
    try {
      // Production already has a task_id/timestamp source index.
      await db.raw('CREATE INDEX fixture_history_task ON task_history(task_id, timestamp, history_id)');
      for (let entity = 0; entity < 50; entity++) {
        const task = `task-${String(entity).padStart(3, '0')}`;
        await db('tasks').insert({
          task_id: task, repository: 'integry/propr', issue_number: entity,
          task_type: 'review', created_at: '2026-01-01T00:00:00.000Z',
          initial_job_data: JSON.stringify({ title: `Review: Improve workflow ${entity}`, unused: 'x'.repeat(65536) })
        });
        const rows = [];
        for (let run = 0; run < depth; run++) for (const [offset, state] of ['processing', 'completed'].entries()) {
          rows.push({
            task_id: task, state, timestamp: new Date(Date.UTC(2026, 0, 1) + run * 60000 + offset * 1000 + entity).toISOString(),
            metadata: state === 'completed' ? JSON.stringify({ notificationRecap: 'Score 8/10 · Validated the workflow' }) : '{}'
          });
        }
        for (let index = 0; index < rows.length; index += 100) await db('task_history').insert(rows.slice(index, index + 100));
      }
      const start = performance.now();
      await installOutcomeProjection(db); await catchUp(db);
      console.log(JSON.stringify({ depth, runs: depth * 50, backfillMs: performance.now() - start }));
      await benchmark(db, 'all', undefined, true);
      const commits: number[] = [], projections: number[] = [];
      for (let index = 0; index < 30; index++) {
        const write = performance.now();
        await db('task_history').insert({
          task_id: 'task-001', state: 'completed',
          timestamp: new Date(Date.UTC(2026, 8, 29) + index * 1000).toISOString(), metadata: '{}'
        });
        commits.push(performance.now() - write);
        const projection = performance.now(); await catchUp(db); projections.push(performance.now() - projection);
      }
      console.log(JSON.stringify({ depth, samples: 30, sourceCommitP95Ms: p95(commits), projectionApplyP95Ms: p95(projections) }));
      await parity(db);
    } finally { await db.destroy(); }
  }
}

async function browserSelfTest() {
  // Optional dev-only dependency: a non-literal specifier keeps tsc from requiring its types in builds that don't install it.
  const playwrightModule = '@playwright/test';
  const { chromium, expect } = await import(playwrightModule);
  const fixturePath = '../propr-ui/e2e/dashboard-sections.fixture.js';
  const { fixture, outcomes, minutesAgo } = await import(fixturePath);
  const capture = process.argv.includes('--capture');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: option('url') ?? 'http://127.0.0.1:4173' });
  const page = await context.newPage();

  let socket: any;
  let connections = 0;
  await page.routeWebSocket('**/socket.io/**', (ws: any) => {
    socket = ws; connections++;
    ws.send('0' + JSON.stringify({ sid: 'fixture-' + connections, upgrades: [], pingInterval: 100000, pingTimeout: 100000, maxPayload: 1000000 }));
    ws.onMessage((message: unknown) => { if (String(message).startsWith('40')) ws.send('40' + JSON.stringify({ sid: 'fixture-' + connections })); });
  });
  await fixture(page, { width: 1440, height: 1000 }, [], []);
  await page.route('**/api/auth/demo-mode', (route: any) => route.fulfill({ json: { demoMode: false } }));
  let revision = 'r1';
  let count = 24;
  let histories = 0;
  let summaries = 0;
  let fail = true;
  let stale = false;
  let hold = false;
  let releaseScope: () => void;
  const scopeGate = new Promise<void>(resolve => { releaseScope = resolve; });
  let release: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const summary = () => ({ ...outcomes[1], id: 'latest-' + revision, entityId: 'entity-one', revision, eventCount: count, title: 'Improve dashboard outcomes', detail: 'Completed the latest follow-up.' });
  const historyItems = (start: number, end: number) => Array.from({ length: end - start }, (_, i) => ({ ...outcomes[0], id: `${revision}-earlier-${i + start}`, taskId: `history-${i + start}`, title: 'Improve dashboard outcomes', detail: `Validated workflow ${i + start + 1}`, occurredAt: minutesAgo(i + start + 10) }));
  await page.route('**/api/dashboard/outcomes?**', async (route: any) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get('view') !== 'history') {
      summaries++;
      assertAccept(route.request().headers());
      const items = params.get('repository') === 'example/docs'
        ? [{ ...summary(), entityId: 'other-entity', repository: 'example/docs', title: 'Other repository outcome', eventCount: 2 }]
        : [summary()];
      await route.fulfill({ json: { repository: params.get('repository'), limit: 50, items } });
      return;
    }
    histories++;
    if (hold) await scopeGate;
    if (stale) { stale = false; revision = 'r4'; count = 27; await route.fulfill({ status: 409, json: { code: 'OUTCOME_HISTORY_STALE' } }); return; }
    if (histories === 1) await gate;
    if (fail) { fail = false; await route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } }); return; }
    if (params.get('revision') !== revision) { await route.fulfill({ status: 409, json: { code: 'OUTCOME_HISTORY_STALE' } }); return; }
    if (params.get('entityId') === 'other-entity') { await route.fulfill({ json: { items: [], nextCursor: null } }); return; }
    const more = Boolean(params.get('cursor'));
    await route.fulfill({ json: { items: historyItems(more ? 20 : 0, more ? count - 1 : 20), nextCursor: more ? null : 'page-two' } });
  });
  function assertAccept(headers: Record<string, string>) { if (!headers.accept?.includes('outcome-summaries')) throw new Error('Missing summary opt-in'); }
  try {
    await page.goto('/');
    const section = page.getByTestId('completed-section');
    await expect(section.getByRole('button', { name: '23 earlier updates', exact: true })).toBeVisible();
    await page.waitForTimeout(300);
    if (histories !== 0) throw new Error('Collapsed history read');
    console.log({ startupSummaries: summaries, histories, connections });
    await section.getByRole('button', { name: '23 earlier updates', exact: true }).click();
    await expect(section.getByRole('status')).toHaveText('Loading earlier updates…');
    if (capture) await mkdir('.propr/previews', { recursive: true });
    if (capture) await section.screenshot({ path: '.propr/previews/outcome-history-loading.png' });
    release!();
    await expect(section.getByRole('alert')).toContainText('Unable to load earlier updates');
    await section.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(section.getByRole('button', { name: 'Load more updates' })).toBeVisible();
    await expect(section.locator('li ul > li').filter({ has: page.locator('a') })).toHaveCount(20);
    if (capture) await section.screenshot({ path: '.propr/previews/outcome-history-expanded.png' });
    await section.getByRole('button', { name: 'Load more updates' }).click();
    await expect(section.locator('li ul > li').filter({ has: page.locator('a') })).toHaveCount(23);
    const beforeReopen = histories;
    await section.getByRole('button', { name: 'Hide 23 earlier updates', exact: true }).click();
    await section.getByRole('button', { name: '23 earlier updates', exact: true }).click();
    await page.waitForTimeout(100);
    if (histories !== beforeReopen) throw new Error('Reopening unchanged entity fetched again');
    revision = 'r2'; count = 25;
    socket!.send('42' + JSON.stringify(['activity:update', { eventType: 'activity:update', domain: 'task', change: 'completed', entityId: 'dashboard-outcomes', repository: 'example/workspace', terminal: true, occurredAt: new Date().toISOString() }]));
    await expect(section.getByRole('button', { name: 'Hide 24 earlier updates', exact: true })).toBeVisible();
    await expect(section.locator('li ul > li').filter({ has: page.locator('a') })).toHaveCount(20);
    if (histories !== beforeReopen + 1) throw new Error('Expanded revision did not reload exactly once');
    await section.getByRole('button', { name: 'Hide 24 earlier updates', exact: true }).click();
    revision = 'r3'; count = 26;
    const beforeCollapsed = histories;
    socket!.send('42' + JSON.stringify(['activity:update', { eventType: 'activity:update', domain: 'task', change: 'completed', entityId: 'dashboard-outcomes', repository: 'example/workspace', terminal: true, occurredAt: new Date().toISOString() }]));
    await expect(section.getByRole('button', { name: '25 earlier updates', exact: true })).toBeVisible();
    if (histories !== beforeCollapsed) throw new Error('Collapsed revision fetched history');
    const beforeReconnect = summaries;
    socket!.close();
    await expect.poll(() => connections).toBeGreaterThan(1);
    await expect.poll(() => summaries).toBeGreaterThan(beforeReconnect);
    if (histories !== beforeCollapsed) throw new Error('Reconnect fetched collapsed history');
    stale = true;
    await section.getByRole('button', { name: '25 earlier updates', exact: true }).click();
    await expect(section.getByRole('button', { name: 'Hide 26 earlier updates', exact: true })).toBeVisible();
    await expect(section.locator('li ul > li').filter({ has: page.locator('a') })).toHaveCount(20);
    hold = true;
    const beforeScope = histories;
    await section.getByRole('button', { name: 'Load more updates' }).click();
    await expect.poll(() => histories).toBe(beforeScope + 1);
    await page.evaluate("window.history.pushState({}, '', '/?repository=example%2Fdocs'); window.dispatchEvent(new PopStateEvent('popstate'));");
    await expect(section.getByRole('link', { name: /Other repository outcome/ })).toBeVisible();
    releaseScope!();
    await page.waitForTimeout(100);
    await expect(section.getByText('Validated workflow 21', { exact: true })).toHaveCount(0);
    await section.getByRole('button', { name: '1 earlier update', exact: true }).click();
    await expect(section.getByText('No earlier updates', { exact: true })).toBeVisible();
    console.log('PASS browser: expansion-only reads, loading, retry, pagination, reopen reuse, revision replacement, collapsed push, reconnect, stale-cursor recovery and scope changes');
    if (capture) await writeFile('.propr/previews/manifest.json', JSON.stringify({ previews: [{ path: '.propr/previews/outcome-history-loading.png', title: 'Earlier updates loading', description: 'Expanded entity loads its history without blocking the completed feed.' }, { path: '.propr/previews/outcome-history-expanded.png', title: 'Paginated earlier updates', description: 'The first page of earlier updates with a local Load more updates control.' }], toolSuggestions: [] }, null, 2));
  } finally { await browser.close(); }

}

const option = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
if (process.argv.includes('--self-test')) {
  await selfTest();
} else if (process.argv.includes('--browser-test')) {
  await browserSelfTest();
} else if (process.argv.includes('--synthetic')) {
  await syntheticBenchmark();
} else {
  const filename = option('database');
  if (!filename) throw new Error('Pass --database=/path/to/offline-snapshot.sqlite or --self-test');
  await access(filename);
  const repository = option('repository') ?? 'all';
  const search = option('search');
  const mutable = process.argv.includes('--rebuild');
  const db = knex({ client: 'better-sqlite3', connection: { filename, options: { readonly: !mutable } }, useNullAsDefault: true });
  let worker: DashboardReadService | undefined;
  try {
    const enqueueOnly = process.argv.includes('--enqueue-only');
    if (mutable) { await rebuildOutcomeProjection(db); if (!enqueueOnly) await catchUp(db); }
    if (process.argv.includes('--status')) console.log(await outcomeProjectionStatus(db));
    if (!enqueueOnly && !process.argv.includes('--status')) {
      if (process.argv.includes('--worker')) worker = await startDashboardReadService(db, { projection: false });
      const projected = process.argv.includes('--projected');
      await benchmark(db, repository, search, projected, worker);
      if (process.argv.includes('--verify')) { await parity(db, repository, search); console.log('Snapshot parity passed'); }
    }
  } finally { await worker?.close(); await db.destroy(); }
}
