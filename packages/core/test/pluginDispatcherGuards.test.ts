import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginHandlerRun } from '@propr/shared';

/**
 * What stops a delivery once it has started: a pause reached mid-pass, an
 * administrator's change to the installation while a handler runs, a manual
 * retry interrupted by a crash, and journal retention emptying a repository.
 */
await mock.module('../src/utils/eventPublisher.js', { namedExports: { getEventPublisher: () => ({ publishActivity: async () => true }) } });
const { EVENTS_FIXTURE_ID: ID } = await import('./helpers/pluginHandlerFixture.js');
const { ALLOWED, SECOND, drain, setup, until } = await import('./helpers/pluginDispatcherFixture.js');
const { listPluginActivity, prunePluginDeliveries, resumePluginDeliveries, retryPluginDelivery } = await import('../src/plugins/pluginDeliveries.js');
const { runPluginHandler } = await import('../src/plugins/pluginHandlerRunner.js');
const { pruneRepositoryEvents } = await import('../src/services/repositoryEventJournal.js');

const OLD = () => new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
type Setup = Awaited<ReturnType<typeof setup>>;

/** A delivery to `flaky` of a `task.failed` event in the repository, failed for good. */
async function failedDelivery(s: Setup, repository: string) {
  await s.setState('fail', 1000);
  const seq = await s.append(repository, 'task', 'failed', `task-${repository}`);
  const dispatcher = s.dispatcher({ retryDelaysMs: [] });
  await drain(dispatcher);
  await dispatcher.stop(); // hands the lease back
  const record = (await s.deliveries()).find(d => d.eventSeq === seq)!;
  assert.equal(record.status, 'failed');
  return { seq, record };
}

test('the pause reached in one repository stops the other repositories in the same pass', async t => {
  const s = await setup(t);
  await s.setState('fail', 1000);
  const first = await s.append(ALLOWED, 'task', 'failed', 'task-a');
  await s.append(SECOND, 'task', 'failed', 'task-b');
  await s.append(SECOND, 'pull_request', 'opened', 1);
  const dispatcher = s.dispatcher({ degradedAfterFailures: 1, pauseAfterFailures: 1 });
  assert.equal(await drain(dispatcher), 1, 'the attempt that paused it is the last one');
  assert.deepEqual((await s.seen()).map(e => e.seq), [first]);
  assert.equal((await listPluginActivity(s.f.database, ID)).health.state, 'paused');
});

test('a manual retry that reaches the pause stops ordinary delivery in the same pass', async t => {
  const s = await setup(t);
  // One failure so far; the ordinary delivery is in the repository visited first.
  const { seq, record } = await failedDelivery(s, SECOND);
  const later = await s.append(ALLOWED, 'pull_request', 'opened', 1);
  await retryPluginDelivery(s.f.database, ID, String(record.id), '1', s.clock.now);
  const dispatcher = s.dispatcher({ degradedAfterFailures: 1, pauseAfterFailures: 2 });
  assert.equal(await drain(dispatcher), 1);
  assert.deepEqual((await s.seen()).map(e => e.seq), [seq, seq], 'only the manual attempt ran');
  assert.equal((await listPluginActivity(s.f.database, ID)).health.state, 'paused');

  await resumePluginDeliveries(s.f.database, ID, '1', { now: s.clock.now });
  assert.equal(await drain(dispatcher), 1);
  assert.equal((await s.seen()).at(-1)!.seq, later, 'delivered after Resume');
});

test('a manual retry interrupted by a crash is attempted again by the next lease holder, with the same id, once', async t => {
  const s = await setup(t);
  const { seq, record } = await failedDelivery(s, ALLOWED);
  await retryPluginDelivery(s.f.database, ID, String(record.id), '1', s.clock.now);
  let release!: (run: PluginHandlerRun) => void;
  const hung = new Promise<PluginHandlerRun>(resolve => { release = resolve; });
  const crashed = s.dispatcher({ owner: 'worker-c', leaseMs: 60_000, run: () => hung });
  const crashedPass = crashed.pass();
  await until(async () => (await s.deliveries())[0]?.status === 'running', 'the manual attempt to start');
  const next = s.dispatcher({ owner: 'worker-d' });
  assert.equal(await drain(next), 0, 'not while the lease lasts');
  s.clock.now += 60_001;
  // Still failing: the recovered attempt is the retry's one attempt, so the delivery fails for good.
  assert.equal(await drain(next), 1);
  const [after] = await s.deliveries();
  assert.equal(after.status, 'failed'); assert.equal(after.attempt, 3); assert.equal(after.nextAttemptAt, null);
  assert.deepEqual((await s.seen()).at(-1), { id: `evt-${seq}-flaky`, seq, repository: ALLOWED, attempt: 3 });
  assert.equal(await drain(next), 0, 'no automatic retries after it');
  release({ outcome: 'succeeded', timedOut: false, durationMs: 1, error: null, logs: [] });
  await crashedPass;
  assert.equal((await s.deliveries())[0].status, 'failed', 'the stale worker records nothing');
  // It can be retried again.
  await s.setState('fail', 0);
  await retryPluginDelivery(s.f.database, ID, String(after.id), '1', s.clock.now);
  assert.equal(await drain(next), 1);
  assert.equal((await s.deliveries())[0].status, 'succeeded');
});

test('a manual retry of an event outside the current repository limit is not handed to the handler', async t => {
  const s = await setup(t);
  const { seq, record } = await failedDelivery(s, SECOND);
  await s.f.store.setRepositories('1', ID, [ALLOWED]);
  await s.setState('fail', 0);
  await retryPluginDelivery(s.f.database, ID, String(record.id), '1', s.clock.now);
  assert.equal(await drain(s.dispatcher()), 0);
  assert.deepEqual((await s.seen()).map(e => e.seq), [seq], 'the handler did not see it again');
  const [after] = await s.deliveries();
  assert.equal(after.status, 'failed'); assert.match(after.error!, /outside the plugin's repository limit/);
});

const changes = {
  'narrowing the repository limit': (s: Setup) => s.f.store.setRepositories('1', ID, [ALLOWED]),
  'disabling the plugin': (s: Setup) => s.f.store.setEnabled('1', ID, false),
  'disabling and enabling it again': async (s: Setup) => { await s.f.store.setEnabled('1', ID, false); await s.f.store.setEnabled('1', ID, true); },
  'revoking events.read': (s: Setup) => s.f.database('plugin_installations').where({ plugin_id: ID }).update({ granted_permissions: '[]' }),
};
for (const [change, apply] of Object.entries(changes)) {
  test(`${change} while a handler runs stops the deliveries after it`, async t => {
    const s = await setup(t);
    const first = await s.append(ALLOWED, 'pull_request', 'opened', 1);
    await s.append(SECOND, 'pull_request', 'opened', 2);
    await s.append(SECOND, 'task', 'failed', 'task-b');
    let changed = false;
    const run: typeof runPluginHandler = async (...args) => {
      if (!changed) { changed = true; await apply(s); }
      return runPluginHandler(...args);
    };
    await drain(s.dispatcher({ run }));
    assert.deepEqual((await s.seen()).map(e => e.seq), [first], 'nothing after the change reached the handler');
    assert.deepEqual((await s.deliveries()).filter(d => d.attempt > 0).map(d => d.eventSeq), [first], 'and no attempt was recorded');
  });
}

test('a repository that retention emptied still has its gap recorded and its unfinished deliveries finished', async t => {
  const s = await setup(t);
  await s.setState('fail', 1000);
  const dispatcher = s.dispatcher();
  const prunedFailing = await s.append(ALLOWED, 'task', 'failed', 'task-a', {}, OLD());
  await s.append(ALLOWED, 'pull_request', 'opened', 1, {}, OLD());
  const retainedFailing = await s.append(SECOND, 'task', 'failed', 'task-b');
  await drain(dispatcher);
  assert.equal((await s.deliveries()).filter(d => d.status === 'retrying').length, 2);
  const prunedSecond = await s.append(SECOND, 'pull_request', 'opened', 2, {}, OLD());
  await pruneRepositoryEvents(s.f.database);
  assert.equal(await s.f.database('repository_events').where({ repository: ALLOWED }).first(), undefined, 'nothing of the repository is left');

  await s.setState('fail', 0);
  s.clock.now += 24 * 60 * 60 * 1000;
  await drain(dispatcher);
  const records = await s.deliveries();
  const gaps = records.filter(d => d.kind === 'gap');
  assert.deepEqual(gaps.map(g => g.repository).sort(), [ALLOWED, SECOND]);
  assert.equal(gaps.find(g => g.repository === ALLOWED)!.eventSeq, prunedFailing);
  const removed = records.find(d => d.eventSeq === prunedFailing && d.kind === 'event')!;
  assert.equal(removed.status, 'skipped'); assert.match(removed.error!, /left the journal/);
  const retained = records.find(d => d.eventSeq === retainedFailing && d.kind === 'event')!;
  assert.equal(retained.status, 'succeeded', 'an event still in the journal below the floor is delivered');
  assert.ok(!(await s.seen()).some(e => e.seq === prunedSecond));
  await drain(dispatcher);
  assert.equal((await s.deliveries()).filter(d => d.kind === 'gap').length, 2, 'a gap is recorded once');
  assert.equal(await prunePluginDeliveries(s.f.database, { now: () => s.clock.now + 15 * 24 * 60 * 60 * 1000 }), 4, 'nothing is left unfinished');
});

test('a repository emptied before the plugin ever delivered to it has its gap recorded', async t => {
  const s = await setup(t);
  const pruned = await s.append(SECOND, 'pull_request', 'opened', 1, {}, OLD());
  await pruneRepositoryEvents(s.f.database);
  await drain(s.dispatcher());
  const [gap] = await s.deliveries();
  assert.equal(gap.kind, 'gap'); assert.equal(gap.repository, SECOND); assert.equal(gap.eventSeq, pruned);
});

/** Runs `change` once, the first time the dispatcher's private `method` is called (before or after the original). */
function intercept(dispatcher: object, method: 'acquire' | 'cursor', change: () => Promise<unknown>, when: 'before' | 'after') {
  const internals = dispatcher as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = internals[method].bind(dispatcher);
  let done = false;
  internals[method] = async (...args) => {
    const first = !done; done = true;
    if (first && when === 'before') await change();
    const value = await original(...args);
    if (first && when === 'after') await change();
    return value;
  };
}
const enableAgain = async (s: Setup) => { await s.f.store.setEnabled('1', ID, false); await s.f.store.setEnabled('1', ID, true); };

for (const [moment, method, when] of [
  ['between reading the installation and taking its lease', 'acquire', 'before'],
  ['between creating the cursor and the delivery record', 'cursor', 'after'],
] as const) {
  test(`enabling again ${moment} leaves no state of the earlier start behind: later events are delivered`, async t => {
    const s = await setup(t);
    const first = s.dispatcher();
    assert.equal(await drain(first), 0, 'the dispatch state starts at the journal end');
    await first.stop(); // hands the lease back
    const earlier = await s.append(ALLOWED, 'pull_request', 'opened', 1);
    const dispatcher = s.dispatcher();
    intercept(dispatcher, method, () => enableAgain(s), when);
    assert.equal(await drain(dispatcher), 0, 'the event before enabling again is not delivered');
    assert.deepEqual(await s.f.database('plugin_delivery_cursors').where({ plugin_id: ID }).select(), [], 'no cursor at the earlier start');
    assert.deepEqual(await s.f.database('plugin_deliveries').where({ plugin_id: ID, event_seq: earlier }).select(), [], 'no record of the earlier event');

    const later = await s.append(ALLOWED, 'pull_request', 'opened', 2);
    assert.equal(await drain(dispatcher), 1);
    assert.deepEqual((await s.seen()).map(e => e.seq), [later]);
    const [cursor] = await s.f.database('plugin_delivery_cursors').where({ plugin_id: ID }).select() as { cursor_seq: number }[];
    assert.equal(Number(cursor.cursor_seq), later);
  });
}

test('a Degraded notification whose send failed is sent again until it succeeds, once, even after the pause', async t => {
  const s = await setup(t);
  await s.setState('fail', 1000);
  const sent: unknown[] = [];
  let inboxDown = true;
  const notify = async (notice: unknown) => { if (inboxDown) throw new Error('inbox down'); sent.push(notice); };
  const dispatcher = s.dispatcher({ degradedAfterFailures: 1, pauseAfterFailures: 2, retryDelaysMs: [], notify });
  await s.append(ALLOWED, 'task', 'failed', 'task-a');
  await s.append(ALLOWED, 'task', 'failed', 'task-b');
  const degradedAt = s.clock.now;
  assert.equal(await drain(dispatcher), 2);
  assert.equal((await listPluginActivity(s.f.database, ID)).health.state, 'paused');
  const owed = async () => (await s.f.database('plugin_dispatch').where({ plugin_id: ID }).first() as { degraded_notice: string | null }).degraded_notice;
  assert.notEqual(await owed(), null, 'the notification is still owed');

  // Failing again: a pass tries once a minute, not on every pass.
  await dispatcher.pass();
  s.clock.now += 60_000;
  await dispatcher.pass();
  assert.deepEqual(sent, []);
  inboxDown = false;
  await dispatcher.pass();
  assert.deepEqual(sent, [], 'not before the retry wait');
  s.clock.now += 60_000;
  await dispatcher.pass();
  const installedAt = (await s.f.store.get('1', ID)).installation!.installedAt;
  assert.deepEqual(sent, [{ pluginId: ID, installedAt, degradedAt, consecutiveFailures: 1, lastError: (await s.deliveries()).at(-1)!.error }]);
  assert.equal(await owed(), null, 'cleared once sent');
  s.clock.now += 60_000;
  await dispatcher.pass();
  await s.dispatcher({ notify }).pass();
  assert.equal(sent.length, 1, 'sent once');
});

test('a Degraded notification owed when the worker stopped is sent by the next dispatcher', async t => {
  const s = await setup(t);
  await s.setState('fail', 1000);
  // The worker exits after recording the transition, before its notifier finishes.
  const crashed = s.dispatcher({ degradedAfterFailures: 1, retryDelaysMs: [], notify: () => new Promise<void>(() => undefined) });
  await s.append(ALLOWED, 'task', 'failed', 'task-a');
  void crashed.pass();
  await until(async () => (await s.f.database('plugin_dispatch').where({ plugin_id: ID }).first() as { degraded_notice: string | null } | undefined)?.degraded_notice != null, 'the Degraded transition');
  await s.dispatcher({ owner: 'worker-e' }).pass();
  assert.equal(s.notices.length, 1);
  assert.equal((s.notices[0] as { pluginId: string }).pluginId, ID);
});
