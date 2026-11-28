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

const { closeConnection, db } = await import('../src/db/connection.js');
const { createWorker, getIssueQueue, shutdownQueue, GITHUB_ISSUE_QUEUE_NAME } = await import('../src/queue/taskQueue.js');
const { removeOwnFailedJob } = await import('../src/queue/removeOwnFailedJob.js');

let redis: Redis | null = null;
let worker: Worker | null = null;
const processed: string[] = [];
const failures: Array<{ id?: string; attemptsMade: number; finishedOn?: number; message: string; data?: Record<string, unknown> }> = [];
/** Job IDs whose processor throws an ordinary error. */
const failOtherwise = new Set<string>();
/** Job IDs whose processor throws once and then makes admission refuse the retry. */
const refuseAfterFailure = new Set<string>();
/** Per job ID, called from a `failed` listener registered after the queue's own. */
const onFailed = new Map<string, (job: Job) => void>();

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
    if (refuseAfterFailure.delete(String(job.id))) {
      process.env.WORKTREE_ADMISSION_RESERVE_BYTES = REFUSE;
      throw new Error('processor failed');
    }
    if (failOtherwise.delete(String(job.id))) throw new Error('processor failed');
    return { status: 'dispatched' };
  }, { concurrency: 1 });
  worker.on('failed', (job, error) => {
    if (!job) return;
    failures.push({ id: job.id, attemptsMade: job.attemptsMade, finishedOn: job.finishedOn, message: error.message, data: job.data });
    // Runs right after the queue's own failure handler started reporting, before it removes anything.
    onFailed.get(String(job.id))?.(job);
  });
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
});

test('an issue job whose wait for disk space ran out fails for good on that refusal, and a later trigger enqueues it again', async t => {
  if (!requireRedis(t)) return;
  const since = Date.now() - 2 * 60 * 60_000;
  const queue = await getIssueQueue();
  // Kept on failure, as issue polling's jobs are under the queue's default options: without the removal the
  // retained failed job would swallow the next trigger, which BullMQ deduplicates against it.
  await queue.add('processGitHubIssue', issueJob(42, { diskPressureDeferrals: 6, diskPressureSince: since }), { ...jobOptions(42), removeOnFail: false });
  const failure = await until(async () => failures.find(entry => entry.id === jobId(42)), Boolean, 'the final failure');
  assert.ok(failure);
  assert.equal(typeof failure.finishedOn, 'number', 'no BullMQ retry follows');
  assert.equal(failure.attemptsMade, 1);
  // The final refusal carries its measurement: path, free space, reserve, other claims and this job's size.
  assert.match(failure.message, /^Worktree disk pressure: admission reserve unavailable after waiting 120 minutes \(7 refusals\); data retained \(filesystem \S+: free [\d.]+ \w?i?B < required [\d.]+ \w?i?B = reserve [\d.]+ \w?i?B \+ 0 other claims \+ this job [\d.]+ \w?i?B\)$/);
  assert.ok(failure.message.includes(`(filesystem ${path.join(root, 'worktrees')}:`), 'the measured filesystem path is reported');
  await until(() => jobState(jobId(42)), value => value.state === 'absent', 'removal of the refused job');
  assert.equal(failures.filter(entry => entry.id === jobId(42)).length, 1);

  // Space is back; a relabel or a later poll adds the issue under the same job ID, and it runs.
  process.env.WORKTREE_ADMISSION_RESERVE_BYTES = '1';
  await queue.add('processGitHubIssue', issueJob(42), { ...jobOptions(42), removeOnFail: false });
  await until(async () => processed.filter(id => id === jobId(42)).length, count => count === 1, 'the re-enqueued job to run');
});

test('an issue job that fails for another reason is not removed by the disk-pressure handling', async t => {
  if (!requireRedis(t)) return;
  process.env.WORKTREE_ADMISSION_RESERVE_BYTES = '1';
  failOtherwise.add(jobId(43));
  await (await getIssueQueue()).add('processGitHubIssue', issueJob(43), { ...jobOptions(43), attempts: 1, removeOnFail: false });
  await until(() => jobState(jobId(43)), value => value.state === 'failed', 'the failed attempt');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await jobState(jobId(43))).state, 'failed', 'its own retention applies');
});

test('a retry refused after an admitted attempt failed keeps the evidence that the job already ran', async t => {
  if (!requireRedis(t)) return;
  // Waiting disabled: the refused retry spends the last attempt and fails for good.
  process.env.WORKTREE_DISK_PRESSURE_MAX_WAIT_MS = '0';
  process.env.WORKTREE_ADMISSION_RESERVE_BYTES = '1';
  refuseAfterFailure.add(jobId(47));
  await (await getIssueQueue()).add('processGitHubIssue', issueJob(47), { ...jobOptions(47), attempts: 2 });
  const final = await until(async () => failures.find(entry => entry.id === jobId(47) && entry.attemptsMade === 2), Boolean, 'the refused retry');
  assert.ok(final);
  assert.deepEqual(processed.filter(id => id === jobId(47)), [jobId(47)], 'only the first attempt entered the processor');
  assert.match(final.message, /^Worktree disk pressure: admission reserve unavailable/);
  assert.equal(final.data?.issueJobAdmitted, true, 'the final refusal knows an earlier attempt ran, so it is not reported as never started');
  const { diskPressureRefusalCommentBody } = await import('../src/services/issueDiskPressureRefusal.js');
  const body = diskPressureRefusalCommentBody({ data: final.data ?? {} }, { inPlan: false });
  assert.doesNotMatch(body, /nothing was changed/i);
  assert.match(body, /The latest attempt was refused/);
  await until(() => jobState(jobId(47)), value => value.state === 'absent', 'removal of the refused job');
});

test('a replacement added under the same job ID while the refusal is reported is not removed by the old delivery\'s cleanup', async t => {
  if (!requireRedis(t)) return;
  const queue = await getIssueQueue();
  const since = Date.now() - 2 * 60 * 60_000;
  // Hold the failure handling's database access (submission intake, then the plan-issue report) at a gate,
  // so the old delivery's cleanup can only run after the replacement exists.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = 0;
  const client = db.client as { acquireConnection: () => Promise<unknown> };
  const acquire = client.acquireConnection;
  let gated = false;
  client.acquireConnection = async function (this: unknown) {
    if (gated) { held += 1; await gate; }
    return acquire.call(this);
  };
  t.after(() => { client.acquireConnection = acquire; release(); });
  // BullMQ removes the failed delivery on failure (as both producers set); a relabel adds the issue again.
  onFailed.set(jobId(48), () => { gated = true; });
  await queue.add('processGitHubIssue', issueJob(48, { diskPressureDeferrals: 6, diskPressureSince: since }), jobOptions(48));
  await until(async () => held, count => count > 0, 'the failure handling to reach the paused report');
  assert.equal((await jobState(jobId(48))).state, 'absent', 'the failed delivery was removed on failure');
  await queue.add('processGitHubIssue', issueJob(48, { correlationId: 'corr-48-replacement' }), jobOptions(48));
  await until(() => jobState(jobId(48)), value => value.state === 'delayed' && value.job?.data.correlationId === 'corr-48-replacement', 'the replacement to wait for space');
  gated = false;
  release();
  // Let the old delivery's failure handling (report, then cleanup) finish.
  await new Promise(resolve => setTimeout(resolve, 1_500));
  const after = await jobState(jobId(48));
  assert.equal(after.state, 'delayed', 'the replacement survives the old delivery\'s cleanup');
  assert.equal(after.job?.data.correlationId, 'corr-48-replacement');
  onFailed.delete(jobId(48));
  await after.job?.remove();
});

test('cleanup of a retained failed delivery removes only that delivery, never a later one under its ID', async t => {
  if (!requireRedis(t)) return;
  process.env.WORKTREE_ADMISSION_RESERVE_BYTES = '1';
  const queue = await getIssueQueue();
  const failedDelivery = async (number: number) => {
    failOtherwise.add(jobId(number));
    await queue.add('processGitHubIssue', issueJob(number), { ...jobOptions(number), attempts: 1, removeOnFail: false });
    const { job } = await until(() => jobState(jobId(number)), value => value.state === 'failed', 'the failed delivery');
    assert.ok(job);
    return job;
  };

  // The held delivery is still the failed job under its ID: it is removed.
  const own = await failedDelivery(49);
  assert.equal(await removeOwnFailedJob(queue, own), 'removed');
  assert.equal((await jobState(jobId(49))).state, 'absent');

  // The held delivery is gone (retention, another cleanup) and a replacement waits or is delayed under its ID.
  const stale = await failedDelivery(50);
  await stale.remove();
  await queue.pause();
  try {
    await queue.add('processGitHubIssue', issueJob(50), jobOptions(50));
    assert.equal(await removeOwnFailedJob(queue, stale), 'not_owned');
    assert.equal((await jobState(jobId(50))).state, 'waiting', 'the waiting replacement is kept');
    await (await jobState(jobId(50))).job?.remove();
    await queue.add('processGitHubIssue', issueJob(50), { ...jobOptions(50), delay: 60_000 });
    assert.equal(await removeOwnFailedJob(queue, stale), 'not_owned');
    assert.equal((await jobState(jobId(50))).state, 'delayed', 'the delayed replacement is kept');
    await (await jobState(jobId(50))).job?.remove();
  } finally {
    await queue.resume();
  }

  // The replacement failed for good too: it is another delivery, which its own handler settles.
  const replacement = await failedDelivery(50);
  assert.notEqual(replacement.timestamp, stale.timestamp);
  assert.equal(await removeOwnFailedJob(queue, stale), 'not_owned');
  assert.equal((await jobState(jobId(50))).state, 'failed', 'the later failed delivery is kept');

  // A delivery BullMQ removed on failure is never removed again by ID.
  assert.equal(await removeOwnFailedJob(queue, { ...replacement, id: replacement.id, timestamp: replacement.timestamp, finishedOn: replacement.finishedOn, opts: { removeOnFail: true } } as Job), 'removed_on_fail');
  assert.equal((await jobState(jobId(50))).state, 'failed');
});
