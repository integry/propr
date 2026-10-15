/**
 * Issue retries against a real Redis server and a real BullMQ queue and worker.
 *
 * The other follow-up suites simulate the queue and Redis. This suite runs
 * the route, the matrix dispatcher and the child jobs it enqueues on BullMQ's
 * actual job-ID deduplication, retries and job removal, and on Redis's actual
 * claim and outcome keys and run records: repeated retries through their
 * actual child runs, children that complete or fail before their dispatch's
 * retry, or while no dispatch attempt can record them, recovered a day later,
 * a request whose follow-up passed its checks while another request's child
 * runs, a child ID another payload holds, restarts of runs that were and were
 * never added, a delivery while a retry's job waits, a job carrying a
 * confirmation that exhausts its attempts, a dispatch that resumes after
 * another worker's stalled check recovered its job and ran the request's
 * child, a fresh poll after the request's run, and the run's transaction
 * itself: replies lost after or before Redis ran it, adds that fail inside it,
 * adds that write a job but never queue it, a partly accepted matrix, foreign
 * payloads, reused request IDs and children that cannot be built. GitHub, the request records and the child runs'
 * agent stay simulated: a child run only reads the prompt it would be given.
 * Every wait is bounded, so a run that never settles fails its test, whose
 * cleanup still closes its workers and drops its keys.
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
import { Queue, Worker, type Job, type WorkerOptions } from 'bullmq';
import type { IssueJobData, JobResult } from '../../core/src/queue/taskQueue.types.js';
import { state, postFollowup, useLiveQueue, applyLabels, FIRST_COMMENT_ID, HUMAN_ACTOR_ID } from './taskFollowupFixture.js';
import { openRequests, promptFor, onIssue, takeRecordsOffline, dispatcherDeps, retryRequestStoreFor, dedupKey, requestChildId, postedComments } from './taskFollowupIssueDispatch.js';

const { handleDispatchWithDeps } = await import('../../../src/jobs/issueJobDispatcher.js');
const { redisRetryOutcomeEvidence } = await import('../../core/src/services/issueRetryRequest.js');
const { enqueueIssueRetryRun, queueRetryRunEvidence } = await import('../../core/src/services/issueRetryRun.js');
type RetryRunChild = import('../../core/src/services/issueRetryRun.js').RetryRunChild;
const { processDetectedIssue } = await import('../../core/src/daemon/issueDetection.js');

const REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT = Number.parseInt(process.env.REDIS_PORT ?? '6379', 10);
const RUN_ID = `${process.pid}-${Date.now()}-${randomUUID()}`;
// The suite's own keys; nothing outside this namespace is written or deleted, but the sentinels.
const NAMESPACE = `propr-itest:issue-retry:${RUN_ID}:`;
const JOB_ID = 'issue-integry-propr-14';
const ORIGINAL = 'Retry with the original instructions';
const DAY_MS = 24 * 60 * 60_000;
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
/** The queue's records of requested retries' runs, under its BullMQ prefix in the namespace, that are not retired. */
async function runRecords(): Promise<string[]> {
  const records: string[] = [];
  for (const key of await ownedKeys('bull:*:retry-run:*')) if (!await raw.hexists(key, 'consumed')) records.push(key);
  return records;
}
/** The records of runs whose requests were recorded consumed, kept as their tombstones. */
async function retiredRecords(): Promise<string[]> {
  const records: string[] = [];
  for (const key of await ownedKeys('bull:*:retry-run:*')) if (await raw.hexists(key, 'consumed')) records.push(key);
  return records;
}

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

// How long a test waits for a job to settle before it fails, well within its own timeout, so its
// cleanup closes the worker and drops its keys instead of leaving them to the next test.
const SETTLE_TIMEOUT_MS = 15_000;

/** Settled jobs in arrival order, each taken once by a waiter, or a failure when none settles in time. */
function channel(what: string) {
  const ready: Settled[] = [];
  const waiting: Array<(settled: Settled) => void> = [];
  return {
    push: (settled: Settled) => { const next = waiting.shift(); if (next) next(settled); else ready.push(settled); },
    next: (): Promise<Settled> => {
      const settled = ready.shift();
      if (settled) return Promise.resolve(settled);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(take), 1);
          reject(new Error(`No ${what} job settled within ${SETTLE_TIMEOUT_MS}ms`));
        }, SETTLE_TIMEOUT_MS);
        const take = (next: Settled) => { clearTimeout(timer); resolve(next); };
        waiting.push(take);
      });
    },
    /** Settled jobs no waiter took. */
    pending: () => ready.length,
  };
}

interface LiveQueue {
  queue: Queue;
  /** Every child the dispatcher added, deduplicated by BullMQ or not. */
  children: Array<{ jobId: string; data: IssueJobData }>;
  /** The child jobs BullMQ actually ran. */
  runs: ChildRun[];
  /** What each dispatch the workers ran returned or threw, as it returned, whether or not its job still held its lock. */
  dispatches: Array<JobResult | Error>;
  /** The jobs the workers' stalled checks moved back to wait. */
  stalls: string[];
  /** Starts a worker, with `options` over the suite's; the latest started is the one `restartWorker` restarts. */
  startWorker: (options?: Partial<WorkerOptions>) => Worker;
  /** Closes the worker, as when the worker process stops, and starts a fresh one. */
  restartWorker: () => Promise<void>;
  /** The next parent (dispatcher) job to settle. */
  settled: () => Promise<Settled>;
  /** The next child job to settle. */
  childSettled: () => Promise<Settled>;
  /** Holds every child run that starts until the returned release runs. */
  holdChildren: () => () => void;
  /** Whether each child run that starts fails right away, as on an agent authentication failure. */
  failChildren: (fail: boolean) => void;
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

// The queue the next requested run is added through, in place of the real one, once.
let nextRunQueue: ((queue: Queue) => Queue) | undefined;

/**
 * The queue seen through a connection that loses the reply to every
 * transaction: after Redis ran it, or before it reached Redis at all.
 */
function replyLosingQueue(queue: Queue, ran: boolean): Queue {
  const bind = (target: object, prop: string | symbol) => {
    const value = Reflect.get(target, prop, target) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  };
  const losing = (client: object) => new Proxy(client, { get: (target, prop) => prop !== 'multi' ? bind(target, prop) : () => {
    const transaction = (target as { multi(): { exec(): Promise<unknown> } }).multi();
    const exec = transaction.exec.bind(transaction);
    transaction.exec = async () => {
      if (ran) await exec();
      throw new Error(ran ? 'Connection lost after the transaction ran' : 'Connection lost before the transaction was sent');
    };
    return transaction;
  } });
  return new Proxy(queue, { get: (target, prop) => prop === 'client' ? target.client.then(losing) : bind(target, prop) });
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
  const dispatches: Array<JobResult | Error> = [];
  const stalls: string[] = [];
  // Runs are added to the real queue, with their record, in one transaction; the storage lifecycle guard is the production queue's.
  const store = retryRequestStoreFor(redisRetryOutcomeEvidence(() => owned), (held, runChildren, receiptEventId) => {
    const through = nextRunQueue?.(queue) ?? queue;
    nextRunQueue = undefined;
    return enqueueIssueRetryRun(through, held, runChildren, { receiptEventId, use: run => run() });
  });
  const deps = {
    ...dispatcherDeps(children, store),
    issueQueue: {
      add: async (name: string, data: IssueJobData, options: { jobId: string }) => {
        children.push({ jobId: options.jobId, data });
        return queue.add(name, data, options);
      },
    },
  } as unknown as Parameters<typeof handleDispatchWithDeps>[1];
  const parents = channel('parent');
  const childOutcomes = channel('child');
  let hold: Promise<void> | null = null;
  let releaseHold = () => {};
  let childrenFail = false;
  let worker: Worker | undefined;
  const workers: Worker[] = [];
  // The route takes its Redis from the issue queue; it is the namespaced client, while BullMQ keeps its own,
  // so the queue's keys, such as its run records, are named relative to the namespace there.
  useLiveQueue(new Proxy(queue, { get: (target, prop) => {
    if (prop === 'client') return Promise.resolve(owned);
    if (prop === 'toKey') return (type: string) => target.toKey(type).slice(NAMESPACE.length);
    const value = Reflect.get(target, prop, target) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  } }));
  const runChild = async (job: Job<IssueJobData>): Promise<JobResult> => {
    await hold;
    runs.push({ jobId: job.id!, data: job.data, prompt: await promptFor(job.data) });
    if (childrenFail) throw new Error('Claude authentication failed');
    return { status: 'completed', issueNumber: job.data.number };
  };
  const dispatch = async (job: Job<IssueJobData>) => {
    try {
      const result = await handleDispatchWithDeps(job, deps);
      dispatches.push(result);
      return result;
    } catch (error) {
      dispatches.push(error as Error);
      throw error;
    }
  };
  const startWorker = (options: Partial<WorkerOptions> = {}) => {
    const connection = connect();
    clients.push(connection);
    const started = new Worker<IssueJobData, JobResult>(queue.name, job => job.data.isChildJob ? runChild(job) : dispatch(job),
      { connection, prefix, concurrency: 2, ...options });
    worker = started;
    workers.push(started);
    started.on('completed', (job, result) => (job.data.isChildJob ? childOutcomes : parents).push({ event: 'completed', job, result }));
    started.on('failed', (job, error) => { if (job) (job.data.isChildJob ? childOutcomes : parents).push({ event: 'failed', job, error }); });
    started.on('stalled', jobId => { stalls.push(jobId); });
    // A worker whose job another recovered cannot record its outcome; BullMQ reports that as an error event.
    started.on('error', () => {});
    return started;
  };
  try {
    await body({
      queue, children, runs, dispatches, stalls, startWorker,
      restartWorker: async () => {
        await worker?.close();
        startWorker();
      },
      settled: parents.next,
      childSettled: childOutcomes.next,
      holdChildren: () => {
        hold = new Promise(resolve => { releaseHold = () => { hold = null; resolve(); }; });
        return releaseHold;
      },
      failChildren: fail => { childrenFail = fail; },
      drained: () => until(async () => Object.values(await queue.getJobCounts('waiting', 'delayed', 'active')).every(jobs => jobs === 0),
        'the queue did not drain'),
      reaches: (jobId, jobState) => until(async () => await (await queue.getJob(jobId))?.getState() === jobState, `${jobId} did not become ${jobState}`),
    });
    assert.equal(parents.pending(), 0, 'no parent job settled that the test did not expect');
  } finally {
    useLiveQueue(null);
    // A held child would keep the worker from closing after a failed assertion; a forced close does not wait for
    // active jobs, and every worker the test started is closed, so none outlives it into the next test.
    releaseHold();
    await Promise.all(workers.map(started => started.close(true)));
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

const routings = [['submission-backed', true], ['issue-only', false]] as const;

/** The failed parent (dispatcher) attempt, failing with `error`. */
function assertFailedAttempt(settled: Settled, error: RegExp) {
  assert.equal(settled.event, 'failed');
  assert.match(settled.event === 'failed' ? settled.error.message : '', error);
}

/** The settled parent job completed with `result`. */
function assertCompleted(settled: Settled, result: JobResult) {
  assert.equal(settled.event, 'completed', settled.event === 'failed' ? settled.error.message : undefined);
  assert.deepEqual(settled.event === 'completed' && settled.result, result);
}

const alreadyDispatched = (backed: boolean): JobResult => backed
  ? { status: 'skipped', reason: 'submission_already_dispatched', issueNumber: 14 }
  : { status: 'skipped', reason: 'retry_request_already_dispatched', issueNumber: 14 };

/** Once the claim expires another user follows up with new instructions, which run once for them and for no one else. */
async function assertNextFollowupRunsOnce(live: LiveQueue, earlierRuns: number, foreign = /First instructions/) {
  live.failChildren(false);
  state.now += 60_000;
  await owned.del(dedupKey);
  const next = await postFollowup({ body: 'Second instructions' }, 'failed-issue-task', 'user-2');
  assert.equal(next.json.state, 'queued', String(next.json.message ?? next.json.error));
  assert.equal(next.json.restartedRequest, undefined, 'the earlier request is not restarted');
  const commentId = postedComments().length + FIRST_COMMENT_ID - 1;
  await assertDispatched(await live.settled(), live.children.at(-1), { requester: 'user-2', commentId, instructions: /Second instructions/ });
  assert.equal((await live.childSettled()).event, 'completed');
  await live.drained();
  assert.equal(live.runs.length, earlierRuns + 1, 'the earlier request\'s instructions did not run again');
  assertChildRun(live.runs.at(-1), { jobId: await requestChildId(commentId), requester: 'user-2', commentId, instructions: /Second instructions/, foreign });
  assert.deepEqual(await openRequests(), []);
  assert.deepEqual(await runRecords(), [], 'no run record outlives its request unretired');
}

for (const [routing, backed] of routings) {
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
        const firstChild = await requestChildId();
        assertFailedAttempt(await live.settled(), /database is locked/);
        state.consumeFails = false;
        await live.reaches(firstChild, 'active');

        // BullMQ retries the dispatch after its backoff, while the child still runs: the queue's record of the
        // request's run shows it was carried, so it is recorded consumed and nothing is added again.
        assertCompleted(await live.settled(), alreadyDispatched(backed));
        assert.deepEqual(live.children.map(child => child.jobId), [firstChild]);
        assert.deepEqual(await runRecords(), [], 'the record is retired once the request is recorded consumed');
        assert.equal((await retiredRecords()).length, 1, 'and kept as its tombstone');
        assert.deepEqual(await openRequests(), []);
        release();
        assert.equal((await live.childSettled()).event, 'completed');
        await live.drained();
        assert.equal(live.runs.length, 1, 'the request\'s child ran once');
        assertChildRun(live.runs[0], { jobId: firstChild, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
        assert.equal(await live.queue.getJob(JOB_ID), undefined, 'the completed dispatcher job is removed, freeing its ID');
        if (backed) assert.equal(await (await live.queue.getJob(firstChild))?.getState(), 'completed', 'a submission\'s child is kept as its receipt');
        else assert.equal(await live.queue.getJob(firstChild), undefined, 'an issue-only child is removed');

        // The run failed again; once the claim expires another user retries, on the same dispatcher job ID.
        await assertNextFollowupRunsOnce(live, 1);
        assert.notEqual(live.runs[1].jobId, firstChild, 'each request runs a child of its own');
        const counts = await live.queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
        assert.deepEqual(Object.entries(counts).filter(([, jobs]) => jobs > 0), [], 'no job is left behind');
      });
    });
  });
}

for (const outcome of ['completes', 'fails'] as const) {
  test(`an issue-only retry whose child ${outcome} before its dispatch's retry, after recording the request consumed failed, runs once even when the retry comes a day later, and the next follow-up runs its own`, { skip, timeout: 60_000 }, async () => {
    await withLiveQueue(async live => {
      live.startWorker();
      // The run ends fast, as on the original agent authentication failure, while its dispatch fails to record the request consumed.
      live.failChildren(outcome === 'fails');
      state.consumeFails = true;
      const first = await postFollowup({ body: 'First instructions' }, 'failed-issue-task');
      assert.equal(first.json.state, 'queued');
      assertFailedAttempt(await live.settled(), /database is locked/);
      const childId = await requestChildId();
      assert.deepEqual(live.children.map(child => child.jobId), [childId]);
      const [record] = await runRecords();
      assert.ok(record, 'the child\'s add wrote the queue\'s record of the request\'s run');
      assert.equal(await raw.pttl(record), -1, 'which has no expiry');
      assert.deepEqual(await ownedKeys('bull:*:de:*'), [], 'no expiring deduplication stands in for it');

      // The child ends and is removed, freeing its ID, before BullMQ retries the dispatch after its backoff.
      assert.equal((await live.childSettled()).event, outcome === 'completes' ? 'completed' : 'failed');
      assert.equal(await live.queue.getJob(childId), undefined, 'the ended child is removed, freeing its ID');
      assert.equal(await (await live.queue.getJob(JOB_ID))?.getState(), 'delayed', 'the dispatch has not retried yet');
      // The retry resumes after the outage, more than a day later by the application's clock.
      state.now += DAY_MS + 60 * 60_000;
      assert.equal(await raw.exists(record), 1, 'the record outlives any day-long expiry');
      state.consumeFails = false;
      assertCompleted(await live.settled(), alreadyDispatched(false));
      assert.deepEqual(live.children.map(child => child.jobId), [childId], 'nothing is added again');
      await live.drained();
      assert.equal(live.runs.length, 1, 'the request\'s child ran once');
      assertChildRun(live.runs[0], { jobId: childId, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
      assert.deepEqual(await openRequests(), [], 'the request is recorded consumed');
      assert.deepEqual(await runRecords(), [], 'and its record is retired');

      await assertNextFollowupRunsOnce(live, 1);
      const counts = await live.queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
      assert.deepEqual(Object.entries(counts).filter(([, jobs]) => jobs > 0), [], 'no job is left behind');
    });
  });

  for (const [routing, backed] of routings) {
    test(`a ${routing} retry whose child ${outcome} while no dispatch attempt can record it is not run again after a day and a worker restart, and the next follow-up runs its own`, { skip, timeout: 60_000 }, async () => {
      await onIssue(backed, `live-exhausted-run-${outcome}-${backed}`, async () => {
        await withLiveQueue(async live => {
          live.startWorker();
          live.failChildren(outcome === 'fails');
          // No attempt can record the request consumed, or the submission's receipt either.
          state.consumeFails = true;
          state.recordDispatchFails = backed;
          const first = await postFollowup({ body: 'First instructions' }, 'failed-issue-task');
          assert.equal(first.json.state, 'queued');
          const [, queuedJob] = [first, await live.queue.getJob(JOB_ID)];
          const original = queuedJob!.data;
          // The first attempt cannot record the request consumed, or the receipt; its retry finds the run's record,
          // cannot settle it either, and adds nothing. The parent is then gone while the request stays open.
          assertFailedAttempt(await live.settled(), /database is locked/);
          assertCompleted(await live.settled(), alreadyDispatched(backed));
          assert.equal((await live.childSettled()).event, outcome === 'completes' ? 'completed' : 'failed');
          await live.drained();
          assert.equal(await live.queue.getJob(JOB_ID), undefined, 'the parent is gone');
          const childId = await requestChildId();
          assert.deepEqual(live.children.map(child => child.jobId), [childId], 'its child was added once');
          assert.equal(live.runs.length, 1);
          assert.equal((await openRequests()).length, 1, 'the request is still open');
          assert.equal((await runRecords()).length, 1, 'with the record of its run');

          // A day later the stores recover and the worker process restarts; the original job is delivered again.
          state.now += DAY_MS + 60 * 60_000;
          state.consumeFails = false;
          state.recordDispatchFails = false;
          await live.restartWorker();
          await live.queue.add('processGitHubIssue', original, { jobId: JOB_ID, removeOnComplete: true, removeOnFail: true });
          assertCompleted(await live.settled(), alreadyDispatched(backed));
          await live.drained();
          assert.deepEqual(live.children.map(child => child.jobId), [childId], 'nothing is added again');
          assert.equal(live.runs.length, 1, 'the accepted instructions ran once');
          assertChildRun(live.runs[0], { jobId: childId, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
          assert.deepEqual(await openRequests(), []);
          assert.deepEqual(await runRecords(), []);

          await assertNextFollowupRunsOnce(live, 1);
        });
      });
    });
  }
}

for (const [routing, backed] of routings) {
  test(`a ${routing} retry whose run failed while its dispatch could not record it is settled by the next follow-up after the publication window, which runs its own instead of restarting it`, { skip, timeout: 60_000 }, async () => {
    await onIssue(backed, `live-settled-by-followup-${backed}`, async () => {
      await withLiveQueue(async live => {
        live.startWorker();
        live.failChildren(true);
        state.consumeFails = true;
        state.recordDispatchFails = backed;
        assert.equal((await postFollowup({ body: 'First instructions' }, 'failed-issue-task')).json.state, 'queued');
        // Its retry finds the run's record, cannot settle it, and adds nothing; the request stays open, and a
        // submission's trigger is never recorded consumed.
        assertFailedAttempt(await live.settled(), /database is locked/);
        assertCompleted(await live.settled(), alreadyDispatched(backed));
        assert.equal((await live.childSettled()).event, 'failed');
        await live.drained();
        state.consumeFails = false;
        state.recordDispatchFails = false;
        if (backed) assert.equal(await (await live.queue.getJob(await requestChildId()))?.getState(), 'failed', 'its failed child is kept, and blocks nothing');
        assert.equal(live.runs.length, 1);
        assert.equal((await openRequests()).length, 1);
        assert.equal((await runRecords()).length, 1);

        // Past the publication window the request would be stranded and restarted; its record shows it ran.
        state.now += 11 * 60_000;
        await live.restartWorker();
        await assertNextFollowupRunsOnce(live, 1);
        assert.equal(postedComments().length, 2, 'the new follow-up is posted, not discarded as the earlier one');
      });
    });
  });
}

for (const [routing, backed] of routings) {
  test(`a ${routing} follow-up that passed its checks while another request's child runs runs its own child once for its own requester`, { skip, timeout: 60_000 }, async () => {
    await onIssue(backed, `live-concurrent-${backed}`, async () => {
      await withLiveQueue(async live => {
        live.startWorker();
        const release = live.holdChildren();
        // The second follow-up passes its checks, then waits on GitHub's issue read.
        let reached = () => {};
        const atIssueRead = new Promise<void>(resolve => { reached = resolve; });
        let resume = () => {};
        const resumed = new Promise<void>(resolve => { resume = resolve; });
        state.onIssueRead = async () => { state.onIssueRead = undefined; reached(); await resumed; };
        const second = postFollowup({ body: 'Second instructions' }, 'failed-issue-task', 'user-2');
        await atIssueRead;

        // Meanwhile the first follow-up is published and dispatched, and its child runs; its request is recorded consumed.
        const first = await postFollowup({ body: 'First instructions' }, 'failed-issue-task');
        assert.equal(first.json.state, 'queued');
        assert.equal(first.json.commentId, FIRST_COMMENT_ID);
        await assertDispatched(await live.settled(), live.children[0], { requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
        const firstChild = await requestChildId();
        await live.reaches(firstChild, 'active');
        assert.deepEqual(await openRequests(), []);

        // The first request's claim expires; the second follow-up resumes while the first child still runs.
        state.now += 31_000;
        await owned.del(dedupKey);
        resume();
        const secondResult = await second;
        assert.equal(secondResult.json.state, 'queued', String(secondResult.json.message ?? secondResult.json.error));
        assert.equal(secondResult.json.commentId, FIRST_COMMENT_ID + 1);
        await assertDispatched(await live.settled(), live.children.at(-1), { requester: 'user-2', commentId: FIRST_COMMENT_ID + 1, instructions: /Second instructions/ });
        const secondChild = await requestChildId(FIRST_COMMENT_ID + 1);
        assert.notEqual(secondChild, firstChild, 'its child is not deduplicated against the running one');
        assert.deepEqual((await live.queue.getJob(secondChild))?.data.retryCommentId, FIRST_COMMENT_ID + 1, 'the queue holds its own payload');
        assert.deepEqual(await openRequests(), []);

        release();
        await live.childSettled();
        await live.childSettled();
        await live.drained();
        assert.equal(live.runs.length, 2, 'each request ran once');
        const byJob = (jobId: string) => live.runs.filter(run => run.jobId === jobId);
        assert.equal(byJob(firstChild).length, 1);
        assert.equal(byJob(secondChild).length, 1);
        assertChildRun(byJob(firstChild)[0], { jobId: firstChild, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
        assertChildRun(byJob(secondChild)[0], {
          jobId: secondChild, requester: 'user-2', commentId: FIRST_COMMENT_ID + 1, instructions: /Second instructions/, foreign: /First instructions/,
        });
      });
    });
  });
}

test('a request\'s child ID that another payload holds is not taken for its run: the request stays owed and runs once for its own requester when the ID is free', { skip, timeout: 60_000 }, async () => {
  await withLiveQueue(async live => {
    assert.equal((await postFollowup({ body: 'First instructions' }, 'failed-issue-task')).json.state, 'queued');
    const childId = await requestChildId();
    // A job of another request already holds the ID, as after the request records were reset; it waits delayed.
    const foreign = { repoOwner: 'integry', repoName: 'propr', number: 14, isChildJob: true, userId: 'user-9', retryRequesterId: 'user-9', retryCommentId: 1 };
    await live.queue.add('processGitHubIssue', foreign, { jobId: childId, delay: 60 * 60_000 });

    live.startWorker();
    assertFailedAttempt(await live.settled(), /carries another request's run/);
    assert.deepEqual((await live.queue.getJob(childId))?.data.retryRequesterId, 'user-9', 'BullMQ kept the foreign payload');
    assert.deepEqual((await openRequests()).map(held => held.comment_id), [FIRST_COMMENT_ID], 'the request stays owed');
    assert.deepEqual(await runRecords(), [], 'with no record of a run');
    assert.equal(live.runs.length, 0);

    // Once the ID is free, the dispatch's retry adds the request's own run.
    await (await live.queue.getJob(childId))!.remove();
    await assertDispatched(await live.settled(), live.children.at(-1), { requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
    await live.childSettled();
    await live.drained();
    assert.equal(live.runs.length, 1);
    assertChildRun(live.runs[0], { jobId: childId, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
    assert.deepEqual(await openRequests(), []);
  });
});

for (const [routing, backed] of routings) {
  test(`a ${routing} retry whose run was never added is restarted after its parent exhausts its attempts, and runs once for its own requester`, { skip, timeout: 60_000 }, async () => {
    await onIssue(backed, `live-never-added-${backed}`, async () => {
      await withLiveQueue(async live => {
        live.startWorker();
        state.runEnqueueFails = true;
        assert.equal((await postFollowup({ body: 'First instructions' }, 'failed-issue-task')).json.state, 'queued');
        for (let attempt = 0; attempt < 3; attempt++) assertFailedAttempt(await live.settled(), /Connection is closed/);
        await live.drained();
        state.runEnqueueFails = false;
        assert.equal(await live.queue.getJob(JOB_ID), undefined, 'the exhausted parent is removed');
        assert.equal(live.runs.length, 0);
        assert.deepEqual(await runRecords(), []);

        // Past the publication window a later follow-up restarts it: nothing shows it ever ran.
        state.now += 11 * 60_000;
        await owned.del(dedupKey);
        const later = await postFollowup({ body: 'A later request' }, 'failed-issue-task', 'user-2');
        assert.deepEqual(later.json.restartedRequest, { state: 'queued', commentId: FIRST_COMMENT_ID });
        assert.equal(postedComments().length, 1, 'the later request waits for the restarted run');
        await assertDispatched(await live.settled(), live.children.at(-1), { requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
        await live.childSettled();
        await live.drained();
        assert.equal(live.runs.length, 1);
        assertChildRun(live.runs[0], { jobId: await requestChildId(), requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
        assert.deepEqual(await openRequests(), []);
        assert.deepEqual(await runRecords(), []);
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
    assertChildRun(live.runs[0], { jobId: await requestChildId(), requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: new RegExp(ORIGINAL) });
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
        assert.equal(live.children[0].jobId, await requestChildId());
        if (backed) assert.equal(live.children[0].data.correlationId?.split('-').at(-1), String(own), 'it runs on its own trigger');
        await live.childSettled();
        assertChildRun(live.runs[0], { jobId: live.children[0].jobId, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: new RegExp(ORIGINAL) });
        assert.deepEqual(await outcomeKeys(), [], 'the outcome is dropped once recorded');
        assert.deepEqual(await openRequests(), []);
      });
    });
  });
}

for (const [routing, backed] of routings) {
  test(`a ${routing} retry whose run the queue accepted, though the reply was lost, runs once and is settled by its dispatch's retry`, { skip, timeout: 60_000 }, async () => {
    await onIssue(backed, `live-lost-reply-${backed}`, async () => {
      await withLiveQueue(async live => {
        live.startWorker();
        nextRunQueue = queue => replyLosingQueue(queue, true);
        assert.equal((await postFollowup({ body: 'First instructions' }, 'failed-issue-task')).json.state, 'queued');
        assertFailedAttempt(await live.settled(), /Connection lost after the transaction ran/);
        // Redis accepted the child with the record of its run, whatever the dispatch heard: the child runs.
        assert.equal((await live.childSettled()).event, 'completed');
        // The dispatch's retry finds the record, settles the request and adds nothing.
        assertCompleted(await live.settled(), alreadyDispatched(backed));
        await live.drained();
        assert.equal(live.runs.length, 1, 'the accepted run ran once');
        assertChildRun(live.runs[0], { jobId: await requestChildId(), requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
        assert.deepEqual(await openRequests(), []);
        assert.deepEqual(await runRecords(), []);
        await assertNextFollowupRunsOnce(live, 1);
      });
    });
  });
}

test('a requested run whose transaction never reached Redis leaves no child and no record, and its retry adds and records it', { skip, timeout: 30_000 }, async () => {
  await withLiveQueue(async live => {
    const runs = queueRetryRunEvidence(() => live.queue);
    const held = requestOf(1);
    await assert.rejects(enqueueIssueRetryRun(replyLosingQueue(live.queue, false), held, [childOf(held, 'a')], { receiptEventId: null, use: run => run() }), /before the transaction was sent/);
    assert.equal(await live.queue.getJob(childIdOf(held, 'a')), undefined);
    assert.equal(await runs.read(held), null, 'nothing records a run');
    await enqueueIssueRetryRun(live.queue, held, [childOf(held, 'a')], { receiptEventId: null, use: run => run() });
    assert.equal((await live.queue.getJob(childIdOf(held, 'a')))?.data.retryCommentId, held.commentId);
    assert.deepEqual(await runs.read(held), { receiptEventId: null });
  });
});

test('a requested run whose add fails inside the transaction is not recorded, and a partly accepted matrix adds only its missing children again', { skip, timeout: 30_000 }, async () => {
  await withLiveQueue(async live => {
    const runs = queueRetryRunEvidence(() => live.queue);
    const held = requestOf(2);
    // The second child names a parent that does not exist: its add returns BullMQ's error code, and Redis still runs
    // every other command of the transaction, the first child's add and the record's write among them.
    const orphan = { ...childOf(held, 'b'), opts: { ...childOf(held, 'b').opts, parent: { id: 'missing', queue: live.queue.qualifiedName } } };
    await assert.rejects(enqueueIssueRetryRun(live.queue, held, [childOf(held, 'a'), orphan], { receiptEventId: 'event-1', use: run => run() }), /accepted 1 of 2 children.*code -5/);
    assert.equal(await runs.read(held), null, 'the run is not recorded while one of its children was not accepted');
    assert.equal(await live.queue.getJob(childIdOf(held, 'b')), undefined);
    // The accepted child runs and is removed before the dispatch's retry.
    await (await live.queue.getJob(childIdOf(held, 'a')))!.remove();

    await enqueueIssueRetryRun(live.queue, held, [childOf(held, 'a'), childOf(held, 'b')], { receiptEventId: 'event-1', use: run => run() });
    assert.equal(await live.queue.getJob(childIdOf(held, 'a')), undefined, 'the child already accepted is not added again');
    assert.equal((await live.queue.getJob(childIdOf(held, 'b')))?.data.retryCommentId, held.commentId);
    assert.deepEqual(await runs.read(held), { receiptEventId: 'event-1' });
    // A later dispatch of the recorded run adds nothing.
    await (await live.queue.getJob(childIdOf(held, 'b')))!.remove();
    await enqueueIssueRetryRun(live.queue, held, [childOf(held, 'a'), childOf(held, 'b')], { receiptEventId: 'event-1', use: run => run() });
    assert.equal(await live.queue.count(), 0);
  });
});

test('a requested child ID another payload takes after the check is not recorded as the request\'s run', { skip, timeout: 30_000 }, async () => {
  await withLiveQueue(async live => {
    const runs = queueRetryRunEvidence(() => live.queue);
    const held = requestOf(3);
    const foreign = { ...childOf(held, 'a').data, userId: 'user-9', retryRequesterId: 'user-9', retryCommentId: 1 };
    await live.queue.add('processGitHubIssue', foreign, { jobId: childIdOf(held, 'a'), delay: 60 * 60_000 });
    // The foreign job is added after the request's check read the ID free, so the add reaches BullMQ, which keeps it.
    const unchecked = new Proxy(live.queue, { get: (target, prop) => prop === 'getJob' ? async () => undefined
      : (value => typeof value === 'function' ? value.bind(target) : value)(Reflect.get(target, prop, target) as unknown) });
    await assert.rejects(enqueueIssueRetryRun(unchecked, held, [childOf(held, 'a')], { receiptEventId: null, use: run => run() }), /accepted 0 of 1/);
    assert.equal((await live.queue.getJob(childIdOf(held, 'a')))?.data.retryRequesterId, 'user-9', 'BullMQ kept the foreign payload');
    assert.equal(await runs.read(held), null, 'the request stays owed');
    // The same comment under another requester is not this request either.
    await (await live.queue.getJob(childIdOf(held, 'a')))!.remove();
    await live.queue.add('processGitHubIssue', { ...childOf(held, 'a').data, retryRequesterId: 'user-9' }, { jobId: childIdOf(held, 'a'), delay: 60 * 60_000 });
    await assert.rejects(enqueueIssueRetryRun(unchecked, held, [childOf(held, 'a')], { receiptEventId: null, use: run => run() }), /accepted 0 of 1/);
    assert.equal(await runs.read(held), null);
  });
});

test('a record another request left under a reused request ID is not taken for the new request\'s run', { skip, timeout: 30_000 }, async () => {
  await withLiveQueue(async live => {
    const runs = queueRetryRunEvidence(() => live.queue);
    const earlier = requestOf(4);
    await enqueueIssueRetryRun(live.queue, earlier, [childOf(earlier, 'a')], { receiptEventId: null, use: run => run() });
    await (await live.queue.getJob(childIdOf(earlier, 'a')))!.remove();
    // The request records are reset; a new request takes the same ID, with its own comment.
    const reused = { ...earlier, commentId: earlier.commentId + 1, requesterId: 'user-2' };
    assert.equal(await runs.read(reused), null, 'the earlier request\'s record is not the new one\'s');
    await enqueueIssueRetryRun(live.queue, reused, [childOf(reused, 'a')], { receiptEventId: null, use: run => run() });
    assert.equal((await live.queue.getJob(childIdOf(reused, 'a')))?.data.retryRequesterId, 'user-2', 'the new request runs a child of its own');
    assert.deepEqual(await runs.read(reused), { receiptEventId: null });
    assert.equal(await runs.read(earlier), null, 'and the earlier request no longer reads as carried by it');
  });
});

test('a requested run with a child that cannot be built sends nothing to Redis', { skip, timeout: 30_000 }, async () => {
  await withLiveQueue(async live => {
    const runs = queueRetryRunEvidence(() => live.queue);
    const held = requestOf(5);
    const oversized = { ...childOf(held, 'b'), opts: { ...childOf(held, 'b').opts, sizeLimit: 1 } };
    await assert.rejects(enqueueIssueRetryRun(live.queue, held, [childOf(held, 'a'), oversized], { receiptEventId: null, use: run => run() }), /exceeds the limit/);
    assert.equal(await live.queue.getJob(childIdOf(held, 'a')), undefined, 'the child built before it is not added');
    assert.equal(await runs.read(held), null);
    assert.deepEqual(await runRecords(), []);
  });
});

/** The queue seen through a connection that runs `around` each transaction's execution. */
function aroundTransactions(queue: Queue, around: (exec: () => Promise<unknown>) => Promise<unknown>): Queue {
  const bind = (target: object, prop: string | symbol) => {
    const value = Reflect.get(target, prop, target) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  };
  const hooked = (client: object) => new Proxy(client, { get: (target, prop) => prop !== 'multi' ? bind(target, prop) : () => {
    const transaction = (target as { multi(): { exec(): Promise<unknown> } }).multi();
    const exec = transaction.exec.bind(transaction);
    transaction.exec = () => around(exec);
    return transaction;
  } });
  return new Proxy(queue, { get: (target, prop) => prop === 'client' ? target.client.then(hooked) : bind(target, prop) });
}

/** The queue as a dispatch sees it that is suspended at its first child check, after it read the run's record, until `resume` runs. */
function suspendedAtCheck(): { suspend: (queue: Queue) => Queue; reached: Promise<void>; resume: () => void } {
  let reach = () => {};
  const reached = new Promise<void>(resolve => { reach = resolve; });
  let resume = () => {};
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  const suspend = (queue: Queue) => new Proxy(queue, { get: (target, prop) => {
    if (prop === 'getJob') return async (jobId: string) => { reach(); await resumed; return target.getJob(jobId); };
    const value = Reflect.get(target, prop, target) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { suspend, reached, resume };
}

for (const evidence of ['retained', 'retired'] as const) {
  test(`an issue-only retry's dispatch that resumes after another worker recovered its stalled job, and ran and removed the request's child, adds nothing again, with the run's record ${evidence}`, { skip, timeout: 60_000 }, async () => {
    await withLiveQueue(async live => {
      // Worker A's dispatch reads the record, finds no run, builds its children and is suspended at its child check,
      // as a process that misses its lock renewals: its lock expires, and it recovers no stalled job itself.
      const suspended = suspendedAtCheck();
      nextRunQueue = suspended.suspend;
      const workerA = live.startWorker({ concurrency: 1, lockDuration: 1_000, skipLockRenewal: true, skipStalledCheck: true });
      // A retained record is one whose request could not be recorded consumed; a retired one is the tombstone left once it was.
      state.consumeFails = evidence === 'retained';
      assert.equal((await postFollowup({ body: 'First instructions' }, 'failed-issue-task')).json.state, 'queued');
      await suspended.reached;
      const childId = await requestChildId();

      // Worker B's stalled check recovers the same parent once A's lock expires; its dispatch adds and records the
      // child, which runs and is removed, and the parent finishes and is removed too.
      live.startWorker({ stalledInterval: 250 });
      if (evidence === 'retained') {
        assertFailedAttempt(await live.settled(), /database is locked/);
        assertCompleted(await live.settled(), alreadyDispatched(false));
      } else {
        await assertDispatched(await live.settled(), live.children[0], { requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
      }
      assert.equal((await live.childSettled()).event, 'completed');
      await live.drained();
      assert.deepEqual(live.stalls, [JOB_ID], 'B recovered A\'s parent from its stalled check');
      assert.equal(await live.queue.getJob(childId), undefined, 'the child ran and was removed, freeing its ID');
      assert.equal(await live.queue.getJob(JOB_ID), undefined, 'the recovered parent finished and was removed');
      assert.equal((await runRecords()).length, evidence === 'retained' ? 1 : 0);
      assert.equal((await retiredRecords()).length, evidence === 'retained' ? 0 : 1);
      const recovered = live.dispatches.length;

      // A resumes with the children it built before B ran: the record its transaction meets fences their adds.
      suspended.resume();
      await until(async () => live.dispatches.length === recovered + 1, 'the suspended dispatch did not return');
      const stale = live.dispatches.at(-1);
      if (evidence === 'retained') assert.match(stale instanceof Error ? stale.message : '', /database is locked/, 'it only tries to settle the request');
      else assert.deepEqual(stale, alreadyDispatched(false));
      await workerA.close(true);
      await live.drained();
      assert.equal(live.dispatches.length, recovered + 1, 'the parent was dispatched by A, then by B, and by nothing else');
      assert.equal(live.runs.length, 1, 'the accepted instructions ran once');
      assertChildRun(live.runs[0], { jobId: childId, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
      assert.deepEqual(live.children.map(child => child.jobId), [childId], 'only B added the child');
      assert.equal(await raw.exists(live.queue.toKey(childId)), 0, 'nothing is left under the child\'s ID');

      state.consumeFails = false;
      await assertNextFollowupRunsOnce(live, 1);
    });
  });
}

for (const [routing, backed, later] of [['issue-only', false, false], ['issue-only', false, true], ['submission-backed', true, false]] as const) {
  test(`a fresh poll after a ${routing} retry's child failed fast and its dispatch could not record it ${later ? 'still runs a later, independent trigger as usual' : 'only settles the request, running nothing more'}`, { skip, timeout: 60_000 }, async () => {
    await onIssue(backed, `live-fresh-poll-${backed}-${later}`, async () => {
      await withLiveQueue(async live => {
        live.startWorker();
        live.failChildren(true);
        state.consumeFails = true;
        assert.equal((await postFollowup({ body: 'First instructions' }, 'failed-issue-task')).json.state, 'queued');
        // The child fails at once; the dispatch's retry recognizes its run but cannot settle it, and the parent
        // carrying the request's metadata completes and is removed.
        assertFailedAttempt(await live.settled(), /database is locked/);
        assert.equal((await live.childSettled()).event, 'failed');
        assertCompleted(await live.settled(), alreadyDispatched(backed));
        await live.drained();
        const childId = await requestChildId();
        assert.equal(await live.queue.getJob(JOB_ID), undefined, 'the original parent is gone');
        assert.equal((await openRequests()).length, 1, 'the request is still open');
        assert.equal((await runRecords()).length, 1, 'with the record of its run');

        // Storage recovers; past the claim, an ordinary poll queues a fresh parent, after someone relabelled the issue or not.
        state.consumeFails = false;
        live.failChildren(false);
        state.now += 60_000;
        if (later) applyLabels(['AI'], HUMAN_ACTOR_ID);
        await owned.del(dedupKey);
        assert.equal((await livePoll()).status, 'accepted');
        const polled = await live.settled();
        assert.deepEqual([polled.job.data.retryCommentId, polled.job.data.retryRequesterId, polled.job.data.userId], [undefined, undefined, '99'],
          'the poll carries no retry metadata');
        if (later) {
          assert.equal(polled.event === 'completed' && polled.result.status, 'dispatched');
          assert.equal((await live.childSettled()).event, 'completed');
        } else {
          assertCompleted(polled, alreadyDispatched(backed));
        }
        await live.drained();
        assert.equal(live.runs.length, later ? 2 : 1, later ? 'the later trigger ran once' : 'nothing more ran on the accepted trigger');
        assertChildRun(live.runs[0], { jobId: childId, requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/ });
        if (later) {
          const ordinary = live.runs[1];
          assert.equal(ordinary.jobId, 'issue-integry-propr-14-claude-claude-opus-5-5-main', 'an ordinary run of the issue');
          assert.deepEqual([ordinary.data.userId, ordinary.data.retryRequesterId, ordinary.data.retryCommentId], ['99', undefined, undefined]);
        }
        assert.deepEqual(live.children.map(child => child.jobId).slice(0, 1), [childId]);
        assert.equal(live.children.length, later ? 2 : 1);
        assert.deepEqual(await openRequests(), [], 'the request is settled either way');
        assert.deepEqual(await runRecords(), []);

        await assertNextFollowupRunsOnce(live, live.runs.length);
      });
    });
  });
}

test('requested children an add wrote but never queued are not taken for the run: the request stays owed, and its retry replaces and runs them once, even when its reply is lost', { skip, timeout: 30_000 }, async () => {
  await withLiveQueue(async live => {
    const runs = queueRetryRunEvidence(() => live.queue);
    const held = requestOf(6);
    const matrix = [childOf(held, 'a'), childOf(held, 'b')];
    const enqueue = (queue: Queue) => enqueueIssueRetryRun(queue, held, matrix, { receiptEventId: null, use: run => run() });
    // Deliberately injected: while the transaction runs, the queue's event stream is a string, so each add's script
    // fails at its first event, after writing its job and before queueing it, as any script error after that write would.
    const events = live.queue.toKey('events');
    const failing = aroundTransactions(live.queue, async exec => {
      const existed = await raw.exists(events) === 1;
      if (existed) await raw.rename(events, `${events}:held`);
      await raw.set(events, 'blocked');
      try {
        return await exec();
      } finally {
        await raw.del(events);
        if (existed) await raw.rename(`${events}:held`, events);
      }
    });
    await assert.rejects(enqueue(failing), /accepted 0 of 2 children.*WRONGTYPE/);
    for (const child of matrix) {
      const job = await live.queue.getJob(child.opts.jobId);
      assert.equal(job?.data.retryCommentId, held.commentId, 'the add wrote the job');
      assert.equal(await job?.getState(), 'unknown', 'but the queue holds it in no state, so it can never run');
    }
    assert.equal(await runs.read(held), null, 'jobs alone are not taken for the run');

    // The retry replaces them and the queue accepts the run, though the reply is lost; a later dispatch adds nothing.
    await assert.rejects(enqueue(replyLosingQueue(live.queue, true)), /after the transaction ran/);
    assert.deepEqual(await runs.read(held), { receiptEventId: null });
    for (const child of matrix) assert.equal(await (await live.queue.getJob(child.opts.jobId))?.getState(), 'waiting');
    assert.equal(await enqueue(live.queue), false);
    live.startWorker();
    await live.childSettled();
    await live.childSettled();
    await live.drained();
    assert.deepEqual(live.runs.map(run => run.jobId).sort(), matrix.map(child => child.opts.jobId).sort(), 'each child ran once');
  });
});

/** A requested retry, as a dispatch selects it, numbered `id`. */
function requestOf(id: number) {
  return { id: 990_000 + id, commentId: FIRST_COMMENT_ID + 100 + id, requesterId: 'user-1' };
}
const childIdOf = (held: ReturnType<typeof requestOf>, model: string) => `issue-integry-propr-14-claude-${model}-main-request-${held.id}-${held.commentId}`;
/** A child of the request's run on `model`, as its dispatch builds it. */
function childOf(held: ReturnType<typeof requestOf>, model: string): RetryRunChild {
  return {
    name: 'processGitHubIssue',
    data: { repoOwner: 'integry', repoName: 'propr', number: 14, isChildJob: true, modelName: model, userId: held.requesterId,
      retryRequesterId: held.requesterId, retryCommentId: held.commentId } as IssueJobData,
    opts: { jobId: childIdOf(held, model), removeOnComplete: true, removeOnFail: true },
  };
}
