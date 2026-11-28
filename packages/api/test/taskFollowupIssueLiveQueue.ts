/**
 * The harness of the issue retry suites that run against a real Redis server
 * and a real BullMQ queue and worker: taskFollowupIssueQueueLifecycle,
 * taskFollowupIssueQueueRestarts, taskFollowupIssueQueueRunTransactions,
 * taskFollowupIssueQueueStalledRecovery, taskFollowupIssueQueueFreshPolls and
 * taskFollowupIssueQueueRecoveryHistory.
 *
 * The other follow-up suites simulate the queue and Redis. These run the
 * route, the matrix dispatcher and the child jobs it enqueues on BullMQ's
 * actual job-ID deduplication, retries and job removal, and on Redis's actual
 * claim and outcome keys and run records. GitHub, the request records and the
 * child runs' agent stay simulated: a child run only reads the prompt it would
 * be given. Every wait is bounded, so a run that never settles fails its test,
 * whose cleanup still closes its workers and drops its keys.
 * The suites are skipped when Redis is not reachable (set REDIS_HOST /
 * REDIS_PORT; CI starts one with scripts/ci-redis.sh), unless
 * PROPR_REQUIRE_REDIS_INTEGRATION=1, which CI sets so an unreachable Redis
 * fails them instead of silently skipping them.
 *
 * The configured Redis may be shared, so every key a suite writes lives in a
 * namespace of its own run: the route's, deliveries' and dispatcher's claim
 * and outcome keys through a key-prefixed client, and the queue under a BullMQ
 * prefix in that namespace. Cleanup deletes only that namespace's keys, and
 * unrelated claim and outcome sentinels outside it are checked to be unchanged.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after } from 'node:test';
import { Redis } from 'ioredis';
import { Queue, Worker, type Job, type WorkerOptions } from 'bullmq';
import type { IssueJobData, JobResult } from '../../core/src/queue/taskQueue.types.js';
import { state, postFollowup, useLiveQueue, database, FIRST_COMMENT_ID } from './taskFollowupFixture.js';
import { openRequests, promptFor, dispatcherDeps, retryRequestStoreFor, dedupKey, requestChildId, postedComments, retryRuns } from './taskFollowupIssueDispatch.js';

// The production modules are imported once the fixture has installed its mocks.
const { handleDispatchWithDeps } = await import('../../../src/jobs/issueJobDispatcher.js');
const { redisRetryOutcomeEvidence, reserveIssueRetryRequest } = await import('../../core/src/services/issueRetryRequest.js');
const { enqueueIssueRetryRun, queueRetryRunEvidence } = await import('../../core/src/services/issueRetryRun.js');
const { processDetectedIssue } = await import('../../core/src/daemon/issueDetection.js');
export { reserveIssueRetryRequest, enqueueIssueRetryRun, queueRetryRunEvidence };
export type RetryRunChild = import('../../core/src/services/issueRetryRun.js').RetryRunChild;

const REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT = Number.parseInt(process.env.REDIS_PORT ?? '6379', 10);
const RUN_ID = `${process.pid}-${Date.now()}-${randomUUID()}`;
// The suite's own keys; nothing outside this namespace is written or deleted, but the sentinels.
const NAMESPACE = `propr-itest:issue-retry:${RUN_ID}:`;
export const JOB_ID = 'issue-integry-propr-14';
export const ORIGINAL = 'Retry with the original instructions';
export const DAY_MS = 24 * 60 * 60_000;
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
export const raw = connect();
export const owned = connect(NAMESPACE);
const reachable = await raw.connect().then(() => owned.connect()).then(() => raw.ping()).then(() => true, () => false);
if (!reachable && process.env.PROPR_REQUIRE_REDIS_INTEGRATION === '1') {
  throw new Error(`Redis is required for the issue retry queue integration suite but is not reachable at ${REDIS_HOST}:${REDIS_PORT}`);
}
export const skip = reachable ? false : `Redis is not reachable at ${REDIS_HOST}:${REDIS_PORT}`;
const clients: Redis[] = [];

/** The full names of the suite's keys matching `pattern` within its namespace. */
export async function ownedKeys(pattern = '*'): Promise<string[]> {
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

export const outcomeKeys = () => ownedKeys('issue:retry-outcome:*');
/** The queue's records of requested retries' runs, under its BullMQ prefix in the namespace, that are not retired. */
export async function runRecords(): Promise<string[]> {
  const records: string[] = [];
  for (const key of await ownedKeys('bull:*:retry-run:*')) if (!await raw.hexists(key, 'consumed')) records.push(key);
  return records;
}
/** The records of runs whose requests were recorded consumed, kept as their tombstones. */
export async function retiredRecords(): Promise<string[]> {
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

export type Settled = { event: 'completed'; job: Job<IssueJobData>; result: JobResult } | { event: 'failed'; job: Job<IssueJobData>; error: Error };
/** A child job's actual run: the job, and the prompt its agent would have been given. */
export interface ChildRun { jobId: string; data: IssueJobData; prompt: string }

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

export interface LiveQueue {
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
export async function until(done: () => Promise<boolean>, what: string) {
  for (let polls = 0; polls < 200; polls++) {
    if (await done()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(what);
}

/** What a test has the next dispatch or follow-up do, each taken once by the first it applies to. */
export const hooks: {
  /** The queue the next requested run is added through, in place of the real one, once. */
  nextRunQueue?: (queue: Queue) => Queue;
  /** Run once, after the next read of a request's run record by a dispatch's selection that finds a run, before it returns. */
  nextRunRead?: () => Promise<void>;
  /** Run once, before the next read of a request's run record by a dispatch's selection. */
  beforeRunRead?: () => Promise<void>;
  /** Run once, after Redis next accepts a follow-up's claim of the issue's label-event window, before the route continues. */
  afterClaimSet?: () => Promise<void>;
} = {};

/**
 * The queue seen through a connection that loses the reply to every
 * transaction: after Redis ran it, or before it reached Redis at all.
 */
export function replyLosingQueue(queue: Queue, ran: boolean): Queue {
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
export async function withLiveQueue(body: (live: LiveQueue) => Promise<void>) {
  await clearOwnedKeys('issue:*');
  const prefix = `${NAMESPACE}bull`;
  const queue = new Queue(`issue-retry-itest-${randomUUID()}`, { connection: raw, prefix });
  const children: LiveQueue['children'] = [];
  const runs: ChildRun[] = [];
  const dispatches: Array<JobResult | Error> = [];
  const stalls: string[] = [];
  // Runs are added to the real queue, with their record, in one transaction; the storage lifecycle guard is the production queue's.
  const selectionRuns = { ...retryRuns, read: async (held: Parameters<typeof retryRuns.read>[0]) => {
    const before = hooks.beforeRunRead;
    hooks.beforeRunRead = undefined;
    await before?.();
    const run = await retryRuns.read(held);
    const hook = run ? hooks.nextRunRead : undefined;
    if (hook) {
      hooks.nextRunRead = undefined;
      await hook();
    }
    return run;
  } };
  const store = retryRequestStoreFor(redisRetryOutcomeEvidence(() => owned), (held, runChildren, receiptEventId) => {
    const through = hooks.nextRunQueue?.(queue) ?? queue;
    hooks.nextRunQueue = undefined;
    return enqueueIssueRetryRun(through, held, runChildren, { receiptEventId, use: run => run() });
  }, selectionRuns);
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
  // so the queue's keys, such as its run records, are named relative to the namespace there. A test may suspend
  // the route once Redis has accepted its claim, before the route continues from that await.
  const routeRedis = new Proxy(owned, { get: (target, prop) => {
    if (prop === 'set') return async (...args: unknown[]) => {
      const result = await (target.set as unknown as (...setArgs: unknown[]) => Promise<unknown>)(...args);
      const hook = result === 'OK' && args[0] === dedupKey ? hooks.afterClaimSet : undefined;
      if (hook) {
        hooks.afterClaimSet = undefined;
        await hook();
      }
      return result;
    };
    const value = Reflect.get(target, prop, target) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  useLiveQueue(new Proxy(queue, { get: (target, prop) => {
    if (prop === 'client') return Promise.resolve(routeRedis);
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
export const livePoll = () => processDetectedIssue({
  id: 1014, number: 14, title: 'Issue', url: 'https://github.com/integry/propr/issues/14', repoOwner: 'integry', repoName: 'propr',
  labels: [...state.issueLabels], createdAt: '2026-10-15T09:00:00Z', updatedAt: '2026-10-15T10:00:01Z',
  triggeredBy: 'propr-dev[bot]', triggeredById: '99', source: 'polling',
}, 'live-poll', owned);

/** The settled job dispatched a run carrying `requester`'s request and instructions. */
export async function assertDispatched(settled: Settled, child: { data: IssueJobData } | undefined, { requester, commentId, instructions }: { requester: string; commentId: number; instructions: RegExp }) {
  assert.equal(settled.event, 'completed', settled.event === 'failed' ? settled.error.message : undefined);
  assert.equal(settled.event === 'completed' && settled.result.status, 'dispatched');
  assert.ok(child);
  assert.equal(child.data.userId, requester);
  assert.equal(child.data.retryRequesterId, requester);
  assert.equal(child.data.retryCommentId, commentId);
  assert.match(await promptFor(child.data), instructions);
}

/** The child job ran once, for `requester`'s request with its instructions and none of `foreign`. */
export function assertChildRun(run: ChildRun | undefined, { jobId, requester, commentId, instructions, foreign }: {
  jobId: string; requester: string; commentId: number; instructions: RegExp; foreign?: RegExp;
}) {
  assert.ok(run);
  assert.equal(run.jobId, jobId);
  assert.deepEqual([run.data.userId, run.data.retryRequesterId, run.data.retryCommentId], [requester, requester, commentId]);
  assert.match(run.prompt, instructions);
  if (foreign) assert.doesNotMatch(run.prompt, foreign);
}

export const routings = [['submission-backed', true], ['issue-only', false]] as const;

/** The failed parent (dispatcher) attempt, failing with `error`. */
export function assertFailedAttempt(settled: Settled, error: RegExp) {
  assert.equal(settled.event, 'failed');
  assert.match(settled.event === 'failed' ? settled.error.message : '', error);
}

/** The settled parent job completed with `result`. */
export function assertCompleted(settled: Settled, result: JobResult) {
  assert.equal(settled.event, 'completed', settled.event === 'failed' ? settled.error.message : undefined);
  assert.deepEqual(settled.event === 'completed' && settled.result, result);
}

export const alreadyDispatched = (backed: boolean): JobResult => backed
  ? { status: 'skipped', reason: 'submission_already_dispatched', issueNumber: 14 }
  : { status: 'skipped', reason: 'retry_request_already_dispatched', issueNumber: 14 };

/** Once the claim expires another user follows up with new instructions, which run once for them and for no one else. */
export async function assertNextFollowupRunsOnce(live: LiveQueue, earlierRuns: number, foreign = /First instructions/) {
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

/** The queue's record of the run it accepted for the request posted as `commentId`, retired or not. */
export const runRecordOf = async (live: LiveQueue, commentId: number) => {
  const { id } = await database('issue_retry_request_states').where({ comment_id: commentId }).first('id') as { id: number };
  return queueRetryRunEvidence(() => live.queue).accepted({ id, commentId });
};
