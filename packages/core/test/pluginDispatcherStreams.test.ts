import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * What a delivery stream relies on: every spelling of a repository name is one
 * ordered stream, appends arriving without pause never hold delivery back, and
 * pruning keeps the records an event that will be read again still needs.
 */
await mock.module('../src/utils/eventPublisher.js', { namedExports: { getEventPublisher: () => ({ publishActivity: async () => true }) } });
const { EVENTS_FIXTURE_ID: ID } = await import('./helpers/pluginHandlerFixture.js');
const { ALLOWED, drain, setup, until } = await import('./helpers/pluginDispatcherFixture.js');
const { listPluginActivity, prunePluginDeliveries, resumePluginDeliveries } = await import('../src/plugins/pluginDeliveries.js');

const DAY = 24 * 60 * 60 * 1000;

test('events of one repository under different letter case are one ordered stream, held back by one retry', async t => {
  const s = await setup(t);
  const a1 = await s.append('owner/allowed', 'pull_request', 'opened', 1);
  const a2 = await s.append('Owner/Allowed', 'pull_request', 'opened', 2);
  const a3 = await s.append('OWNER/ALLOWED', 'pull_request', 'opened', 3);
  const dispatcher = s.dispatcher();
  assert.equal(await drain(dispatcher), 3);
  assert.deepEqual((await s.seen()).map(e => e.seq), [a1, a2, a3], 'journal order across spellings');
  assert.deepEqual(await s.f.database('plugin_delivery_cursors').where({ plugin_id: ID }).pluck('repository'), [ALLOWED], 'one cursor');

  // A retry waiting on one spelling holds back the later event under another.
  await s.setState('fail', 1);
  const failing = await s.append('owner/allowed', 'task', 'failed', 'task-1');
  const behind = await s.append('Owner/Allowed', 'pull_request', 'opened', 4);
  await drain(dispatcher);
  assert.deepEqual((await s.seen()).slice(3).map(e => e.seq), [failing]);
  s.clock.now += 60_000;
  await drain(dispatcher);
  assert.deepEqual((await s.seen()).slice(3).map(e => [e.seq, e.attempt]), [[failing, 1], [failing, 2], [behind, 1]]);
});

test('appends arriving without pause do not hold the next pass back', async t => {
  const s = await setup(t);
  const dispatcher = s.dispatcher({ pollMs: 60_000 });
  dispatcher.start();
  t.after(() => dispatcher.stop());
  await new Promise(resolve => setTimeout(resolve, 100)); // the first pass ran; the next poll is a minute away
  const first = await s.append(ALLOWED, 'pull_request', 'opened', 1);
  // Each append comes well within the 200 ms wake delay of the previous one.
  for (let i = 2; i < 60 && !(await s.seen()).some(e => e.seq === first); i++) {
    await new Promise(resolve => setTimeout(resolve, 40));
    await s.append(ALLOWED, 'pull_request', 'opened', i);
  }
  assert.ok((await s.seen()).some(e => e.seq === first), 'delivered while appends kept arriving');
  await until(async () => (await s.seen()).length > 1, 'later appends delivered');
});

test('pruning keeps the records of an event that a pause left ahead of the cursor: a handler that succeeded is not run again', async t => {
  const s = await setup(t);
  await s.setState('fail', 1);
  const dispatcher = s.dispatcher({ degradedAfterFailures: 1, pauseAfterFailures: 1 });
  const closed = await s.append(ALLOWED, 'pull_request', 'closed', 1);
  await drain(dispatcher);
  assert.equal((await listPluginActivity(s.f.database, ID)).health.state, 'paused');
  assert.deepEqual((await s.seen()).map(e => [e.id, e.attempt]), [[`evt-${closed}-record`, 1], [`evt-${closed}-flaky`, 1]]);

  // Paused past the retention period: the succeeded record is still needed.
  assert.equal(await prunePluginDeliveries(s.f.database, { now: () => s.clock.now + 15 * DAY }), 0);
  await resumePluginDeliveries(s.f.database, ID, '1', { now: s.clock.now });
  await drain(dispatcher);
  assert.deepEqual((await s.seen()).map(e => [e.id, e.attempt]).slice(2), [[`evt-${closed}-flaky`, 2]], 'only the retrying handler runs');
  // Once the cursor is past the event, its records go.
  assert.equal(await prunePluginDeliveries(s.f.database, { now: () => s.clock.now + 15 * DAY }), 2);
});

test('pruning keeps a final failure that paused deliveries before the cursor moved: Resume does not restart its retries', async t => {
  const s = await setup(t);
  await s.setState('fail', 1000);
  const dispatcher = s.dispatcher({ degradedAfterFailures: 1, pauseAfterFailures: 1, retryDelaysMs: [] });
  const failing = await s.append(ALLOWED, 'task', 'failed', 'task-1');
  const later = await s.append(ALLOWED, 'pull_request', 'opened', 1);
  await drain(dispatcher);
  assert.equal((await listPluginActivity(s.f.database, ID)).health.state, 'paused');
  assert.equal(await prunePluginDeliveries(s.f.database, { now: () => s.clock.now + 15 * DAY }), 0);

  await resumePluginDeliveries(s.f.database, ID, '1', { now: s.clock.now });
  await drain(dispatcher);
  assert.deepEqual((await s.seen()).map(e => [e.seq, e.attempt]), [[failing, 1], [later, 1]], 'the failed delivery is not attempted again');
  const record = (await s.deliveries()).find(d => d.eventSeq === failing)!;
  assert.equal(record.status, 'failed'); assert.equal(record.attempt, 1);
  assert.equal(await prunePluginDeliveries(s.f.database, { now: () => s.clock.now + 15 * DAY }), 2);
});
