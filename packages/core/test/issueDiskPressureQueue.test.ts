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
const { default: logger } = await import('../src/utils/logger.js');
const { clearFailedJobCommand, diskPressureRefusalCommentBody } = await import('../src/services/issueDiskPressureRefusal.js');

/** What the worker's refusal report logged (its retention among it), by job ID. */
const reports = new Map<string, Record<string, unknown>>();
const withCorrelation = logger.withCorrelation.bind(logger);
logger.withCorrelation = (...args: Parameters<typeof withCorrelation>) => {
  const child = withCorrelation(...args);
  const warn = child.warn.bind(child) as (...rest: unknown[]) => void;
  child.warn = ((obj: unknown, ...rest: unknown[]) => {
    if (typeof rest[0] === 'string' && rest[0].startsWith('Reported an issue job refused') && obj && typeof obj === 'object') {
      const entry = obj as Record<string, unknown>;
      reports.set(String(entry.jobId), entry);
    }
    warn(obj, ...rest);
  }) as typeof child.warn;
  return child;
};

let redis: Redis | null = null;
let worker: Worker | null = null;
const processed: string[] = [];
const failures: Array<{ id?: string; attemptsMade: number; finishedOn?: number; message: string; data?: Record<string, unknown> }> = [];
/** Job IDs whose processor throws an ordinary error. */
const failOtherwise = new Set<string>();
/** Job IDs whose processor throws once and then makes admission refuse the retry. */
const refuseAfterFailure = new Set<string>();

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

test('an issue job whose wait for disk space ran out fails for good on that refusal and stays as a failed job', async t => {
  if (!requireRedis(t)) return;
  const since = Date.now() - 2 * 60 * 60_000;
  const queue = await getIssueQueue();
  // Kept on failure, as under the queue's default options: the failed job stays as evidence.
  await queue.add('processGitHubIssue', issueJob(42, { diskPressureDeferrals: 6, diskPressureSince: since }), { ...jobOptions(42), removeOnFail: false });
  const failure = await until(async () => failures.find(entry => entry.id === jobId(42)), Boolean, 'the final failure');
  assert.ok(failure);
  assert.equal(typeof failure.finishedOn, 'number', 'no BullMQ retry follows');
  assert.equal(failure.attemptsMade, 1);
  // The final refusal carries its measurement: path, free space, reserve, other claims and this job's size.
  assert.match(failure.message, /^Worktree disk pressure: admission reserve unavailable after waiting 120 minutes \(7 refusals\); data retained \(filesystem \S+: free [\d.]+ \w?i?B < required [\d.]+ \w?i?B = reserve [\d.]+ \w?i?B \+ 0 other claims \+ this job [\d.]+ \w?i?B\)$/);
  assert.ok(failure.message.includes(`(filesystem ${path.join(root, 'worktrees')}:`), 'the measured filesystem path is reported');
  // Let the failure handling (the report) finish: it removes nothing.
  await new Promise(resolve => setTimeout(resolve, 500));
  const kept = await jobState(jobId(42));
  assert.equal(kept.state, 'failed', 'the refused job is kept as recoverable evidence');
  assert.ok(kept.job?.failedReason.startsWith('Worktree disk pressure:'));
  assert.equal(failures.filter(entry => entry.id === jobId(42)).length, 1);

  // While it is kept, a relabel under the same job ID is deduplicated against it and does not run.
  process.env.WORKTREE_ADMISSION_RESERVE_BYTES = '1';
  await queue.add('processGitHubIssue', issueJob(42), { ...jobOptions(42), removeOnFail: false });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await jobState(jobId(42))).state, 'failed');
  assert.deepEqual(processed.filter(id => id === jobId(42)), []);

  // The worker's report read that the job is retained, so the comment warns and gives the guarded command.
  const report = await until(async () => reports.get(jobId(42)), Boolean, 'the refusal report');
  assert.equal(report?.retention, 'retained');
  const refused = { id: jobId(42), timestamp: kept.job!.timestamp, data: issueJob(42) };
  const body = diskPressureRefusalCommentBody(refused, { inPlan: false, queueName: GITHUB_ISSUE_QUEUE_NAME, retention: 'retained' });
  assert.match(body, /Relabeling will not retry this issue until the stale job/);
  const commands = [...body.matchAll(/^redis-cli EVAL "([^"]+)" (.+)$/gm)];
  assert.equal(commands.length, 1, body);
  const [, script, args] = commands[0];
  // Built for another instance under the same ID (a replacement's), the command changes nothing.
  const otherInstance = clearFailedJobCommand({ ...refused, timestamp: refused.timestamp + 1 }, GITHUB_ISSUE_QUEUE_NAME)!.split('" ')[1];
  assert.equal(await redis!.call('EVAL', script, ...otherInstance.split(' ')), 0);
  assert.equal((await jobState(jobId(42))).state, 'failed');
  // The command from the comment clears this failed job; the next relabel then runs.
  assert.ok(Number(await redis!.call('EVAL', script, ...args.split(' '))) >= 1, 'the job hash (and its logs, if any) are deleted');
  assert.equal((await jobState(jobId(42))).state, 'absent');
  assert.equal(await redis!.zscore(`bull:${GITHUB_ISSUE_QUEUE_NAME}:failed`, jobId(42)), null);
  await queue.add('processGitHubIssue', issueJob(42), { ...jobOptions(42), removeOnFail: false });
  await until(async () => processed.filter(id => id === jobId(42)).length, count => count === 1, 'the relabelled job to run');
});

test('an issue job removed on failure, as the daemon and the plan route add it, is reported as retried by a relabel', async t => {
  if (!requireRedis(t)) return;
  const queue = await getIssueQueue();
  // The producers' own options: removeOnFail: true.
  await queue.add('processGitHubIssue', issueJob(44, { diskPressureDeferrals: 6, diskPressureSince: Date.now() - 2 * 60 * 60_000 }), jobOptions(44));
  const failure = await until(async () => failures.find(entry => entry.id === jobId(44)), Boolean, 'the final failure');
  const report = await until(async () => reports.get(jobId(44)), Boolean, 'the refusal report');
  assert.equal(report?.retention, 'removed', 'BullMQ deleted the failed job, and the report read that');
  assert.equal((await jobState(jobId(44))).state, 'absent');
  const body = diskPressureRefusalCommentBody({ id: jobId(44), data: issueJob(44) }, { inPlan: false, queueName: GITHUB_ISSUE_QUEUE_NAME, retention: 'removed' });
  assert.match(body, /The refused job was removed from the worker's queue\. To retry once space has been freed on the worker host, remove the `AI` label/);
  assert.doesNotMatch(body, /will not retry|redis-cli/);

  // A relabel enqueues a replacement under the same ID (refused again here, so it waits as a delayed job).
  await queue.add('processGitHubIssue', issueJob(44), jobOptions(44));
  const replacement = await until(() => jobState(jobId(44)), value => value.state === 'delayed', 'the replacement');
  assert.notEqual(replacement.job?.timestamp, undefined);
  // Even the guarded command an operator might hold for the removed instance leaves the replacement intact.
  const removedInstance = clearFailedJobCommand({ id: jobId(44), timestamp: replacement.job!.timestamp - 1, data: {} }, GITHUB_ISSUE_QUEUE_NAME)!;
  const [, script, args] = /^redis-cli EVAL "([^"]+)" (.+)$/.exec(removedInstance)!;
  assert.equal(await redis!.call('EVAL', script, ...args.split(' ')), 0);
  assert.equal((await jobState(jobId(44))).state, 'delayed', 'the replacement keeps its hash and queue membership');
  assert.ok(await redis!.exists(`bull:${GITHUB_ISSUE_QUEUE_NAME}:${jobId(44)}`));
  assert.ok(failure);
  await replacement.job!.remove();
});

test('an issue job that fails for another reason keeps its own retention', async t => {
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
  const body = diskPressureRefusalCommentBody({ data: final.data ?? {} }, { inPlan: false });
  assert.doesNotMatch(body, /nothing was changed/i);
  assert.match(body, /The latest attempt was refused/);
});
