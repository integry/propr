import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { up } from '../src/db/migrations/20260922000000_add_task_submissions.js';
import { up as identityMigration } from '../src/db/migrations/20260922010000_preserve_task_submission_identity.js';
import { closeConnection } from '../src/db/connection.js';
import { findIssueSubmission, insertTaskSubmission, resumeTaskSubmission, type TaskSubmission } from '../src/services/taskSubmissionService.js';
import {
  finalizeSubmissionIntakeFailure, queueSubmissionIntakeEvidence, reconcileSubmissionIntake, submissionIntakeJobId,
  type IntakeJobState, type SubmissionIntakeEvidence,
} from '../src/services/taskSubmissionIntake.js';
import type { IssueJobData } from '../src/queue/taskQueue.types.js';

after(closeConnection);

const ADMISSION = 'Worktree disk pressure: admission reserve unavailable; data retained';
const JOB_ID = submissionIntakeJobId('owner', 'repo', 34);
const ISSUE_URL = 'https://github.com/owner/repo/issues/34';

async function fixture() {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await up(database);
  await identityMigration(database);
  const row = await insertTaskSubmission(database, { user_id: '297689653', submission_key: 'key-1', payload_hash: 'hash', repository: 'owner/repo',
    payload: JSON.stringify({ instruction: 'Audit the repository', agentAlias: 'astra', model: 'gpt-6-astra', routingLabel: 'llm-astra', trigger: 'AI', username: 'ultrafix' }),
    attachments: JSON.stringify([{ id: 'a1', originalName: 'notes.txt', mimeType: 'text/plain', content: 'bm90ZXM=', extension: '.txt' }]) });
  // The observed submission: accepted, its issue created and its intake queued, without a task.
  await database('task_submissions').where({ id: row.id }).update({ state: 'queued', issue_number: 34, issue_url: ISSUE_URL });
  return { database, id: row.id };
}

const read = (database: Knex, id: string) => database<TaskSubmission>('task_submissions').where({ id }).first() as Promise<TaskSubmission>;

function intakeJob(id: string, overrides: Partial<{ attemptsMade: number; finishedOn: number | undefined; timestamp: number; data: Partial<IssueJobData>; name: string }> = {}) {
  return {
    id: JOB_ID, name: overrides.name ?? 'processGitHubIssue', timestamp: overrides.timestamp ?? 1_000,
    attemptsMade: overrides.attemptsMade ?? 3, finishedOn: 'finishedOn' in overrides ? overrides.finishedOn : 2_000,
    data: { repoOwner: 'owner', repoName: 'repo', number: 34, userId: '297689653', correlationId: id, triggeringLabel: 'AI', ...overrides.data } as IssueJobData,
  };
}

const finalizerDeps = (database: Knex, current: IntakeJobState = { state: 'absent' }) => ({
  database, findSubmission: (issue: IssueJobData) => findIssueSubmission(issue, database), job: async () => current,
});

test('an intake job that exhausts its attempts before its processor runs makes the submission retryable', async () => {
  const { database, id } = await fixture();
  try {
    // BullMQ retries the first two attempts: the submission stays queued, not falsely terminal.
    for (const attemptsMade of [1, 2]) {
      assert.equal(await finalizeSubmissionIntakeFailure(intakeJob(id, { attemptsMade, finishedOn: undefined }), new Error(ADMISSION), finalizerDeps(database)), 'retrying');
      assert.equal((await read(database, id)).state, 'queued');
    }
    assert.equal(await finalizeSubmissionIntakeFailure(intakeJob(id), new Error(ADMISSION), finalizerDeps(database)), 'recorded');
    const failed = await read(database, id);
    assert.equal(failed.state, 'failed');
    assert.match(failed.error!, /^Implementation did not start after 3 attempts: Worktree disk pressure: admission reserve unavailable; data retained\. /);
    assert.match(failed.error!, /Retry agent starts this same issue again without creating another/);
    // The issue, identity, owner, selection and attachments are kept as they were.
    assert.equal(failed.issue_number, 34);
    assert.equal(failed.issue_url, ISSUE_URL);
    assert.equal(failed.user_id, '297689653');
    assert.equal(failed.submission_key, 'key-1');
    assert.equal(JSON.parse(failed.payload).model, 'gpt-6-astra');
    assert.equal(JSON.parse(failed.attachments)[0].originalName, 'notes.txt');
    assert.equal(failed.task_id, null);
    assert.equal(failed.dispatch_complete, 0 as unknown as boolean);
  } finally { await database.destroy(); }
});

test('child runs, other jobs and newer deliveries under the same job ID never settle the intake', async () => {
  const { database, id } = await fixture();
  try {
    const error = new Error(ADMISSION);
    assert.equal(await finalizeSubmissionIntakeFailure(intakeJob(id, { data: { isChildJob: true } }), error, finalizerDeps(database)), 'ignored');
    assert.equal(await finalizeSubmissionIntakeFailure(intakeJob(id, { name: 'processPullRequestComment' }), error, finalizerDeps(database)), 'ignored');
    assert.equal(await finalizeSubmissionIntakeFailure(undefined, error, finalizerDeps(database)), 'ignored');
    // A webhook or poll re-added the intake job after the failed one was removed: it is live, or delayed for its backoff.
    for (const current of [{ state: 'live', timestamp: 5_000 }, { state: 'completed', timestamp: 5_000 }, { state: 'failed', timestamp: 5_000, reason: 'other' }] as IntakeJobState[]) {
      assert.equal(await finalizeSubmissionIntakeFailure(intakeJob(id), error, finalizerDeps(database, current)), 'superseded');
    }
    assert.equal((await read(database, id)).state, 'queued');
    // The failed job itself, kept by a queue that retains failures, is not a newer delivery.
    assert.equal(await finalizeSubmissionIntakeFailure(intakeJob(id), error, finalizerDeps(database, { state: 'failed', timestamp: 1_000, reason: ADMISSION })), 'recorded');
  } finally { await database.destroy(); }
});

test('a dispatch receipt, an associated task or a concurrent retry claim fences a late intake failure', async () => {
  for (const change of [{ dispatch_complete: true }, { task_id: 'task-1', latest_task_id: 'task-1' }, { latest_task_id: 'task-2' }, { dispatch_claim: 'claim' }, { state: 'issue_created' }]) {
    const { database, id } = await fixture();
    try {
      await database('task_submissions').where({ id }).update(change);
      const before = await read(database, id);
      assert.equal(await finalizeSubmissionIntakeFailure(intakeJob(id), new Error(ADMISSION), finalizerDeps(database)), 'ignored');
      // A claim taken between the read and the write is fenced by the write itself.
      const { recordSubmissionIntakeFailure } = await import('../src/services/taskSubmissionIntake.js');
      assert.equal(await recordSubmissionIntakeFailure(database, id, { reason: ADMISSION }), false);
      assert.deepEqual(await read(database, id), before);
    } finally { await database.destroy(); }
  }
});

function evidence(job: IntakeJobState, failures: Array<{ timestamp: number }> = []): SubmissionIntakeEvidence & { reads: number } {
  const store = {
    reads: 0,
    job: async (jobId: string) => { assert.equal(jobId, JOB_ID); store.reads++; return job; },
    failures: async () => {
      const latest = Math.max(...failures.map(entry => entry.timestamp));
      const count = failures.filter(entry => entry.timestamp === latest).length;
      return count ? { timestamp: latest, failures: count, reason: ADMISSION } : null;
    },
  };
  return store;
}

test('a legacy queued submission is settled only by an established intake outcome', async () => {
  const exhausted = [{ timestamp: 1_000 }, { timestamp: 1_000 }, { timestamp: 1_000 }];
  const cases: Array<[string, IntakeJobState, Array<{ timestamp: number }>, TaskSubmission['state']]> = [
    ['an intake job still live, or delayed for its backoff', { state: 'live', timestamp: 1_000 }, exhausted, 'queued'],
    ['an intake job that completed', { state: 'completed', timestamp: 1_000 }, exhausted, 'queued'],
    ['an absent job without recorded failures, whatever its age', { state: 'absent' }, [], 'queued'],
    ['an absent job whose last attempt is not recorded yet', { state: 'absent' }, exhausted.slice(1), 'queued'],
    ['an absent job whose newer instance failed only once', { state: 'absent' }, [...exhausted, { timestamp: 9_000 }], 'queued'],
    ['an absent job whose latest instance failed every attempt', { state: 'absent' }, exhausted, 'failed'],
    ['a failed job the queue kept', { state: 'failed', timestamp: 1_000, reason: ADMISSION }, [], 'failed'],
  ];
  for (const [name, job, failures, expected] of cases) {
    const { database, id } = await fixture();
    try {
      const row = await reconcileSubmissionIntake(database, await read(database, id), evidence(job, failures));
      assert.equal(row.state, expected, name);
      assert.equal((await read(database, id)).state, expected, name);
      if (expected === 'failed') assert.match(row.error!, /Worktree disk pressure/, name);
      else assert.equal(row.error, null, name);
    } finally { await database.destroy(); }
  }
});

test('a dispatched, task-associated or claimed submission is never checked against the queue', async () => {
  for (const change of [{ dispatch_complete: true }, { task_id: 'task-1', latest_task_id: 'task-1' }, { dispatch_claim: 'claim' }, { state: 'failed' }]) {
    const { database, id } = await fixture();
    try {
      await database('task_submissions').where({ id }).update(change);
      const store = evidence({ state: 'failed', timestamp: 1_000, reason: ADMISSION });
      const row = await reconcileSubmissionIntake(database, await read(database, id), store);
      assert.equal(store.reads, 0);
      assert.deepEqual(row, await read(database, id));
    } finally { await database.destroy(); }
  }
});

test('retrying a failed intake reuses the original issue and dispatches it once, however many retries race', async () => {
  const { database, id } = await fixture();
  try {
    await finalizeSubmissionIntakeFailure(intakeJob(id), new Error(ADMISSION), finalizerDeps(database));
    let creates = 0;
    const dispatches: Array<{ issue: number; recovering: boolean }> = [];
    const services = {
      createIssue: async () => { creates++; return { number: 99, url: 'https://github.com/owner/repo/issues/99' }; },
      reconcileIssue: async () => { creates++; return null; },
      dispatch: async (row: TaskSubmission, recovering: boolean) => {
        dispatches.push({ issue: row.issue_number!, recovering });
        await new Promise(resolve => setTimeout(resolve, 10));
      },
    };
    const results = await Promise.all([resumeTaskSubmission(database, id, services), resumeTaskSubmission(database, id, services), resumeTaskSubmission(database, id, services)]);
    assert.equal(creates, 0);
    assert.deepEqual(dispatches, [{ issue: 34, recovering: true }]);
    assert.ok(results.every(result => result.issue_number === 34));
    const queued = await read(database, id);
    assert.equal(queued.state, 'queued');
    assert.equal(queued.error, null);
    // A queued submission is not dispatched again by a further retry.
    await resumeTaskSubmission(database, id, services);
    assert.equal(dispatches.length, 1);
    // The superseded first intake's late failure does not undo the retry's new one while it is live.
    assert.equal(await finalizeSubmissionIntakeFailure(intakeJob(id), new Error(ADMISSION), finalizerDeps(database, { state: 'live', timestamp: 7_000 })), 'superseded');
    assert.equal((await read(database, id)).state, 'queued');
  } finally { await database.destroy(); }
});

test('the queue evidence reads the job by ID and counts only the latest instance\'s recorded failures for the submission', async () => {
  const { database, id } = await fixture();
  try {
    const row = await read(database, id);
    const created = Date.parse(`${String((row as TaskSubmission & { created_at: string }).created_at).replace(' ', 'T')}Z`);
    // A sorted set holds each member once; attempts differ by their execution time.
    const entry = (correlationId: string, timestamp: number, attempt: number, status = 'failed') => JSON.stringify({ correlationId, timestamp, status, error: ADMISSION, executionTimeMs: attempt });
    const log = [entry(id, created + 1, 1), entry(id, created + 1, 2), entry('other', created + 2, 1), entry(id, created + 1, 4, 'success'), 'not json', entry(id, created + 1, 3)];
    let jobs: Record<string, { timestamp: number; failedReason?: string; state: string }> = {};
    const calls: unknown[][] = [];
    const queue = {
      getJob: async (jobId: string) => jobs[jobId] ? { ...jobs[jobId], getState: async () => jobs[jobId].state } : undefined,
      client: Promise.resolve({ zrangebyscore: async (...args: unknown[]) => { calls.push(args); return log; } }),
    };
    const store = queueSubmissionIntakeEvidence(() => queue);
    assert.deepEqual(await store.job(JOB_ID), { state: 'absent' });
    assert.deepEqual(await store.failures(row), { timestamp: created + 1, failures: 3, reason: ADMISSION });
    assert.equal(calls[0][0], 'metrics:ai:log:v1');
    assert.equal(calls[0][1], created - 60_000);
    for (const [state, expected] of [['delayed', 'live'], ['waiting', 'live'], ['active', 'live'], ['completed', 'completed'], ['unknown', 'absent']]) {
      jobs = { [JOB_ID]: { timestamp: 5, state } };
      assert.equal((await store.job(JOB_ID)).state, expected, state);
    }
    jobs = { [JOB_ID]: { timestamp: 5, state: 'failed', failedReason: ADMISSION } };
    assert.deepEqual(await store.job(JOB_ID), { state: 'failed', timestamp: 5, reason: ADMISSION });
  } finally { await database.destroy(); }
});

test('a dispatcher attempt BullMQ will retry leaves the submission queued; only its last attempt fails it', async () => {
  const { database, id } = await fixture();
  try {
    const { handleDispatchWithDeps } = await import('../../../src/jobs/issueJobDispatcher.js');
    const { resolveTaskSubmissionRetry } = await import('../src/services/taskSubmissionRetry.js');
    const events = [{ id: 1, event: 'labeled', created_at: '2026-10-18T08:00:00Z', label: { name: 'AI' }, actor: { id: 123 } }];
    const failures: string[] = [];
    const deps = {
      resolveSubmissionRetry: (submission: Parameters<typeof resolveTaskSubmissionRetry>[0]) => resolveTaskSubmissionRetry(submission, database,
        async () => ({ request: async () => ({ data: events }) }) as never, async () => ['AI']),
      findSubmission: (issue: IssueJobData) => findIssueSubmission(issue, database),
      recordDispatch: async () => undefined,
      recordDispatchFailure: async (submissionId: string, message: string) => {
        failures.push(message);
        await database('task_submissions').where({ id: submissionId, dispatch_complete: false }).update({ state: 'failed', error: message });
      },
      getAuthenticatedOctokit: async () => { throw new Error('GitHub unavailable'); },
      withRetry: async (operation: () => Promise<unknown>) => operation(), retryConfigs: { githubApi: {} },
      issueQueue: { add: async () => assert.fail('No child may be enqueued') },
    } as unknown as Parameters<typeof handleDispatchWithDeps>[1];
    const attempt = (attemptsMade: number) => handleDispatchWithDeps({ id: JOB_ID, name: 'processGitHubIssue', attemptsMade, opts: { attempts: 3 },
      data: { repoOwner: 'owner', repoName: 'repo', number: 34, userId: '297689653', correlationId: id } } as never, deps);
    for (const attemptsMade of [0, 1]) {
      await assert.rejects(attempt(attemptsMade), /GitHub unavailable/);
      assert.equal((await read(database, id)).state, 'queued');
    }
    assert.deepEqual(failures, []);
    await assert.rejects(attempt(2), /GitHub unavailable/);
    assert.deepEqual(failures, ['GitHub unavailable']);
    assert.equal((await read(database, id)).state, 'failed');
  } finally { await database.destroy(); }
});

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { opened, open };
};

// A retry that enqueues a new intake, live under the same job ID, and restores the submission to queued.
const retryInto = (queue: { current: IntakeJobState }) => ({
  createIssue: async () => assert.fail('The existing issue is reused'),
  reconcileIssue: async () => assert.fail('The existing issue is reused'),
  dispatch: async () => { queue.current = { state: 'live', timestamp: 7_000 }; },
});

test('a poll that read an earlier intake\'s failures before a retry does not fail the retried, live intake', async () => {
  const { database, id } = await fixture();
  try {
    const queue: { current: IntakeJobState } = { current: { state: 'absent' } };
    const reading = gate();
    const suspended = gate();
    let first = true;
    const stale: SubmissionIntakeEvidence = {
      job: async () => queue.current,
      failures: async () => {
        // The first intake's three recorded failures, returned once a retry has replaced it.
        if (first) { first = false; reading.open(); await suspended.opened; }
        return { timestamp: 1_000, failures: 3, reason: ADMISSION };
      },
    };
    const poll = reconcileSubmissionIntake(database, await read(database, id), stale);
    await reading.opened;
    // Meanwhile the worker records the exhausted intake, and the user retries it.
    assert.equal(await finalizeSubmissionIntakeFailure(intakeJob(id), new Error(ADMISSION), finalizerDeps(database)), 'recorded');
    assert.equal((await resumeTaskSubmission(database, id, retryInto(queue))).state, 'queued');
    suspended.open();
    assert.equal((await poll).state, 'queued');
    const row = await read(database, id);
    assert.equal(row.state, 'queued');
    assert.equal(row.error, null);
  } finally { await database.destroy(); }
});

test('a worker finalizer that checked the queue before a retry does not fail the retried, live intake', async () => {
  const { database, id } = await fixture();
  try {
    const queue: { current: IntakeJobState } = { current: { state: 'absent' } };
    const checking = gate();
    const suspended = gate();
    let first = true;
    const finalizing = finalizeSubmissionIntakeFailure(intakeJob(id), new Error(ADMISSION), {
      database, findSubmission: (issue: IssueJobData) => findIssueSubmission(issue, database),
      job: async () => {
        if (!first) return queue.current;
        first = false; checking.open(); await suspended.opened;
        return { state: 'absent' };
      },
    });
    await checking.opened;
    // A poll records the exhausted intake from its retained failure, and the user retries it.
    const failed = await reconcileSubmissionIntake(database, await read(database, id), evidence({ state: 'failed', timestamp: 1_000, reason: ADMISSION }));
    assert.equal(failed.state, 'failed');
    assert.equal((await resumeTaskSubmission(database, id, retryInto(queue))).state, 'queued');
    suspended.open();
    assert.equal(await finalizing, 'unchanged');
    assert.equal((await read(database, id)).state, 'queued');
  } finally { await database.destroy(); }
});

test('an intake failure is not recorded while a retry holds the submission\'s dispatch lock', async () => {
  const { database, id } = await fixture();
  try {
    await database('task_submissions').where({ id }).update({ state: 'failed', error: 'earlier' });
    const dispatching = gate();
    const dispatched = gate();
    const retry = resumeTaskSubmission(database, id, {
      createIssue: async () => assert.fail('The existing issue is reused'), reconcileIssue: async () => assert.fail('The existing issue is reused'),
      dispatch: async () => { dispatching.open(); await dispatched.opened; },
    });
    await dispatching.opened;
    // The retry's claim is cleared but its lock is held: a finalizer that read the row before must not write.
    await database('task_submissions').where({ id }).update({ state: 'queued', dispatch_claim: null });
    assert.equal(await finalizeSubmissionIntakeFailure(intakeJob(id), new Error(ADMISSION), finalizerDeps(database)), 'busy');
    assert.equal((await read(database, id)).state, 'queued');
    dispatched.open();
    await retry;
  } finally { await database.destroy(); }
});

test('the queue evidence finds an intake\'s failures past any number of unrelated log entries', async () => {
  const { database, id } = await fixture();
  try {
    const { FAILURE_LOG_PAGE } = await import('../src/services/taskSubmissionIntake.js');
    const row = await read(database, id);
    const created = Date.parse(`${String((row as TaskSubmission & { created_at: string }).created_at).replace(' ', 'T')}Z`);
    const entry = (correlationId: string, timestamp: number, attempt: number) =>
      JSON.stringify({ correlationId, timestamp, status: 'failed', error: ADMISSION, executionTimeMs: attempt });
    // Unrelated jobs from the skew margin on, then the intake's three failures, the first closing a page.
    const unrelated = Array.from({ length: 2 * FAILURE_LOG_PAGE - 1 }, (_, n) => entry(`other-${n}`, created - 30_000 + n, 0));
    const log = [...unrelated, entry(id, created + 2 * FAILURE_LOG_PAGE, 1), entry(id, created + 2 * FAILURE_LOG_PAGE, 2), entry(id, created + 2 * FAILURE_LOG_PAGE, 3)];
    const pages: number[] = [];
    const client = {
      zrangebyscore: async (_key: string, _min: number, _max: string, _limit: string, offset: number, count: number) => {
        pages.push(offset);
        const page = log.slice(offset, offset + count);
        // An older job's entry lands below the offset between pages, shifting the next page back by one.
        if (pages.length === 2) log.unshift(entry('late', created - 40_000, 0));
        return page;
      },
    };
    const store = queueSubmissionIntakeEvidence(() => ({ getJob: async () => undefined, client }));
    assert.deepEqual(await store.failures(row), { timestamp: created + 2 * FAILURE_LOG_PAGE, failures: 3, reason: ADMISSION });
    assert.deepEqual(pages, [0, FAILURE_LOG_PAGE, 2 * FAILURE_LOG_PAGE]);
    // And so a legacy submission waiting on that exhausted intake is settled.
    assert.equal((await reconcileSubmissionIntake(database, row, { job: async () => ({ state: 'absent' }), failures: () => store.failures(row) })).state, 'failed');
  } finally { await database.destroy(); }
});
