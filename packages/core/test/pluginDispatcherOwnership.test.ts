import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Obligations a worker must not act on once it lost them: the lease (a worker
 * suspended after admitting an attempt must not start it, nor finish a manual
 * retry, once another worker took the lease) and Degraded notifications still
 * owed (a later transition never replaces one not sent yet).
 */
await mock.module('../src/utils/eventPublisher.js', { namedExports: { getEventPublisher: () => ({ publishActivity: async () => true }) } });
const { EVENTS_FIXTURE_ID: ID } = await import('./helpers/pluginHandlerFixture.js');
const { ALLOWED, drain, setup } = await import('./helpers/pluginDispatcherFixture.js');
const { listPluginActivity, retryPluginDelivery } = await import('../src/plugins/pluginDeliveries.js');

type Internals = Record<string, (...args: unknown[]) => Promise<unknown>>;
/** Runs `change` once, after the first call of the dispatcher's private `method` returned, before the caller goes on. */
function after(dispatcher: object, method: 'admit' | 'acquire', change: () => Promise<unknown>) {
  const internals = dispatcher as Internals;
  const original = internals[method].bind(dispatcher);
  let done = false;
  internals[method] = async (...args) => {
    const value = await original(...args);
    if (!done) { done = true; await change(); }
    return value;
  };
}
/** Another worker takes the installation's lease, as `acquire` does once it expired. */
const takeLease = (other: object) => (other as Internals).acquire(ID) as Promise<boolean>;

test('a worker suspended between admitting an attempt and claiming it past its lease does not start the handler', async t => {
  const s = await setup(t);
  const seq = await s.append(ALLOWED, 'pull_request', 'opened', 1);
  const stale = s.dispatcher({ owner: 'worker-a' });
  const holder = s.dispatcher({ owner: 'worker-b' });
  after(stale, 'admit', async () => {
    s.clock.now += 2 * 60_000 + 1; // past the default lease
    assert.equal(await takeLease(holder), true, 'the expired lease is taken over');
  });
  assert.equal((await stale.pass()).attempts, 0, 'the worker that lost the lease starts nothing');
  assert.deepEqual(await s.seen(), [], 'the handler did not run');
  const [record] = await s.deliveries();
  assert.equal(record.status, 'pending'); assert.equal(record.attempt, 0);

  assert.equal(await drain(holder), 1);
  assert.deepEqual(await s.seen(), [{ id: `evt-${seq}-record`, seq, repository: ALLOWED, attempt: 1 }], 'delivered once, by the lease holder');
});

test('a claim renews the lease: no other worker takes over between the claim and the handler', async t => {
  const s = await setup(t);
  await s.append(ALLOWED, 'pull_request', 'opened', 1);
  const leaseMs = 60_000;
  const other = s.dispatcher({ owner: 'worker-b', leaseMs });
  let tookOver: boolean | undefined;
  const worker = s.dispatcher({
    owner: 'worker-a', leaseMs,
    run: async () => {
      // Within one lease of the claim, but more than one lease after admission renewed it.
      s.clock.now += leaseMs - 1;
      tookOver = await takeLease(other);
      return { outcome: 'succeeded', timedOut: false, durationMs: 1, error: null, logs: [] };
    },
  });
  after(worker, 'admit', async () => { s.clock.now += leaseMs - 1; });
  assert.equal((await worker.pass()).attempts, 1);
  assert.equal(tookOver, false);
  assert.equal((await s.deliveries())[0].status, 'succeeded');
});

test('a worker that lost the lease before finishing a manual retry of an event gone from the journal writes nothing', async t => {
  const s = await setup(t);
  await s.setState('fail', 1000);
  const seq = await s.append(ALLOWED, 'task', 'failed', 'task-a');
  const first = s.dispatcher({ retryDelaysMs: [] });
  await drain(first);
  await first.stop();
  const [failed] = await s.deliveries();
  await retryPluginDelivery(s.f.database, ID, String(failed.id), '1', s.clock.now);
  await s.f.database('repository_events').where({ seq }).delete();

  const stale = s.dispatcher({ owner: 'worker-a' });
  const holder = s.dispatcher({ owner: 'worker-b' });
  after(stale, 'acquire', async () => {
    s.clock.now += 2 * 60_000 + 1;
    assert.equal(await takeLease(holder), true);
  });
  await stale.pass();
  const [untouched] = await s.deliveries();
  assert.equal(untouched.status, 'pending', 'the stale worker did not make the retry final');

  await holder.pass();
  const [final] = await s.deliveries();
  assert.equal(final.status, 'failed'); assert.match(final.error!, /no longer in the journal/);
});

test('a Degraded notification owed from an earlier transition is still sent after recovery and a second degradation', async t => {
  const s = await setup(t);
  const sent: { degradedAt: number }[] = [];
  let inboxDown = true;
  const notify = async (notice: { degradedAt: number }) => { if (inboxDown) throw new Error('inbox down'); sent.push(notice); };
  const dispatcher = s.dispatcher({ degradedAfterFailures: 1, retryDelaysMs: [], notify });

  await s.setState('fail', 1);
  await s.append(ALLOWED, 'task', 'failed', 'task-a');
  const firstAt = s.clock.now;
  assert.equal(await drain(dispatcher), 1);
  assert.equal((await listPluginActivity(s.f.database, ID)).health.state, 'degraded');

  s.clock.now += 1_000;
  await s.append(ALLOWED, 'task', 'failed', 'task-b'); // succeeds: Degraded clears
  assert.equal(await drain(dispatcher), 1);
  assert.equal((await listPluginActivity(s.f.database, ID)).health.state, 'healthy');

  s.clock.now += 1_000;
  await s.setState('fail', 1);
  await s.append(ALLOWED, 'task', 'failed', 'task-c');
  const secondAt = s.clock.now;
  assert.equal(await drain(dispatcher), 1);
  assert.equal((await listPluginActivity(s.f.database, ID)).health.state, 'degraded');
  assert.deepEqual(sent, []);

  inboxDown = false;
  s.clock.now += 60_000;
  await dispatcher.pass();
  assert.deepEqual(sent.map(n => n.degradedAt), [firstAt, secondAt], 'both transitions are notified, oldest first');
  const owed = await s.f.database('plugin_dispatch').where({ plugin_id: ID }).first() as { degraded_notice: string | null };
  assert.equal(owed.degraded_notice, null, 'nothing is owed once both were sent');
  s.clock.now += 60_000;
  await dispatcher.pass();
  assert.equal(sent.length, 2, 'each sent once');
});
