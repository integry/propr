/**
 * Issue retries against a real Redis server and a real BullMQ queue and worker.
 *
 * The other follow-up suites simulate the queue and Redis. This suite runs
 * the route and the matrix dispatcher on BullMQ's actual job-ID
 * deduplication, retries and job removal, and on Redis's actual claim and
 * outcome keys: repeated issue-only retries on one job ID, a delivery while a
 * retry's job waits, and a job carrying a confirmation that exhausts its
 * attempts. GitHub and the request records stay simulated. It is skipped when
 * Redis is not reachable (set REDIS_HOST / REDIS_PORT; CI starts one with
 * scripts/ci-redis.sh), unless PROPR_REQUIRE_REDIS_INTEGRATION=1, which CI
 * sets so an unreachable Redis fails the suite instead of silently skipping it.
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Redis } from 'ioredis';
import { Queue, Worker, type Job } from 'bullmq';
import type { IssueJobData, JobResult } from '../../core/src/queue/taskQueue.types.js';
import { state, postFollowup, useLiveQueue, FIRST_COMMENT_ID } from './taskFollowupFixture.js';
import { openRequests, promptFor, onIssue, takeRecordsOffline, dispatcherDeps, retryRequestStoreFor, dedupKey } from './taskFollowupIssueDispatch.js';

const { handleDispatchWithDeps } = await import('../../../src/jobs/issueJobDispatcher.js');
const { redisRetryOutcomeEvidence } = await import('../../core/src/services/issueRetryRequest.js');
const { processDetectedIssue } = await import('../../core/src/daemon/issueDetection.js');

const REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT = Number.parseInt(process.env.REDIS_PORT ?? '6379', 10);
const RUN_ID = `${process.pid}-${Date.now()}`;
const JOB_ID = 'issue-integry-propr-14';
const ORIGINAL = 'Retry with the original instructions';
const OUTCOME_KEYS = 'issue:retry-outcome:*';

function connect(): Redis {
  const client = new Redis({
    host: REDIS_HOST, port: REDIS_PORT, connectTimeout: 250, enableReadyCheck: false,
    lazyConnect: true, maxRetriesPerRequest: null, retryStrategy: () => null,
  });
  client.on('error', () => {});
  return client;
}

const redis = connect();
const reachable = await redis.connect().then(() => redis.ping()).then(() => true, () => false);
if (!reachable && process.env.PROPR_REQUIRE_REDIS_INTEGRATION === '1') {
  throw new Error(`Redis is required for the issue retry queue integration suite but is not reachable at ${REDIS_HOST}:${REDIS_PORT}`);
}
const skip = reachable ? false : `Redis is not reachable at ${REDIS_HOST}:${REDIS_PORT}`;
const clients: Redis[] = [];

after(async () => {
  for (const client of [redis, ...clients]) client.disconnect();
});

/** Drops the claim and outcome keys of issue 14, as their expiry or an earlier run left them. */
async function clearIssueKeys() {
  const outcomes = await redis.keys(OUTCOME_KEYS);
  await redis.del(dedupKey, ...outcomes);
}

type Settled = { event: 'completed'; job: Job<IssueJobData>; result: JobResult } | { event: 'failed'; job: Job<IssueJobData>; error: Error };

/** A real queue the route and deliveries use, and the worker that dispatches its jobs, in arrival order. */
async function withLiveQueue(body: (live: {
  queue: Queue; children: Array<{ jobId: string; data: IssueJobData }>; startWorker: () => void; settled: () => Promise<Settled>;
}) => Promise<void>) {
  await clearIssueKeys();
  const queue = new Queue(`issue-retry-itest-${RUN_ID}-${Math.random().toString(36).slice(2)}`, { connection: redis });
  const children: Array<{ jobId: string; data: IssueJobData }> = [];
  const store = retryRequestStoreFor(redisRetryOutcomeEvidence(() => redis));
  const outcomes: Settled[] = [];
  const waiting: Array<(settled: Settled) => void> = [];
  const settle = (settled: Settled) => { const next = waiting.shift(); if (next) next(settled); else outcomes.push(settled); };
  let worker: Worker | undefined;
  useLiveQueue(queue);
  try {
    await body({
      queue, children,
      startWorker: () => {
        const connection = connect();
        clients.push(connection);
        worker = new Worker<IssueJobData, JobResult>(queue.name, job => handleDispatchWithDeps(job, dispatcherDeps(children, store)), { connection });
        worker.on('completed', (job, result) => settle({ event: 'completed', job, result }));
        worker.on('failed', (job, error) => { if (job) settle({ event: 'failed', job, error }); });
      },
      settled: () => {
        const ready = outcomes.shift();
        return ready ? Promise.resolve(ready) : new Promise(resolve => { waiting.push(resolve); });
      },
    });
  } finally {
    useLiveQueue(null);
    await worker?.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await clearIssueKeys();
  }
}

/** The issue as the daemon's poll detects it, through the real queue and Redis. */
const livePoll = () => processDetectedIssue({
  id: 1014, number: 14, title: 'Issue', url: 'https://github.com/integry/propr/issues/14', repoOwner: 'integry', repoName: 'propr',
  labels: [...state.issueLabels], createdAt: '2026-10-15T09:00:00Z', updatedAt: '2026-10-15T10:00:01Z',
  triggeredBy: 'propr-dev[bot]', triggeredById: '99', source: 'polling',
}, 'live-poll', redis);

/** The settled job dispatched a run carrying `requester`'s request and instructions. */
async function assertDispatched(settled: Settled, child: { data: IssueJobData } | undefined, { requester, commentId, instructions }: { requester: string; commentId: number; instructions: RegExp }) {
  assert.equal(settled.event, 'completed', settled.event === 'failed' ? settled.error.message : undefined);
  assert.equal(settled.event === 'completed' && settled.result.status, 'dispatched');
  assert.ok(child);
  assert.equal(child.data.userId, requester);
  assert.equal(child.data.retryRequesterId, requester);
  assert.equal(child.data.retryCommentId, commentId);
  assert.match(await promptFor(child.data), instructions);
}

test('repeated issue-only retries each run for their own requester on the job ID the previous run freed', { skip, timeout: 30_000 }, async () => {
  await withLiveQueue(async live => {
    live.startWorker();
    const first = await postFollowup({ body: 'First instructions' }, 'failed-issue-task');
    assert.equal(first.json.state, 'queued');
    assert.equal(first.json.jobId, JOB_ID);
    await assertDispatched(await live.settled(), live.children[0], { requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
    assert.equal(await live.queue.getJob(JOB_ID), undefined, 'the completed job is removed, freeing its ID');
    assert.deepEqual(await openRequests(), []);

    // The run failed again; once the claim expires another user retries, on the same job ID.
    state.now += 60_000;
    await redis.del(dedupKey);
    const second = await postFollowup({ body: 'Second instructions' }, 'failed-issue-task', 'user-2');
    assert.equal(second.json.state, 'queued');
    assert.equal(second.json.jobId, JOB_ID);
    await assertDispatched(await live.settled(), live.children[1], { requester: 'user-2', commentId: FIRST_COMMENT_ID + 1, instructions: /Second instructions/ });
    assert.doesNotMatch(await promptFor(live.children[1].data), /First instructions/);
    assert.equal(live.children.length, 2);
    assert.deepEqual(await openRequests(), []);
    const counts = await live.queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    assert.deepEqual(Object.entries(counts).filter(([, jobs]) => jobs > 0), [], 'no job is left behind');
  });
});

test('a delivery while an issue-only retry\'s job waits does not replace it, and the one job runs for the requester', { skip, timeout: 30_000 }, async () => {
  await withLiveQueue(async live => {
    assert.equal((await postFollowup({ body: ORIGINAL }, 'failed-issue-task')).json.state, 'queued');
    assert.equal((await live.queue.getJob(JOB_ID))?.data.retryCommentId, FIRST_COMMENT_ID);

    // Past the claim, a poll finds the job waiting; an add that reaches BullMQ with its ID keeps it too.
    await redis.del(dedupKey);
    assert.deepEqual(await livePoll(), { status: 'ignored', reason: 'job_already_queued' });
    await live.queue.add('processGitHubIssue', { repoOwner: 'integry', repoName: 'propr', number: 14, userId: '99', triggeringLabel: 'AI' }, { jobId: JOB_ID });
    const kept = await live.queue.getJob(JOB_ID);
    assert.deepEqual([kept?.data.retryRequesterId, kept?.data.retryCommentId], ['user-1', FIRST_COMMENT_ID]);
    assert.equal(await live.queue.getWaitingCount(), 1);

    live.startWorker();
    await assertDispatched(await live.settled(), live.children[0], { requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: new RegExp(ORIGINAL) });
    assert.equal(live.children.length, 1);
    assert.deepEqual(await openRequests(), []);
  });
});

for (const [routing, backed] of [['a submission-backed', true], ['an issue-only', false]] as const) {
  test(`${routing} job carrying a confirmation that exhausts its attempts while the database is down is removed, and the outcome Redis kept runs the request on the next poll`, { skip, timeout: 60_000 }, async () => {
    await onIssue(backed, `live-exhausted-${backed}`, async () => {
      await withLiveQueue(async live => {
        // GitHub confirms the write while the request records are offline; the job carrying it is queued.
        let restore: () => Promise<void> = async () => undefined;
        state.onLabelAdd = async () => { restore = await takeRecordsOffline(); };
        const result = await postFollowup({ body: ORIGINAL }, 'failed-issue-task');
        state.onLabelAdd = undefined;
        assert.equal(result.json.state, 'unknown');
        const own = state.timeline.at(-1)!.id;
        const outcomes = await redis.keys(OUTCOME_KEYS);
        assert.equal(outcomes.length, 1);
        assert.equal(await redis.get(outcomes[0]), 'possible', 'the confirmed outcome is kept in Redis without expiry');
        assert.equal(await redis.ttl(outcomes[0]), -1);
        // The API process restarts, losing its outcome retry.
        state.outcomeRetries = [];

        live.startWorker();
        const attempts: Settled[] = [];
        for (let attempt = 0; attempt < 3; attempt++) attempts.push(await live.settled());
        assert.deepEqual(attempts.map(settled => settled.event), ['failed', 'failed', 'failed']);
        assert.equal(attempts[2].job.attemptsMade, 3);
        assert.equal(await live.queue.getJob(JOB_ID), undefined, 'the exhausted job is removed');
        assert.equal(live.children.length, 0);
        assert.equal(await redis.get(outcomes[0]), 'possible', 'the outcome outlives the job');

        await restore();
        assert.deepEqual((await openRequests()).map(held => held.publication), ['pending']);
        await redis.del(dedupKey);
        assert.equal((await livePoll()).status, 'accepted', 'a fresh job takes the freed ID');
        await assertDispatched(await live.settled(), live.children[0], { requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: new RegExp(ORIGINAL) });
        if (backed) assert.equal(live.children[0].jobId, `issue-integry-propr-14-claude-claude-opus-5-5-main-trigger-${own}`);
        assert.deepEqual(await redis.keys(OUTCOME_KEYS), [], 'the outcome is dropped once recorded');
        assert.deepEqual(await openRequests(), []);
      });
    });
  });
}
