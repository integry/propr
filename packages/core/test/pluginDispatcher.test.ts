import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PLUGIN_DELIVERY_RETRY_DELAYS_MS, type PluginHandlerRun } from '@propr/shared';

/**
 * Plugin event subscriptions, end to end against SQLite: the fixture plugin
 * `fixture-events` is installed through the real plugin store and its
 * handlers run through the real runner. Journal appends publish no activity
 * event (no Redis in tests).
 */
await mock.module('../src/utils/eventPublisher.js', { namedExports: { getEventPublisher: () => ({ publishActivity: async () => true }) } });
const { pluginHandlerFixture, EVENTS_FIXTURE_ID: ID } = await import('./helpers/pluginHandlerFixture.js');
const { PluginDispatcher } = await import('../src/plugins/pluginDispatcher.js');
const { listPluginActivity, prunePluginDeliveries, resumePluginDeliveries, retryPluginDelivery } = await import('../src/plugins/pluginDeliveries.js');
const { appendRepositoryEvent, pruneRepositoryEvents } = await import('../src/services/repositoryEventJournal.js');
const { recordPullRequestOutcome } = await import('../src/services/reviewScoreStore.js');
const { up: pullRequestStateMigration } = await import('../src/db/migrations/20260829010000_add_notification_pull_request_state.js');
const { up: reviewScoresMigration } = await import('../src/db/migrations/20261006000000_create_review_scores.js');

type Fixture = Awaited<ReturnType<typeof pluginHandlerFixture>>;
type Seen = { id: string; seq: number; repository: string; attempt: number }[];
const ALLOWED = 'owner/allowed';
const SECOND = 'owner/second';

async function setup(t: TestContext) {
  const f = await pluginHandlerFixture(t, { pluginId: ID, repositories: [ALLOWED, SECOND] });
  const clock = { now: 1_700_000_000_000 };
  const notices: unknown[] = [];
  const dispatcher = (extra: Partial<ConstructorParameters<typeof PluginDispatcher>[0]> = {}) => new PluginDispatcher({
    ...f.options, now: () => clock.now, timeoutMs: 200, pauseAfterFailures: 100, notify: async notice => { notices.push(notice); }, ...extra,
  });
  const append = async (repository: string, domain: 'pull_request' | 'task', type: string, entityId: number | string, payload: Record<string, unknown> = {}) => {
    const result = await appendRepositoryEvent(f.database, { repository, domain, type, entityId, ...(domain === 'pull_request' ? { prNumber: Number(entityId) } : {}), payload }, { publish: false });
    assert.equal(result.status, 'appended');
    return (result as { seq: number }).seq;
  };
  const state = async <T>(key: string) => {
    const row = await f.database('plugin_state').where({ plugin_id: ID, state_key: key }).first() as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  };
  const setState = (key: string, value: unknown) => f.database('plugin_state').insert({ plugin_id: ID, state_key: key, value: JSON.stringify(value), bytes: 8, updated_at: 0 }).onConflict(['plugin_id', 'state_key']).merge();
  const seen = async () => (await state<Seen>('seen')) ?? [];
  const deliveries = async () => (await listPluginActivity(f.database, ID)).deliveries;
  return { f, clock, notices, dispatcher, append, seen, setState, deliveries };
}

/** Passes until one makes no attempt. */
async function drain(dispatcher: InstanceType<typeof PluginDispatcher>) {
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const { attempts } = await dispatcher.pass();
    if (!attempts) return total;
    total += attempts;
  }
  throw new Error('the dispatcher did not settle');
}

test('a subscribed handler runs once per matching event, in order per repository, with filters and the repository limit honoured', async t => {
  const s = await setup(t);
  const expected: { seq: number; repository: string }[] = [];
  const a1 = await s.append(ALLOWED, 'pull_request', 'opened', 1, { draft: false }); expected.push({ seq: a1, repository: ALLOWED });
  const b1 = await s.append(SECOND, 'pull_request', 'opened', 2); expected.push({ seq: b1, repository: SECOND });
  const a2 = await s.append(ALLOWED, 'task', 'completed', 'task-1', { kind: 'implementation', secretish: 'payload-body-sentinel' }); expected.push({ seq: a2, repository: ALLOWED });
  await s.append(ALLOWED, 'task', 'completed', 'task-2', { kind: 'automation' }); // filtered out by payload.kind
  await s.append('owner/other', 'pull_request', 'opened', 3); // outside the repository limit
  await s.append(ALLOWED, 'pull_request', 'head_changed', 1); // not subscribed
  const a3 = await s.append('Owner/Allowed', 'pull_request', 'opened', 4); expected.push({ seq: a3, repository: 'Owner/Allowed' });

  const dispatcher = s.dispatcher();
  assert.equal(await drain(dispatcher), 4);
  const seen = await s.seen();
  assert.deepEqual(seen.map(e => e.seq).sort((x, y) => x - y), expected.map(e => e.seq).sort((x, y) => x - y), 'each matching event once');
  for (const repository of [ALLOWED, SECOND]) {
    const order = seen.filter(e => e.repository === repository).map(e => e.seq);
    assert.deepEqual(order, [...order].sort((x, y) => x - y), `events of ${repository} in order`);
  }
  assert.deepEqual(seen.map(e => e.id).sort(), expected.map(e => `evt-${e.seq}-record`).sort(), 'stable delivery ids');
  assert.ok(seen.every(e => e.attempt === 1));

  // A second pass and a fresh dispatcher deliver nothing again.
  assert.equal(await drain(dispatcher), 0);
  assert.equal(await drain(s.dispatcher()), 0);

  const records = await s.deliveries();
  assert.equal(records.length, 4);
  for (const record of records) {
    assert.equal(record.status, 'succeeded'); assert.equal(record.kind, 'event'); assert.equal(record.handler, 'record'); assert.equal(record.attempt, 1);
    assert.equal(typeof record.durationMs, 'number'); assert.match(record.logs[0].message, /^received /);
  }
  // Only the event id and type are stored: no payload.
  const raw = JSON.stringify(await s.f.database('plugin_deliveries').select());
  assert.equal(raw.includes('payload-body-sentinel'), false);
  assert.equal(raw.includes('implementation'), false);
});

test('installing or enabling starts at the end of the journal: history is not replayed', async t => {
  const s = await setup(t);
  await s.append(ALLOWED, 'pull_request', 'opened', 1);
  await drain(s.dispatcher());
  assert.equal((await s.seen()).length, 1);
  await s.f.store.setEnabled('1', ID, false);
  await s.append(ALLOWED, 'pull_request', 'opened', 2); // while disabled
  assert.equal(await drain(s.dispatcher()), 0);
  await s.f.store.setEnabled('1', ID, true);
  const after = await s.append(ALLOWED, 'pull_request', 'opened', 3);
  await drain(s.dispatcher());
  assert.deepEqual((await s.seen()).map(e => e.seq).slice(1), [after]);

  await s.f.store.uninstall('1', ID, ID);
  assert.equal(await s.f.database('plugin_deliveries').where({ plugin_id: ID }).first(), undefined, 'uninstall deletes the records');
  await s.f.store.install('1', ID); await s.f.store.setRepositories('1', ID, [ALLOWED]); await s.f.store.setEnabled('1', ID, true);
  const fresh = await s.append(ALLOWED, 'pull_request', 'opened', 5);
  await drain(s.dispatcher());
  assert.deepEqual((await s.seen()).map(e => e.seq), [fresh], 'a reinstall sees only new events');
});

test('a failing handler is retried on the schedule, holds back its repository only, and is then marked failed', async t => {
  const s = await setup(t);
  await s.setState('fail', 1000);
  const failing = await s.append(ALLOWED, 'task', 'failed', 'task-1');
  const behind = await s.append(ALLOWED, 'pull_request', 'opened', 1);
  const elsewhere = await s.append(SECOND, 'pull_request', 'opened', 2);
  const dispatcher = s.dispatcher();
  const start = s.clock.now;

  await drain(dispatcher);
  let seen = await s.seen();
  assert.deepEqual(seen.map(e => e.seq), [failing, elsewhere], 'the other repository is not held back; the later event of the same one is');
  const attemptTimes: number[] = [start];
  for (const [index, delay] of PLUGIN_DELIVERY_RETRY_DELAYS_MS.entries()) {
    const [record] = (await s.deliveries()).filter(d => d.handler === 'flaky');
    assert.equal(record.status, 'retrying'); assert.equal(record.attempt, index + 1);
    assert.equal(record.nextAttemptAt, attemptTimes.at(-1)! + delay, `retry ${index + 1} after ${delay / 60_000} min`);
    assert.match(record.error!, /flaky failure/);
    s.clock.now = record.nextAttemptAt! - 1;
    assert.equal(await drain(dispatcher), 0, 'nothing runs before the retry is due');
    s.clock.now = record.nextAttemptAt!;
    attemptTimes.push(s.clock.now);
    await drain(dispatcher);
  }
  const [failed] = (await s.deliveries()).filter(d => d.handler === 'flaky');
  assert.equal(failed.status, 'failed'); assert.equal(failed.attempt, PLUGIN_DELIVERY_RETRY_DELAYS_MS.length + 1); assert.equal(failed.nextAttemptAt, null);
  assert.equal(failed.logs[0].message, 'failing on purpose');
  seen = await s.seen();
  assert.deepEqual(seen.filter(e => e.seq === failing).map(e => e.attempt), [1, 2, 3, 4, 5]);
  assert.ok(seen.filter(e => e.seq === failing).every(e => e.id === `evt-${failing}-flaky`), 'the delivery id is the same on every attempt');
  assert.deepEqual(seen.at(-1), { id: `evt-${behind}-record`, seq: behind, repository: ALLOWED, attempt: 1 }, 'then the next event follows');

  // An administrator retries the failed delivery: one more attempt, same id.
  await s.setState('fail', 0);
  const retried = await retryPluginDelivery(s.f.database, ID, String(failed.id), '1', s.clock.now);
  assert.equal(retried.status, 'pending');
  await assert.rejects(retryPluginDelivery(s.f.database, ID, String(failed.id), '1'), /Only a failed event delivery/);
  await drain(dispatcher);
  const [done] = (await s.deliveries()).filter(d => d.handler === 'flaky');
  assert.equal(done.status, 'succeeded'); assert.equal(done.attempt, 6);
  assert.deepEqual((await s.seen()).at(-1), { id: `evt-${failing}-flaky`, seq: failing, repository: ALLOWED, attempt: 6 });
});

test('the cursor survives a worker restart; a crashed attempt is delivered again with the same id', async t => {
  const s = await setup(t);
  const first = await s.append(ALLOWED, 'pull_request', 'opened', 1);
  const a = s.dispatcher({ owner: 'worker-a' });
  await drain(a);
  await a.stop();
  const second = await s.append(ALLOWED, 'pull_request', 'opened', 2);
  const third = await s.append(SECOND, 'pull_request', 'opened', 3);
  const b = s.dispatcher({ owner: 'worker-b' });
  await drain(b);
  await b.stop();
  assert.deepEqual((await s.seen()).map(e => e.seq), [first, second, third], 'nothing lost, nothing repeated');

  // Worker C dies while its handler runs: the record stays `running` and C keeps the lease until it expires.
  const crashed = await s.append(ALLOWED, 'pull_request', 'opened', 4);
  let release!: (run: PluginHandlerRun) => void;
  const hung = new Promise<PluginHandlerRun>(resolve => { release = resolve; });
  const c = s.dispatcher({ owner: 'worker-c', leaseMs: 60_000, run: () => hung });
  const cPass = c.pass();
  for (let i = 0; i < 50 && (await s.deliveries())[0]?.status !== 'running'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal((await s.deliveries())[0].status, 'running');
  const d = s.dispatcher({ owner: 'worker-d' });
  assert.equal(await drain(d), 0, 'the lease holder is not displaced while its lease lasts');
  s.clock.now += 60_001;
  assert.equal(await drain(d), 1);
  assert.deepEqual((await s.seen()).at(-1), { id: `evt-${crashed}-record`, seq: crashed, repository: ALLOWED, attempt: 2 });
  // The stale worker finishes late: its outcome is not recorded over the lease holder's.
  release({ outcome: 'failed', timedOut: false, durationMs: 1, error: 'late stale outcome', logs: [] });
  await cPass;
  const [record] = await s.deliveries();
  assert.equal(record.status, 'succeeded'); assert.equal(record.error, null);
});

test('two dispatchers running at once deliver each event once (lease)', async t => {
  const s = await setup(t);
  const a = s.dispatcher({ owner: 'worker-a' });
  const b = s.dispatcher({ owner: 'worker-b' });
  const appended: number[] = [];
  const holders = new Set<string>();
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 3; i++) appended.push(await s.append(i % 2 ? SECOND : ALLOWED, 'pull_request', 'opened', round * 10 + i));
    const [ra, rb] = await Promise.all([a.pass(), b.pass()]);
    assert.ok(!(ra.leased.includes(ID) && rb.leased.includes(ID)), 'only one holds the lease');
    if (ra.leased.includes(ID)) holders.add('a'); if (rb.leased.includes(ID)) holders.add('b');
  }
  await Promise.all([drain(a), drain(b)]);
  const seen = (await s.seen()).map(e => e.seq);
  assert.deepEqual([...seen].sort((x, y) => x - y), appended);
  assert.equal(new Set(seen).size, seen.length, 'no event delivered twice');
  assert.equal(holders.size, 1, 'the lease stays with one dispatcher while it lasts');
  // Once the holder stops, the other takes over.
  const [holder, other] = holders.has('a') ? [a, b] : [b, a];
  await holder.stop();
  const later = await s.append(ALLOWED, 'pull_request', 'opened', 99);
  assert.equal(await drain(other), 1);
  assert.equal((await s.seen()).at(-1)!.seq, later);
  await other.stop();
});

test('repeated failures make the plugin Degraded with one notification, then pause it until Resume', async t => {
  const s = await setup(t);
  await s.setState('fail', 1000);
  const dispatcher = s.dispatcher({ pauseAfterFailures: 5, retryDelaysMs: [] });
  for (let i = 0; i < 3; i++) await s.append(ALLOWED, 'task', 'failed', `task-${i}`);
  await drain(dispatcher);
  let activity = await listPluginActivity(s.f.database, ID);
  assert.equal(activity.health.state, 'degraded'); assert.equal(activity.health.consecutiveFailures, 3);
  assert.match(activity.health.lastError!, /flaky failure/);
  assert.equal(s.notices.length, 1);
  for (let i = 3; i < 8; i++) await s.append(ALLOWED, 'task', 'failed', `task-${i}`);
  await drain(dispatcher);
  activity = await listPluginActivity(s.f.database, ID);
  assert.equal(activity.health.state, 'paused'); assert.equal(activity.health.consecutiveFailures, 5);
  assert.equal(activity.deliveries.filter(d => d.status === 'failed').length, 5, 'deliveries stop at the pause');
  assert.equal(s.notices.length, 1, 'one notification while it stays Degraded');
  assert.deepEqual(s.notices[0], { pluginId: ID, installedAt: (await s.f.store.get('1', ID)).installation!.installedAt, degradedAt: s.clock.now, consecutiveFailures: 3, lastError: activity.deliveries.at(-1)!.error });
  assert.equal(await drain(dispatcher), 0, 'paused: nothing is delivered');

  await s.setState('fail', 0);
  const health = await resumePluginDeliveries(s.f.database, ID, '1', { now: s.clock.now });
  assert.equal(health.state, 'healthy'); assert.equal(health.consecutiveFailures, 0); assert.match(health.lastError!, /flaky failure/);
  await assert.rejects(resumePluginDeliveries(s.f.database, ID, '1'), /not paused/);
  assert.equal(await drain(dispatcher), 3, 'the rest is delivered after Resume');
  activity = await listPluginActivity(s.f.database, ID);
  assert.equal(activity.health.state, 'healthy');
  assert.equal(activity.deliveries.filter(d => d.status === 'succeeded').length, 3);
});

test('events that left the journal before delivery are skipped with a recorded gap; records are pruned after retention', async t => {
  const s = await setup(t);
  await s.f.store.setEnabled('1', ID, false);
  await s.f.store.setEnabled('1', ID, true);
  const dispatcher = s.dispatcher();
  await drain(dispatcher); // creates the cursors once events exist
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const pruned = await appendRepositoryEvent(s.f.database, { repository: ALLOWED, domain: 'pull_request', type: 'opened', entityId: 1, prNumber: 1, occurredAt: old }, { publish: false });
  const kept = await s.append(ALLOWED, 'pull_request', 'opened', 2);
  await pruneRepositoryEvents(s.f.database);
  await drain(dispatcher);
  assert.deepEqual((await s.seen()).map(e => e.seq), [kept]);
  const gap = (await s.deliveries()).find(d => d.kind === 'gap')!;
  assert.equal(gap.status, 'skipped'); assert.equal(gap.eventSeq, (pruned as { seq: number }).seq);
  assert.match(gap.error!, /left the journal/);
  await drain(dispatcher);
  assert.equal((await s.deliveries()).filter(d => d.kind === 'gap').length, 1, 'a gap is recorded once');

  assert.equal(await prunePluginDeliveries(s.f.database, { now: () => s.clock.now + 13 * 24 * 60 * 60 * 1000 }), 0, 'kept within the retention period');
  assert.equal(await prunePluginDeliveries(s.f.database, { now: () => s.clock.now + 15 * 24 * 60 * 60 * 1000 }), 2);
  assert.deepEqual(await s.deliveries(), []);
});

test('a handler on pull_request.merged that throws, hangs or exhausts its retries never affects the merge step', async t => {
  const s = await setup(t);
  await pullRequestStateMigration(s.f.database); await reviewScoresMigration(s.f.database);
  // The handler's time limit is far longer than a merge step may take, so a merge that waited for it would show.
  const dispatcher = s.dispatcher({ timeoutMs: 1_500, retryDelaysMs: [1, 1], pollMs: 20 });
  dispatcher.start();
  t.after(() => dispatcher.stop());
  let pr = 100;
  /** The real merge step: records the outcome and journals `pull_request.merged`. */
  const merge = async () => {
    const started = performance.now();
    pr += 1;
    await recordPullRequestOutcome(s.f.database, { repository: ALLOWED, prNumber: pr, action: 'closed', merged: true, mergedAt: new Date().toISOString() } as Parameters<typeof recordPullRequestOutcome>[1]);
    const row = await s.f.database('notification_pull_request_state').where({ repository: ALLOWED, pr_number: pr }).first();
    return { ms: performance.now() - started, outcome: row?.outcome };
  };
  const settle = async (seq: number) => {
    for (let i = 0; i < 1000; i++) {
      const record = (await s.deliveries()).find(d => d.eventSeq === seq && d.handler === 'onMerged');
      if (record && (record.status === 'failed' || record.status === 'succeeded')) return record;
      s.clock.now += 10;
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error(`delivery of ${seq} did not settle`);
  };
  const lastSeq = async () => Number((await s.f.database('repository_events').max({ seq: 'seq' }).first())!.seq);

  for (const mode of ['throw', 'hang'] as const) {
    await s.setState('mode', mode);
    const result = await merge();
    assert.equal(result.outcome, 'merged', `${mode}: the merge is recorded`);
    assert.ok(result.ms < 750, `${mode}: the merge step does not wait for the handler (${Math.round(result.ms)} ms)`);
    const record = await settle(await lastSeq());
    assert.equal(record.status, 'failed', `${mode}: retries exhausted`);
    assert.equal(record.attempt, 3);
    assert.equal(record.timedOut, mode === 'hang');
    assert.match(record.error!, mode === 'hang' ? /did not finish within/ : /merge handler failure/);
  }
  // A merge while the hanging handler runs is not delayed either.
  await s.setState('mode', 'hang');
  const pending = merge();
  const concurrent = await merge();
  assert.equal(concurrent.outcome, 'merged');
  assert.equal((await pending).outcome, 'merged');
  assert.ok(concurrent.ms < 750);
});
