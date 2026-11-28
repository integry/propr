/**
 * Issue jobs refused by worktree admission for disk pressure, on a real Redis
 * server, through the real BullMQ worker that core's createWorker builds.
 * Admission is refused by an injected reserve larger than any disk (read per
 * job, so a test can lift it), not by filling one.
 * Jobs are enqueued as the daemon and the plan route do, through the issue's
 * dispatch row (`issueDispatch.ts`), on a migrated SQLite database.
 * The suite is skipped when Redis is not reachable (set REDIS_HOST /
 * REDIS_PORT), unless PROPR_REQUIRE_REDIS_INTEGRATION=1. Its queue and job IDs
 * are namespaced by run, and every wait is bounded.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test, type TestContext } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { Redis } from 'ioredis';
import type { Job, Worker } from 'bullmq';

const REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT = Number.parseInt(process.env.REDIS_PORT ?? '6379', 10);
const RUN_ID = `${process.pid}-${Date.now()}`;
const OWNER = `itest-disk-${RUN_ID}`;
const REFUSE = String(Number.MAX_SAFE_INTEGER);

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-disk-pressure-'));
await fs.ensureDir(path.join(root, 'worktrees'));
Object.assign(process.env, {
  REDIS_HOST, REDIS_PORT: String(REDIS_PORT),
  GITHUB_ISSUE_QUEUE_NAME: `disk-itest-${RUN_ID}`,
  DB_FILENAME: path.join(root, 'propr.sqlite'), DATA_DIR: root,
  GIT_CLONES_BASE_PATH: path.join(root, 'clones'), GIT_WORKTREES_BASE_PATH: path.join(root, 'worktrees'),
  WORKTREE_ADMISSION_RESERVE_BYTES: REFUSE,
  WORKTREE_TASK_BUDGET_BYTES: '1',
  // The final refusal is reported on the issue; no GitHub access here.
  PROPR_DEMO_MODE: 'true',
});

const { closeConnection, db, runMigrations } = await import('../src/db/connection.js');
const { createWorker, getIssueQueue, shutdownQueue, GITHUB_ISSUE_QUEUE_NAME } = await import('../src/queue/taskQueue.js');
const { claimIssueDispatch, enqueueIssueDispatch, findIssueDispatch, settleIssueDispatch, ISSUE_DISPATCH_ABANDON_AFTER_MS } = await import('../src/queue/issueDispatch.js');

let redis: Redis | null = null;
let worker: Worker | null = null;
const processed: string[] = [];
const failures: Array<{ id?: string; attemptsMade: number; finishedOn?: number; message: string; data?: Record<string, unknown> }> = [];
/** Job IDs whose processor throws once. */
const failOnce = new Set<string>();
/** Job IDs whose processor throws once and then makes admission refuse the retry. */
const refuseAfterFailure = new Set<string>();
/** Job IDs whose processor runs this before it returns. */
const during = new Map<string, (job: Job) => Promise<void>>();

/** The suite's processor; a test's second worker runs it too. */
async function processor(job: Job): Promise<{ status: string }> {
  processed.push(String(job.id));
  const hook = during.get(String(job.id));
  if (hook) { during.delete(String(job.id)); await hook(job); }
  if (refuseAfterFailure.delete(String(job.id))) {
    process.env.WORKTREE_ADMISSION_RESERVE_BYTES = REFUSE;
    throw new Error('processor failed');
  }
  if (failOnce.delete(String(job.id))) throw new Error('processor failed');
  return { status: 'dispatched' };
}

before(async () => {
  await runMigrations();
  const client = new Redis({ host: REDIS_HOST, port: REDIS_PORT, connectTimeout: 250, lazyConnect: true, maxRetriesPerRequest: null, retryStrategy: () => null });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.ping();
  } catch (error) {
    client.disconnect();
    if (process.env.PROPR_REQUIRE_REDIS_INTEGRATION === '1') {
      throw new Error(`Redis integration tests are required but Redis at ${REDIS_HOST}:${REDIS_PORT} is unreachable: ${(error as Error).message}`);
    }
    return;
  }
  redis = client;
  worker = await createWorker(GITHUB_ISSUE_QUEUE_NAME, processor, { concurrency: 1 });
  worker.on('failed', (job, error) => { if (job) failures.push({ id: job.id, attemptsMade: job.attemptsMade, finishedOn: job.finishedOn, message: error.message, data: job.data }); });
});

after(async () => {
  if (redis) {
    await worker?.close(true);
    const queue = await getIssueQueue();
    await queue.obliterate({ force: true }).catch(() => {});
    for (const entry of await redis.zrange('metrics:ai:log:v1', 0, -1)) if (entry.includes(OWNER)) await redis.zrem('metrics:ai:log:v1', entry);
    for (const entry of await redis.lrange('system:activity:log', 0, -1)) if (entry.includes(OWNER)) await redis.lrem('system:activity:log', 0, entry);
    await shutdownQueue();
    redis.disconnect();
  }
  await closeConnection();
  await fs.remove(root);
});

beforeEach(() => { process.env.WORKTREE_ADMISSION_RESERVE_BYTES = REFUSE; delete process.env.WORKTREE_DISK_PRESSURE_MAX_WAIT_MS; });
after(() => { delete process.env.WORKTREE_DISK_PRESSURE_MAX_WAIT_MS; });

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function requireRedis(t: TestContext): boolean {
  if (!redis) t.skip('Redis is not available for integration testing');
  return Boolean(redis);
}

// As the daemon and the plan route add an issue job.
const issueJob = (number: number, extra: Record<string, unknown> = {}) => ({ repoOwner: OWNER, repoName: 'repo', number, triggeringLabel: 'AI', correlationId: `corr-${number}`, ...extra });
const jobOptions = { attempts: 3, backoff: { type: 'exponential', delay: 200 }, removeOnComplete: true, removeOnFail: true };
const enqueue = async (number: number, extra: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) =>
  enqueueIssueDispatch(await getIssueQueue(), { name: 'processGitHubIssue', data: issueJob(number, extra), opts: { ...jobOptions, ...opts } });
const dispatchOf = (number: number) => findIssueDispatch({ owner: OWNER, repo: 'repo', number });

async function jobState(id: string): Promise<{ state: string; job: Job | undefined }> {
  const job = await (await getIssueQueue()).getJob(id) as Job | undefined;
  return { state: job ? await job.getState() : 'absent', job };
}

test('an issue job whose admission is refused for disk pressure is deferred, not failed', async t => {
  if (!requireRedis(t)) return;
  const before = Date.now();
  const { jobId } = await enqueue(41);
  const { job } = await until(() => jobState(jobId), value => value.state === 'delayed' && value.job?.data.diskPressureDeferrals === 1, 'the deferral');
  assert.ok(job);
  assert.equal(job.attemptsMade, 0, 'the wait does not consume the attempt budget');
  assert.ok(job.data.diskPressureRetryAt >= before + 2 * 60_000, 'the retry is minutes away');
  assert.equal(job.data.diskPressureSince >= before, true);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(failures.filter(failure => failure.id === jobId).length, 0, 'no failed attempt was recorded');
  assert.equal((await jobState(jobId)).state, 'delayed');
  assert.deepEqual(processed.filter(id => id === jobId), [], 'admission refuses before the processor is entered');
  const dispatch = await until(() => dispatchOf(41), row => row?.state === 'deferred', 'the deferred dispatch');
  assert.equal(dispatch?.started_at, null);
  assert.match(String(dispatch?.details), /^filesystem \S+: free /);

  // A later request for the same issue is served by the waiting dispatch, and says so.
  assert.deepEqual(await enqueue(41), { status: 'already_queued', dispatchId: dispatch!.dispatch_id, jobId, state: 'deferred' });
  assert.equal((await (await getIssueQueue()).getJobs(['delayed', 'waiting', 'active'])).filter(entry => entry.data.repoOwner === OWNER && entry.data.number === 41).length, 1);
});

test('an issue job whose wait for disk space ran out fails for good on that refusal', async t => {
  if (!requireRedis(t)) return;
  const since = Date.now() - 2 * 60 * 60_000;
  const { jobId } = await enqueue(42, { diskPressureDeferrals: 6, diskPressureSince: since });
  const failure = await until(async () => failures.find(entry => entry.id === jobId), Boolean, 'the final failure');
  assert.ok(failure);
  assert.equal(typeof failure.finishedOn, 'number', 'no BullMQ retry follows');
  assert.equal(failure.attemptsMade, 1);
  // The final refusal carries its measurement: path, free space, reserve, other claims and this job's size.
  assert.match(failure.message, /^Worktree disk pressure: admission reserve unavailable after waiting 120 minutes \(7 refusals\); data retained \(filesystem \S+: free [\d.]+ \w?i?B < required [\d.]+ \w?i?B = reserve [\d.]+ \w?i?B \+ 0 other claims \+ this job [\d.]+ \w?i?B\)$/);
  assert.ok(failure.message.includes(`(filesystem ${path.join(root, 'worktrees')}:`), 'the measured filesystem path is reported');
  await until(() => jobState(jobId), value => value.state === 'absent', 'removal on failure');
  assert.equal(failures.filter(entry => entry.id === jobId).length, 1);
  const dispatch = await until(() => dispatchOf(42), row => row?.state === 'failed', 'the ended dispatch');
  assert.equal(dispatch?.started_at, null, 'no attempt entered the processor');
});

test('a retry refused after an admitted attempt failed finds started_at on its dispatch', async t => {
  if (!requireRedis(t)) return;
  // Waiting disabled: the refused retry spends the last attempt and fails for good.
  process.env.WORKTREE_DISK_PRESSURE_MAX_WAIT_MS = '0';
  process.env.WORKTREE_ADMISSION_RESERVE_BYTES = '1';
  const { jobId, dispatchId } = await enqueue(47, {}, { attempts: 2, delay: 200 });
  refuseAfterFailure.add(jobId);
  const final = await until(async () => failures.find(entry => entry.id === jobId && entry.attemptsMade === 2), Boolean, 'the refused retry');
  assert.ok(final);
  assert.deepEqual(processed.filter(id => id === jobId), [jobId], 'only the first attempt entered the processor');
  assert.match(final.message, /^Worktree disk pressure: admission reserve unavailable/);
  const dispatch = await until(() => dispatchOf(47), row => row?.state === 'failed', 'the ended dispatch');
  assert.equal(dispatch?.dispatch_id, dispatchId);
  assert.equal(typeof dispatch?.started_at, 'number', 'the final refusal knows an earlier attempt ran, so it is not reported as never started');
});

test('a request after a failed dispatch runs a new job under a new ID; the failed job is never removed', async t => {
  if (!requireRedis(t)) return;
  process.env.WORKTREE_ADMISSION_RESERVE_BYTES = '1';
  const first = await enqueue(43, {}, { attempts: 1, removeOnFail: false, delay: 200 });
  failOnce.add(first.jobId);
  await until(() => jobState(first.jobId), value => value.state === 'failed', 'the failed attempt');
  await until(() => dispatchOf(43), row => row?.state === 'failed', 'the ended dispatch');

  const second = await enqueue(43);
  assert.equal(second.status, 'added');
  assert.notEqual(second.jobId, first.jobId);
  await until(async () => processed.filter(id => id === second.jobId).length, count => count === 1, 'the new job to run');
  await until(() => dispatchOf(43), row => row?.state === 'completed', 'the completed dispatch');
  assert.equal((await jobState(first.jobId)).state, 'failed', 'the earlier job is left as it is');
});

test('two concurrent requests for one issue add exactly one job', async t => {
  if (!requireRedis(t)) return;
  const outcomes = await Promise.all([enqueue(46, { retryCommentId: 'a' }, { delay: 60_000 }), enqueue(46, { retryCommentId: 'b' }, { delay: 60_000 })]);
  assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), ['added', 'already_queued']);
  const added = outcomes.find(outcome => outcome.status === 'added')!;
  const jobs = (await (await getIssueQueue()).getJobs(['delayed'])).filter(entry => entry.data.repoOwner === OWNER && entry.data.number === 46);
  assert.deepEqual(jobs.map(entry => entry.id), [added.jobId]);
  assert.equal((await db('issue_dispatches').where({ dispatch_id: added.dispatchId }).first())?.state, 'queued');
});

test('a job whose dispatch a newer request took over completes at admission without entering its processor', async t => {
  if (!requireRedis(t)) return;
  process.env.WORKTREE_ADMISSION_RESERVE_BYTES = '1';
  const ref = { owner: OWNER, repo: 'repo', number: 48 };
  const superseded = await enqueue(48, {}, { delay: 300, removeOnComplete: false });
  // A newer request took the issue over while this job was not yet picked up (as when its producer added it late).
  const takeover = await claimIssueDispatch(ref, { abandoned: (await dispatchOf(48))! });
  assert.equal(takeover.status, 'claimed');
  const { job } = await until(() => jobState(superseded.jobId), value => value.state === 'completed', 'the superseded job to end');
  assert.deepEqual(job?.returnvalue, { status: 'skipped', reason: 'issue_dispatch_superseded' });
  assert.deepEqual(processed.filter(id => id === superseded.jobId), [], 'the processor is not entered');
  await new Promise(resolve => setTimeout(resolve, 100));
  const row = await dispatchOf(48);
  assert.deepEqual([row?.dispatch_id, row?.state, row?.started_at], [takeover.dispatch.dispatch_id, 'queued', null], 'the newer dispatch does not move');
});

test('a refused child releases its plan issue only once its dispatch has no sibling in flight', async t => {
  if (!requireRedis(t)) return;
  const ref = { owner: OWNER, repo: 'repo', number: 49 };
  const repository = `${OWNER}/repo`;
  const draftId = `00000000-0000-4000-8000-${String(process.pid).padStart(12, '0').slice(-12)}`;
  await db('task_drafts').insert({ draft_id: draftId, user_id: 'user', repository, status: 'in_progress' });
  await db('plan_issues').insert({ draft_id: draftId, repository, issue_number: 49, status: 'pending' });
  const claim = await claimIssueDispatch(ref);
  assert.equal(claim.status, 'claimed');
  const planIssue = () => db('plan_issues').where({ draft_id: draftId, issue_number: 49 }).first();
  assert.equal((await planIssue())?.issue_dispatch_id, claim.dispatch.dispatch_id);
  await db('plan_issues').where({ draft_id: draftId }).update({ status: 'processing' });
  // The dispatcher passed admission, queued two execution children and completed; neither child has started.
  await settleIssueDispatch(claim.dispatch.dispatch_id, 'completed');
  const queue = await getIssueQueue();
  const childData = issueJob(49, { isChildJob: true, issueDispatchId: claim.dispatch.dispatch_id, diskPressureDeferrals: 6, diskPressureSince: Date.now() - 2 * 60 * 60_000 });
  const laterId = `${claim.dispatch.job_id}-later`;
  const firstId = `${claim.dispatch.job_id}-first`;
  await queue.add('processGitHubIssue', childData, { ...jobOptions, jobId: laterId, delay: 60_000 });
  await queue.add('processGitHubIssue', childData, { ...jobOptions, jobId: firstId });

  await until(async () => failures.find(entry => entry.id === firstId), Boolean, 'the first child\'s final refusal');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await planIssue())?.status, 'processing', 'the delayed sibling may still run');

  await (await queue.getJob(laterId))!.promote();
  await until(async () => failures.find(entry => entry.id === laterId), Boolean, 'the last child\'s final refusal');
  await until(async () => (await planIssue())?.status, status => status === 'pending', 'the plan issue release');
  assert.deepEqual(processed.filter(id => id === firstId || id === laterId), [], 'no child entered its processor');
  assert.equal((await dispatchOf(49))?.state, 'completed', 'a child does not move the dispatch');
});

/** A plan issue for `number`, linked to the issue's next dispatch and marked processing once it is queued. */
async function planIssueFor(number: number): Promise<{ draftId: string; status: () => Promise<string | undefined> }> {
  const repository = `${OWNER}/repo`;
  const draftId = `00000000-0000-4000-8000-${String(number).padStart(4, '0')}${String(process.pid).padStart(8, '0').slice(-8)}`;
  await db('task_drafts').insert({ draft_id: draftId, user_id: 'user', repository, status: 'in_progress' });
  await db('plan_issues').insert({ draft_id: draftId, repository, issue_number: number, status: 'pending' });
  return { draftId, status: async () => (await db('plan_issues').where({ draft_id: draftId, issue_number: number }).first())?.status };
}

test('F9: a child refused while its dispatcher still runs releases the plan issue once the dispatcher completes', async t => {
  if (!requireRedis(t)) return;
  // Waiting disabled: the child's single attempt fails for good on its refusal.
  process.env.WORKTREE_DISK_PRESSURE_MAX_WAIT_MS = '0';
  process.env.WORKTREE_ADMISSION_RESERVE_BYTES = '1';
  const plan = await planIssueFor(51);
  const queue = await getIssueQueue();
  const parent = await enqueue(51, {}, { delay: 200 });
  await db('plan_issues').where({ draft_id: plan.draftId }).update({ status: 'processing' });
  const childId = `${parent.jobId}-child`;
  let planWhileDispatcherRan: string | undefined;
  during.set(parent.jobId, async () => {
    // The dispatcher queues its execution child, which another worker picks up and admission refuses,
    // while the dispatcher still has work to do after the add.
    process.env.WORKTREE_ADMISSION_RESERVE_BYTES = REFUSE;
    await queue.add('processGitHubIssue', issueJob(51, { isChildJob: true, issueDispatchId: parent.dispatchId }), { attempts: 1, removeOnComplete: true, removeOnFail: true, jobId: childId });
    await until(() => dispatchOf(51), row => row?.refusal_release === 'pending', 'the child\'s refusal recorded while its dispatcher runs');
    planWhileDispatcherRan = await plan.status();
  });
  // A second worker, so the child is picked up while the first one runs the dispatcher.
  const second = await createWorker(GITHUB_ISSUE_QUEUE_NAME, processor, { concurrency: 1 });
  try {
    await until(plan.status, status => status === 'pending', 'the plan issue release once the dispatcher completed');
  } finally {
    await second.close(true);
  }
  assert.equal(planWhileDispatcherRan, 'processing', 'the refusal left the plan issue to the dispatcher still running');
  const row = await dispatchOf(51);
  assert.deepEqual([row?.dispatch_id, row?.state, row?.refusal_release], [parent.dispatchId, 'completed', 'released']);
  assert.deepEqual(processed.filter(id => id === childId), [], 'the child never entered its processor');
  assert.equal(processed.filter(id => id === parent.jobId).length, 1);
});

test('F10: a request whose queue read raced the dispatch\'s admission is served by the admitted dispatch', async t => {
  if (!requireRedis(t)) return;
  process.env.WORKTREE_ADMISSION_RESERVE_BYTES = '1';
  const queue = await getIssueQueue();
  const hold = () => { let reached!: () => void; let open!: () => void;
    const arrived = new Promise<void>(resolve => { reached = resolve; }); const gate = new Promise<void>(resolve => { open = resolve; });
    return { arrived, reached, gate, open }; };
  const add = hold();
  const read = hold();
  const processorHeld = hold();
  // Producer A: suspended between its claim and its add.
  const producerA = enqueueIssueDispatch({ add: async (...args: Parameters<typeof queue.add>) => { add.reached(); await add.gate; return queue.add(...args); }, getJob: id => queue.getJob(id) },
    { name: 'processGitHubIssue', data: issueJob(52), opts: jobOptions });
  await add.arrived;
  const claimedA = (await dispatchOf(52))!;
  await db('issue_dispatches').where({ dispatch_id: claimedA.dispatch_id }).update({ updated_at: Date.now() - ISSUE_DISPATCH_ABANDON_AFTER_MS - 1 });
  // Producer B: Redis answers that A's job is absent; that answer is held on its way back.
  let reads = 0;
  const producerB = enqueueIssueDispatch({ add: (...args: Parameters<typeof queue.add>) => queue.add(...args), getJob: async id => {
    const found = await queue.getJob(id);
    if (reads++ === 0) { read.reached(); await read.gate; }
    return found;
  } }, { name: 'processGitHubIssue', data: issueJob(52), opts: jobOptions });
  await read.arrived;
  // A adds its job; the worker admits it and A's dispatcher runs until the end of the test.
  during.set(claimedA.job_id, async () => { processorHeld.reached(); await processorHeld.gate; });
  add.open();
  assert.equal((await producerA).status, 'added');
  await processorHeld.arrived;
  assert.equal((await dispatchOf(52))?.state, 'processing');
  read.open();
  try {
    const outcomeB = await producerB;
    assert.deepEqual([outcomeB.status, outcomeB.dispatchId], ['already_queued', claimedA.dispatch_id]);
    const jobs = (await queue.getJobs(['waiting', 'delayed', 'active', 'prioritized'])).filter(entry => entry.data.repoOwner === OWNER && entry.data.number === 52);
    assert.deepEqual(jobs.map(entry => entry.id), [claimedA.job_id], 'no second dispatcher was queued');
  } finally {
    processorHeld.open();
  }
  await until(() => dispatchOf(52), row => row?.state === 'completed', 'A\'s dispatch to complete');
  assert.equal((await dispatchOf(52))?.dispatch_id, claimedA.dispatch_id);
  assert.equal(processed.filter(id => id.startsWith(`issue-${OWNER}-repo-52-`)).length, 1, 'one dispatcher ran');
});
