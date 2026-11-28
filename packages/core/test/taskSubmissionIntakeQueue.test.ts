/**
 * A submission's intake job refused by worktree admission on a real Redis
 * server, through the real BullMQ worker that core's createWorker builds: the
 * admission guard runs around the processor, so the processor is never
 * entered. Admission is refused by an injected reserve larger than any disk,
 * not by filling one; the reserve check itself is unchanged.
 * The suite is skipped when Redis is not reachable (set REDIS_HOST /
 * REDIS_PORT; CI starts one with scripts/ci-redis.sh), unless
 * PROPR_REQUIRE_REDIS_INTEGRATION=1, which CI sets so an unreachable Redis
 * fails it instead of silently skipping it. Its queue, owner and job IDs are
 * namespaced by run, and every wait is bounded.
 */
import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { Redis } from 'ioredis';
import type { Worker } from 'bullmq';

const REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT = Number.parseInt(process.env.REDIS_PORT ?? '6379', 10);
const RUN_ID = `${process.pid}-${Date.now()}`;
const OWNER = `itest-intake-${RUN_ID}`;
const ADMISSION = 'Worktree disk pressure: admission reserve unavailable; data retained';
// The refusal carries its measurement: path, free space, reserve, other claims and this job's size.
const MEASUREMENT = String.raw` \(filesystem \S+: free [\d.]+ \w?i?B < required [\d.]+ \w?i?B = reserve [\d.]+ \w?i?B \+ 0 other claims \+ this job [\d.]+ \w?i?B\)`;

// Configure the worker's queue, database and storage before core reads them at import.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-intake-'));
Object.assign(process.env, {
  REDIS_HOST, REDIS_PORT: String(REDIS_PORT),
  GITHUB_ISSUE_QUEUE_NAME: `intake-itest-${RUN_ID}`,
  DB_FILENAME: path.join(root, 'propr.sqlite'), DATA_DIR: root,
  GIT_CLONES_BASE_PATH: path.join(root, 'clones'), GIT_WORKTREES_BASE_PATH: path.join(root, 'worktrees'),
  // Injected: no disk has this much free space, so admission refuses every attempt.
  WORKTREE_ADMISSION_RESERVE_BYTES: String(Number.MAX_SAFE_INTEGER),
  // No wait for disk space: each refusal fails an attempt, so the intake's retries are spent in seconds.
  WORKTREE_DISK_PRESSURE_MAX_WAIT_MS: '0',
});

const { db, closeConnection } = await import('../src/db/connection.js');
const { up } = await import('../src/db/migrations/20260922000000_add_task_submissions.js');
const { up: identityMigration } = await import('../src/db/migrations/20260922010000_preserve_task_submission_identity.js');
const { up: issueDispatches } = await import('../src/db/migrations/20261128000000_create_issue_dispatches.js');
const { enqueueIssueDispatch, findIssueDispatch } = await import('../src/queue/issueDispatch.js');
const { insertTaskSubmission } = await import('../src/services/taskSubmissionService.js');
const { queueSubmissionIntakeEvidence, reconcileSubmissionIntake, submissionIntakeJobId } = await import('../src/services/taskSubmissionIntake.js');
const { createWorker, getIssueQueue, shutdownQueue, GITHUB_ISSUE_QUEUE_NAME } = await import('../src/queue/taskQueue.js');
type TaskSubmission = import('../src/services/taskSubmissionService.js').TaskSubmission;

let redis: Redis | null = null;
let worker: Worker | null = null;
const processed: string[] = [];
const failures: Array<{ attemptsMade: number; finishedOn?: number }> = [];

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
  await up(db);
  await identityMigration(db);
  // A new dispatch is linked to the issue's plan issue, when there is one.
  await db.schema.createTable('plan_issues', table => {
    table.increments('id'); table.string('draft_id'); table.string('repository'); table.integer('issue_number'); table.string('status'); table.timestamp('created_at');
  });
  await issueDispatches(db);
  worker = await createWorker(GITHUB_ISSUE_QUEUE_NAME, async job => { processed.push(String(job.id)); return { status: 'dispatched' }; }, { concurrency: 1 });
  worker.on('failed', job => { if (job) failures.push({ attemptsMade: job.attemptsMade, finishedOn: job.finishedOn }); });
});

after(async () => {
  if (redis) {
    await worker?.close(true);
    const queue = await getIssueQueue();
    await queue.obliterate({ force: true }).catch(() => {});
    // The worker's failure metrics are shared keys: drop only this run's entries.
    for (const entry of await redis.zrange('metrics:ai:log:v1', 0, -1)) if (entry.includes(OWNER)) await redis.zrem('metrics:ai:log:v1', entry);
    for (const entry of await redis.lrange('system:activity:log', 0, -1)) if (entry.includes(OWNER)) await redis.lrem('system:activity:log', 0, entry);
    await shutdownQueue();
    redis.disconnect();
  }
  await closeConnection();
  await fs.remove(root);
});

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

const read = (id: string) => db<TaskSubmission>('task_submissions').where({ id }).first() as Promise<TaskSubmission>;

async function queuedSubmission(repo: string, number: number) {
  const repository = `${OWNER}/${repo}`;
  const row = await insertTaskSubmission(db, { user_id: '297689653', submission_key: `${repo}-key`, payload_hash: 'hash', repository, payload: JSON.stringify({ instruction: 'Audit', trigger: 'AI' }), attachments: '[]' });
  await db('task_submissions').where({ id: row.id }).update({ state: 'queued', issue_number: number, issue_url: `https://github.com/${repository}/issues/${number}` });
  return row.id;
}

const intakeData = (id: string, repo: string, number: number) => ({ repoOwner: OWNER, repoName: repo, number, userId: '297689653', triggeringLabel: 'AI', correlationId: id });

// The route's intake job, as enqueueIssueImplementationJob adds it (its own dispatch and job ID), with a shorter backoff.
async function enqueueIntake(id: string, repo: string, number: number) {
  return enqueueIssueDispatch(await getIssueQueue(), { name: 'processGitHubIssue', data: intakeData(id, repo, number),
    opts: { attempts: 3, backoff: { type: 'exponential', delay: 200 }, removeOnComplete: true, removeOnFail: true } }, { database: db });
}

// An intake job as the route added it before dispatches had rows: one fixed job ID per issue.
async function addIntake(id: string, repo: string, number: number, opts: { delay?: number } = {}) {
  const queue = await getIssueQueue();
  await queue.add('processGitHubIssue', { repoOwner: OWNER, repoName: repo, number, userId: '297689653', triggeringLabel: 'AI', correlationId: id }, {
    jobId: submissionIntakeJobId(OWNER, repo, number), attempts: 3, backoff: { type: 'exponential', delay: 200 }, removeOnComplete: true, removeOnFail: true, ...opts,
  });
}

function requireRedis(t: TestContext): boolean {
  if (!redis) t.skip('Redis is not available for integration testing');
  return Boolean(redis);
}

test('an intake job refused by worktree admission stays queued through its retries and is retryable once they are exhausted', async t => {
  if (!requireRedis(t)) return;
  const id = await queuedSubmission('web', 34);
  const { jobId } = await enqueueIntake(id, 'web', 34);
  // The first failed attempt is delayed for its retry: the submission is not terminal.
  await until(async () => failures.length, count => count >= 1, 'the first failed attempt');
  assert.equal(failures[0].finishedOn, undefined);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await read(id)).state, 'queued');
  const failed = await until(() => read(id), row => row.state === 'failed', 'the exhausted intake to be recorded');
  assert.equal(failures.length, 3);
  assert.equal(typeof failures[2].finishedOn, 'number');
  assert.deepEqual(processed, [], 'admission fails before the processor is entered');
  assert.match(failed.error!, new RegExp(`^Implementation did not start after 3 attempts: ${ADMISSION}${MEASUREMENT}\\. Once the cause is fixed, Retry agent starts this same issue again without creating another\\.$`));
  assert.ok(failed.error!.includes(root), 'the measured filesystem path is reported');
  assert.equal(failed.issue_number, 34);
  assert.equal(failed.task_id, null);
  assert.equal(await (await getIssueQueue()).getJob(jobId), undefined);
  // The worker settles the dispatch alongside the submission, in its failure handler.
  await until(() => findIssueDispatch({ owner: OWNER, repo: 'web', number: 34 }, { database: db }), row => row?.state === 'failed', 'the ended dispatch');
});

test('a legacy submission left queued by an exhausted intake is settled from the queue\'s evidence, and a live one is not', async t => {
  if (!requireRedis(t)) return;
  const id = await queuedSubmission('api', 35);
  await addIntake(id, 'api', 35);
  await until(() => read(id), row => row.state === 'failed', 'the exhausted intake');
  const evidence = queueSubmissionIntakeEvidence(() => getIssueQueue());
  // As before this fix: the queue entry is gone and the submission still reads queued, with no error.
  await until(async () => evidence.failures(await read(id)), value => value?.failures === 3, 'the recorded failures');
  await db('task_submissions').where({ id }).update({ state: 'queued', error: null });
  // A delivery re-added under the same job ID, waiting on its delay, is live: nothing is inferred.
  await addIntake(id, 'api', 35, { delay: 60_000 });
  assert.equal((await reconcileSubmissionIntake(db, await read(id), evidence)).state, 'queued');
  await (await getIssueQueue()).remove(submissionIntakeJobId(OWNER, 'api', 35));
  const settled = await reconcileSubmissionIntake(db, await read(id), evidence);
  assert.equal(settled.state, 'failed');
  // The failure log keeps the whole measurement, not a prefix cut inside it.
  assert.match(settled.error!, new RegExp(`^Implementation did not start after 3 attempts: ${ADMISSION}${MEASUREMENT}\\. Once the cause`));
  assert.deepEqual(processed, []);
});
