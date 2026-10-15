/**
 * Issue retries against a real Redis server and a real BullMQ queue and worker.
 *
 * The other follow-up suites simulate the queue and Redis. This suite runs
 * the route, the matrix dispatcher and the child jobs it enqueues on BullMQ's
 * actual job-ID deduplication, retries and job removal, and on Redis's actual
 * claim and outcome keys: repeated retries through their actual child runs, a
 * delivery while a retry's job waits, and a job carrying a confirmation that
 * exhausts its attempts. GitHub, the request records and the child runs'
 * agent stay simulated: a child run only reads the prompt it would be given.
 * It is skipped when Redis is not reachable (set REDIS_HOST / REDIS_PORT; CI
 * starts one with scripts/ci-redis.sh), unless
 * PROPR_REQUIRE_REDIS_INTEGRATION=1, which CI sets so an unreachable Redis
 * fails the suite instead of silently skipping it.
 *
 * The configured Redis may be shared, so every key the suite writes lives in
 * a namespace of its own run: the route's, deliveries' and dispatcher's claim
 * and outcome keys through a key-prefixed client, and the queue under a BullMQ
 * prefix in that namespace. Cleanup deletes only that namespace's keys, and
 * unrelated claim and outcome sentinels outside it are checked to be unchanged.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
const RUN_ID = `${process.pid}-${Date.now()}-${randomUUID()}`;
// The suite's own keys; nothing outside this namespace is written or deleted, but the sentinels.
const NAMESPACE = `propr-itest:issue-retry:${RUN_ID}:`;
const JOB_ID = 'issue-integry-propr-14';
const CHILD_ID = 'issue-integry-propr-14-claude-claude-opus-5-5-main';
const ORIGINAL = 'Retry with the original instructions';
// Unrelated recovery evidence and a duplicate claim, outside the namespace, as another request or process
// using the same Redis would keep them; they expire on their own should the suite be killed.
const SENTINEL_TTL_MS = 60 * 60_000;
const SENTINELS: Record<string, string> = {
  [`issue:retry-outcome:sentinel-${RUN_ID}:1760522400000`]: 'possible',
  [`issue:dedup:propr-itest-sentinel-${RUN_ID}:propr:14`]: 'sentinel-claim',
};

function connect(keyPrefix?: string): Redis {
  const client = new Redis({
    host: REDIS_HOST, port: REDIS_PORT, connectTimeout: 250, enableReadyCheck: false,
    lazyConnect: true, maxRetriesPerRequest: null, retryStrategy: () => null, ...(keyPrefix ? { keyPrefix } : {}),
  });
  client.on('error', () => {});
  return client;
}

// `raw` reads the namespace and the sentinels by full key, and carries BullMQ, which takes its own prefix;
// `owned` is the route's, deliveries' and dispatcher's Redis, whose every key is in the namespace.
const raw = connect();
const owned = connect(NAMESPACE);
const reachable = await raw.connect().then(() => owned.connect()).then(() => raw.ping()).then(() => true, () => false);
if (!reachable && process.env.PROPR_REQUIRE_REDIS_INTEGRATION === '1') {
  throw new Error(`Redis is required for the issue retry queue integration suite but is not reachable at ${REDIS_HOST}:${REDIS_PORT}`);
}
const skip = reachable ? false : `Redis is not reachable at ${REDIS_HOST}:${REDIS_PORT}`;
const clients: Redis[] = [];

/** The full names of the suite's keys matching `pattern` within its namespace. */
async function ownedKeys(pattern = '*'): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await raw.scan(cursor, 'MATCH', `${NAMESPACE}${pattern}`, 'COUNT', 1000);
    keys.push(...batch);
    cursor = next;
  } while (cursor !== '0');
  return keys;
}

/** Deletes the suite's keys matching `pattern`, and no other. */
async function clearOwnedKeys(pattern = '*') {
  const keys = await ownedKeys(pattern);
  if (keys.length > 0) await raw.del(...keys);
}

const outcomeKeys = () => ownedKeys('issue:retry-outcome:*');

async function assertSentinelsUnchanged() {
  for (const [key, value] of Object.entries(SENTINELS)) {
    assert.equal(await raw.get(key), value, `the unrelated ${key} is kept`);
    const ttl = await raw.pttl(key);
    assert.ok(ttl > 0 && ttl <= SENTINEL_TTL_MS, `the unrelated ${key} keeps its expiry`);
  }
}

if (reachable) {
  for (const [key, value] of Object.entries(SENTINELS)) assert.equal(await raw.set(key, value, 'PX', SENTINEL_TTL_MS, 'NX'), 'OK');
}

after(async () => {
  try {
    if (reachable) {
      await clearOwnedKeys();
      await raw.del(...Object.keys(SENTINELS));
    }
  } finally {
    for (const client of [raw, owned, ...clients]) client.disconnect();
  }
});

type Settled = { event: 'completed'; job: Job<IssueJobData>; result: JobResult } | { event: 'failed'; job: Job<IssueJobData>; error: Error };
/** A child job's actual run: the job, and the prompt its agent would have been given. */
interface ChildRun { jobId: string; data: IssueJobData; prompt: string }

/** Settled jobs in arrival order, each taken once by a waiter. */
function channel() {
  const ready: Settled[] = [];
  const waiting: Array<(settled: Settled) => void> = [];
  return {
    push: (settled: Settled) => { const next = waiting.shift(); if (next) next(settled); else ready.push(settled); },
    next: (): Promise<Settled> => {
      const settled = ready.shift();
      return settled ? Promise.resolve(settled) : new Promise(resolve => { waiting.push(resolve); });
    },
  };
}

interface LiveQueue {
  queue: Queue;
  /** Every child the dispatcher added, deduplicated by BullMQ or not. */
  children: Array<{ jobId: string; data: IssueJobData }>;
  /** The child jobs BullMQ actually ran. */
  runs: ChildRun[];
  startWorker: () => void;
  /** The next parent (dispatcher) job to settle. */
  settled: () => Promise<Settled>;
  /** The next child job to settle. */
  childSettled: () => Promise<Settled>;
  /** Holds every child run that starts until the returned release runs. */
  holdChildren: () => () => void;
  /** Waits until no job is waiting, delayed or running. */
  drained: () => Promise<void>;
  /** Waits until the job is in `jobState`. */
  reaches: (jobId: string, jobState: string) => Promise<void>;
}

/** Polls `done` until it holds, failing with `what` after ten seconds. */
async function until(done: () => Promise<boolean>, what: string) {
  for (let polls = 0; polls < 200; polls++) {
    if (await done()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(what);
}

/**
 * A real queue the route, deliveries and the dispatcher's children use, and a
 * worker that runs its dispatcher jobs and child jobs, as the issue worker
 * routes them, in arrival order.
 */
async function withLiveQueue(body: (live: LiveQueue) => Promise<void>) {
  await clearOwnedKeys('issue:*');
  const prefix = `${NAMESPACE}bull`;
  const queue = new Queue(`issue-retry-itest-${randomUUID()}`, { connection: raw, prefix });
  const children: LiveQueue['children'] = [];
  const runs: ChildRun[] = [];
  const store = retryRequestStoreFor(redisRetryOutcomeEvidence(() => owned));
  const deps = {
    ...dispatcherDeps(children, store),
    issueQueue: {
      add: async (name: string, data: IssueJobData, options: { jobId: string }) => {
        children.push({ jobId: options.jobId, data });
        return queue.add(name, data, options);
      },
    },
  } as unknown as Parameters<typeof handleDispatchWithDeps>[1];
  const parents = channel();
  const childOutcomes = channel();
  let hold: Promise<void> | null = null;
  let releaseHold = () => {};
  let worker: Worker | undefined;
  // The route takes its Redis from the issue queue; it is the namespaced client, while BullMQ keeps its own.
  useLiveQueue(new Proxy(queue, { get: (target, prop) => {
    if (prop === 'client') return Promise.resolve(owned);
    const value = Reflect.get(target, prop, target) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  } }));
  const runChild = async (job: Job<IssueJobData>): Promise<JobResult> => {
    await hold;
    runs.push({ jobId: job.id!, data: job.data, prompt: await promptFor(job.data) });
    return { status: 'completed', issueNumber: job.data.number };
  };
  try {
    await body({
      queue, children, runs,
      startWorker: () => {
        const connection = connect();
        clients.push(connection);
        worker = new Worker<IssueJobData, JobResult>(queue.name, job => job.data.isChildJob ? runChild(job) : handleDispatchWithDeps(job, deps),
          { connection, prefix, concurrency: 2 });
        worker.on('completed', (job, result) => (job.data.isChildJob ? childOutcomes : parents).push({ event: 'completed', job, result }));
        worker.on('failed', (job, error) => { if (job) (job.data.isChildJob ? childOutcomes : parents).push({ event: 'failed', job, error }); });
      },
      settled: parents.next,
      childSettled: childOutcomes.next,
      holdChildren: () => {
        hold = new Promise(resolve => { releaseHold = () => { hold = null; resolve(); }; });
        return releaseHold;
      },
      drained: () => until(async () => Object.values(await queue.getJobCounts('waiting', 'delayed', 'active')).every(jobs => jobs === 0),
        'the queue did not drain'),
      reaches: (jobId, jobState) => until(async () => await (await queue.getJob(jobId))?.getState() === jobState, `${jobId} did not become ${jobState}`),
    });
  } finally {
    useLiveQueue(null);
    // A held child would keep the worker from closing after a failed assertion.
    releaseHold();
    await worker?.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await clearOwnedKeys();
  }
  assert.deepEqual(await ownedKeys(), [], 'the suite leaves none of its keys behind');
  await assertSentinelsUnchanged();
}

/** The issue as the daemon's poll detects it, through the real queue and Redis. */
const livePoll = () => processDetectedIssue({
  id: 1014, number: 14, title: 'Issue', url: 'https://github.com/integry/propr/issues/14', repoOwner: 'integry', repoName: 'propr',
  labels: [...state.issueLabels], createdAt: '2026-10-15T09:00:00Z', updatedAt: '2026-10-15T10:00:01Z',
  triggeredBy: 'propr-dev[bot]', triggeredById: '99', source: 'polling',
}, 'live-poll', owned);

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

/** The child job ran once, for `requester`'s request with its instructions and none of `foreign`. */
function assertChildRun(run: ChildRun | undefined, { jobId, requester, commentId, instructions, foreign }: {
  jobId: string; requester: string; commentId: number; instructions: RegExp; foreign?: RegExp;
}) {
  assert.ok(run);
  assert.equal(run.jobId, jobId);
  assert.deepEqual([run.data.userId, run.data.retryRequesterId, run.data.retryCommentId], [requester, requester, commentId]);
  assert.match(run.prompt, instructions);
  if (foreign) assert.doesNotMatch(run.prompt, foreign);
}

for (const [routing, backed] of [['submission-backed', true], ['issue-only', false]] as const) {
  test(`repeated ${routing} retries each run their actual child once for their own requester, through a parent dispatch retry`, { skip, timeout: 60_000 }, async () => {
    await onIssue(backed, `live-repeated-${backed}`, async () => {
      await withLiveQueue(async live => {
        live.startWorker();
        // The first retry's child is held running while its dispatch fails to record the request consumed.
        const release = live.holdChildren();
        state.consumeFails = true;
        const first = await postFollowup({ body: 'First instructions' }, 'failed-issue-task');
        assert.equal(first.json.state, 'queued');
        assert.equal(first.json.jobId, JOB_ID);
        assert.equal(first.json.commentId, FIRST_COMMENT_ID);
        assert.ok(await owned.exists(dedupKey), 'the route\'s claim is in the suite\'s namespace');
        const firstTrigger = state.timeline.at(-1)!.id;
        const firstChild = backed ? `${CHILD_ID}-trigger-${firstTrigger}` : CHILD_ID;
        const failed = await live.settled();
        assert.equal(failed.event, 'failed');
        assert.match(failed.event === 'failed' ? failed.error.message : '', /database is locked/);
        state.consumeFails = false;
        await live.reaches(firstChild, 'active');

        // BullMQ retries the dispatch after its backoff, while the child still runs.
        const retried = await live.settled();
        assert.equal(retried.event, 'completed', retried.event === 'failed' ? retried.error.message : undefined);
        if (backed) {
          // Its receipt shows the request was carried, so it is recorded consumed and nothing is added again.
          assert.deepEqual(retried.event === 'completed' && retried.result, { status: 'skipped', reason: 'submission_already_dispatched', issueNumber: 14 });
          assert.deepEqual(live.children.map(child => child.jobId), [firstChild]);
        } else {
          // The retry re-adds the same child, which BullMQ deduplicates by its ID while it runs.
          assert.equal(retried.event === 'completed' && retried.result.status, 'dispatched');
          assert.deepEqual(live.children.map(child => child.jobId), [firstChild, firstChild]);
        }
        assert.deepEqual(await openRequests(), []);
        release();
        assert.equal((await live.childSettled()).event, 'completed');
        await live.drained();
        assert.equal(live.runs.length, 1, 'the request\'s child ran once');
        assertChildRun(live.runs[0], { jobId: firstChild, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
        assert.equal(await live.queue.getJob(JOB_ID), undefined, 'the completed dispatcher job is removed, freeing its ID');
        if (backed) assert.equal(await (await live.queue.getJob(firstChild))?.getState(), 'completed', 'a submission\'s child is kept as its receipt');
        else assert.equal(await live.queue.getJob(firstChild), undefined, 'an issue-only child is removed, freeing its ID');

        // The run failed again; once the claim expires another user retries, on the same dispatcher job ID.
        state.now += 60_000;
        await owned.del(dedupKey);
        const second = await postFollowup({ body: 'Second instructions' }, 'failed-issue-task', 'user-2');
        assert.equal(second.json.state, 'queued');
        assert.equal(second.json.jobId, JOB_ID);
        const secondChild = backed ? `${CHILD_ID}-trigger-${state.timeline.at(-1)!.id}` : CHILD_ID;
        await assertDispatched(await live.settled(), live.children.at(-1), { requester: 'user-2', commentId: FIRST_COMMENT_ID + 1, instructions: /Second instructions/ });
        assert.equal((await live.childSettled()).event, 'completed');
        await live.drained();
        assert.equal(live.runs.length, 2);
        assertChildRun(live.runs[1], {
          jobId: secondChild, requester: 'user-2', commentId: FIRST_COMMENT_ID + 1, instructions: /Second instructions/, foreign: /First instructions/,
        });
        if (backed) assert.notEqual(secondChild, firstChild, 'each retry of a submission runs a child of its own trigger');
        assert.deepEqual(await openRequests(), []);
        const counts = await live.queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
        assert.deepEqual(Object.entries(counts).filter(([, jobs]) => jobs > 0), [], 'no job is left behind');
      });
    });
  });
}

test('a delivery while an issue-only retry\'s job waits does not replace it, and the one job runs for the requester', { skip, timeout: 30_000 }, async () => {
  await withLiveQueue(async live => {
    assert.equal((await postFollowup({ body: ORIGINAL }, 'failed-issue-task')).json.state, 'queued');
    assert.equal((await live.queue.getJob(JOB_ID))?.data.retryCommentId, FIRST_COMMENT_ID);

    // Past the claim, a poll finds the job waiting; an add that reaches BullMQ with its ID keeps it too.
    await owned.del(dedupKey);
    assert.deepEqual(await livePoll(), { status: 'ignored', reason: 'job_already_queued' });
    await live.queue.add('processGitHubIssue', { repoOwner: 'integry', repoName: 'propr', number: 14, userId: '99', triggeringLabel: 'AI' }, { jobId: JOB_ID });
    const kept = await live.queue.getJob(JOB_ID);
    assert.deepEqual([kept?.data.retryRequesterId, kept?.data.retryCommentId], ['user-1', FIRST_COMMENT_ID]);
    assert.equal(await live.queue.getWaitingCount(), 1);

    live.startWorker();
    await assertDispatched(await live.settled(), live.children[0], { requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: new RegExp(ORIGINAL) });
    assert.equal(live.children.length, 1);
    await live.childSettled();
    assertChildRun(live.runs[0], { jobId: CHILD_ID, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: new RegExp(ORIGINAL) });
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
        const outcomes = await outcomeKeys();
        assert.equal(outcomes.length, 1);
        assert.equal(await raw.get(outcomes[0]), 'possible', 'the confirmed outcome is kept in Redis without expiry');
        assert.equal(await raw.ttl(outcomes[0]), -1);
        // The API process restarts, losing its outcome retry.
        state.outcomeRetries = [];

        live.startWorker();
        const attempts: Settled[] = [];
        for (let attempt = 0; attempt < 3; attempt++) attempts.push(await live.settled());
        assert.deepEqual(attempts.map(settled => settled.event), ['failed', 'failed', 'failed']);
        assert.equal(attempts[2].job.attemptsMade, 3);
        assert.equal(await live.queue.getJob(JOB_ID), undefined, 'the exhausted job is removed');
        assert.equal(live.children.length, 0);
        assert.equal(await raw.get(outcomes[0]), 'possible', 'the outcome outlives the job');

        await restore();
        assert.deepEqual((await openRequests()).map(held => held.publication), ['pending']);
        await owned.del(dedupKey);
        assert.equal((await livePoll()).status, 'accepted', 'a fresh job takes the freed ID');
        await assertDispatched(await live.settled(), live.children[0], { requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: new RegExp(ORIGINAL) });
        if (backed) assert.equal(live.children[0].jobId, `${CHILD_ID}-trigger-${own}`);
        await live.childSettled();
        assertChildRun(live.runs[0], { jobId: live.children[0].jobId, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: new RegExp(ORIGINAL) });
        assert.deepEqual(await outcomeKeys(), [], 'the outcome is dropped once recorded');
        assert.deepEqual(await openRequests(), []);
      });
    });
  });
}
