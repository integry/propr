/**
 * Issue jobs refused by worktree admission for disk pressure, on a real Redis
 * server, through the real BullMQ worker that core's createWorker builds.
 * Admission is refused by an injected reserve larger than any disk (read per
 * job, so a test can lift it), not by filling one.
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

const { closeConnection } = await import('../src/db/connection.js');
const { createWorker, getIssueQueue, shutdownQueue, GITHUB_ISSUE_QUEUE_NAME } = await import('../src/queue/taskQueue.js');
const { enqueueIssueJobReplacingFinished } = await import('../src/queue/issueJobEnqueue.js');

let redis: Redis | null = null;
let worker: Worker | null = null;
const processed: string[] = [];
const failures: Array<{ id?: string; attemptsMade: number; finishedOn?: number; message: string }> = [];
/** Job IDs whose processor throws once, to leave a failed job retained under that ID. */
const failOnce = new Set<string>();

before(async () => {
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
    if (failOnce.delete(String(job.id))) throw new Error('processor failed');
    return { status: 'dispatched' };
  }, { concurrency: 1 });
  worker.on('failed', (job, error) => { if (job) failures.push({ id: job.id, attemptsMade: job.attemptsMade, finishedOn: job.finishedOn, message: error.message }); });
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

beforeEach(() => { process.env.WORKTREE_ADMISSION_RESERVE_BYTES = REFUSE; });

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

const jobId = (number: number) => `issue-${OWNER}-repo-${number}`;
// As the daemon and the plan route add an issue job.
const issueJob = (number: number, extra: Record<string, unknown> = {}) => ({ repoOwner: OWNER, repoName: 'repo', number, triggeringLabel: 'AI', correlationId: `corr-${number}`, ...extra });
const jobOptions = (number: number) => ({ jobId: jobId(number), attempts: 3, backoff: { type: 'exponential', delay: 200 }, removeOnComplete: true, removeOnFail: true });

async function jobState(id: string): Promise<{ state: string; job: Job | undefined }> {
  const job = await (await getIssueQueue()).getJob(id) as Job | undefined;
  return { state: job ? await job.getState() : 'absent', job };
}

test('an issue job whose admission is refused for disk pressure is deferred, not failed', async t => {
  if (!requireRedis(t)) return;
  const before = Date.now();
  await (await getIssueQueue()).add('processGitHubIssue', issueJob(41), jobOptions(41));
  const { job } = await until(() => jobState(jobId(41)), value => value.state === 'delayed' && value.job?.data.diskPressureDeferrals === 1, 'the deferral');
  assert.ok(job);
  assert.equal(job.attemptsMade, 0, 'the wait does not consume the attempt budget');
  assert.ok(job.data.diskPressureRetryAt >= before + 2 * 60_000, 'the retry is minutes away');
  assert.equal(job.data.diskPressureSince >= before, true);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(failures.filter(failure => failure.id === jobId(41)).length, 0, 'no failed attempt was recorded');
  assert.equal((await jobState(jobId(41))).state, 'delayed');
  assert.deepEqual(processed.filter(id => id === jobId(41)), [], 'admission refuses before the processor is entered');

  // A later request for the same issue is served by the waiting job, and says so.
  const outcome = await enqueueIssueJobReplacingFinished(await getIssueQueue(), { name: 'processGitHubIssue', data: issueJob(41), opts: jobOptions(41) });
  assert.deepEqual(outcome, { status: 'already_queued', state: 'delayed' });
});

test('an issue job whose wait for disk space ran out fails for good on that refusal', async t => {
  if (!requireRedis(t)) return;
  const since = Date.now() - 2 * 60 * 60_000;
  await (await getIssueQueue()).add('processGitHubIssue', issueJob(42, { diskPressureDeferrals: 6, diskPressureSince: since }), jobOptions(42));
  const failure = await until(async () => failures.find(entry => entry.id === jobId(42)), Boolean, 'the final failure');
  assert.ok(failure);
  assert.equal(typeof failure.finishedOn, 'number', 'no BullMQ retry follows');
  assert.equal(failure.attemptsMade, 1);
  assert.match(failure.message, /^Worktree disk pressure: admission reserve unavailable after waiting 120 minutes \(7 refusals\); data retained$/);
  await until(() => jobState(jobId(42)), value => value.state === 'absent', 'removal on failure');
  assert.equal(failures.filter(entry => entry.id === jobId(42)).length, 1);
});

test('re-enqueuing an issue after a failed attempt retained under its job ID runs the job', async t => {
  if (!requireRedis(t)) return;
  process.env.WORKTREE_ADMISSION_RESERVE_BYTES = '1';
  const queue = await getIssueQueue();
  failOnce.add(jobId(43));
  // Kept on failure, as the queue's default options keep failed jobs for a week.
  await queue.add('processGitHubIssue', issueJob(43), { ...jobOptions(43), attempts: 1, removeOnFail: false });
  await until(() => jobState(jobId(43)), value => value.state === 'failed', 'the failed attempt');
  assert.equal(processed.filter(id => id === jobId(43)).length, 1);

  // Without the fix: BullMQ deduplicates the new request against the retained failed job, which never runs again.
  await queue.add('processGitHubIssue', issueJob(43), jobOptions(43));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await jobState(jobId(43))).state, 'failed');
  assert.equal(processed.filter(id => id === jobId(43)).length, 1);

  const outcome = await enqueueIssueJobReplacingFinished(queue, { name: 'processGitHubIssue', data: issueJob(43), opts: jobOptions(43) });
  assert.deepEqual(outcome, { status: 'added', replaced: 'failed' });
  await until(async () => processed.filter(id => id === jobId(43)).length, count => count === 2, 'the re-enqueued job to run');
  await until(() => jobState(jobId(43)), value => value.state === 'absent', 'completion');
});
