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
const { enqueueIssueDispatch, findIssueDispatch } = await import('../src/queue/issueDispatch.js');

let redis: Redis | null = null;
let worker: Worker | null = null;
const processed: string[] = [];
const failures: Array<{ id?: string; attemptsMade: number; finishedOn?: number; message: string; data?: Record<string, unknown> }> = [];
/** Job IDs whose processor throws once. */
const failOnce = new Set<string>();
/** Job IDs whose processor throws once and then makes admission refuse the retry. */
const refuseAfterFailure = new Set<string>();

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
  worker = await createWorker(GITHUB_ISSUE_QUEUE_NAME, async job => {
    processed.push(String(job.id));
    if (refuseAfterFailure.delete(String(job.id))) {
      process.env.WORKTREE_ADMISSION_RESERVE_BYTES = REFUSE;
      throw new Error('processor failed');
    }
    if (failOnce.delete(String(job.id))) throw new Error('processor failed');
    return { status: 'dispatched' };
  }, { concurrency: 1 });
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
