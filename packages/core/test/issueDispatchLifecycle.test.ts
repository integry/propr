/**
 * The issue dispatch lifecycle (`issueDispatch.ts`), table-driven: each case
 * runs a sequence of what the enqueue paths and the issue worker do (enqueue,
 * a job picked up, a disk-pressure deferral, admission, an ordinary failure, a
 * final refusal, completion) against one SQLite database and a queue that can
 * only add jobs, and checks the dispatch row, the jobs, the plan issue and the
 * report on the issue.
 *
 * Together the cases cover what the earlier job-ID replacement design got
 * wrong: a request racing another (F1) and a replacement deleting another
 * request's job (F2) cannot happen, since jobs are only ever added, under
 * fresh IDs, and deduplication is one transaction on the row; a refusal
 * changes only the plan issue that points at its dispatch (F3); and the report
 * claims that nothing changed only when the row recorded no started attempt (F4).
 */
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { up as epicQueues } from '../src/db/migrations/20261003000000_add_epic_execution_queues.js';
import { up as finalization } from '../src/db/migrations/20261003010000_add_epic_queue_finalization.js';
import { up as useEpic } from '../src/db/migrations/20261003020000_add_epic_queue_use_epic.js';
import { up as parallel } from '../src/db/migrations/20261003030000_add_epic_queue_parallel.js';
import { up as recovery } from '../src/db/migrations/20261003040000_add_epic_queue_recovery_intent.js';
import { up as issueStates } from '../src/db/migrations/20261112130000_add_epic_queue_issue_states.js';
import { up as graph } from '../src/db/migrations/20261112140000_add_epic_queue_graph.js';
import { up as blockedEvents } from '../src/db/migrations/20261113000000_add_epic_queue_blocked_events.js';
import { up as issueDispatches } from '../src/db/migrations/20261128000000_create_issue_dispatches.js';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const log = { info() {}, warn() {}, error() {}, debug() {}, withCorrelation: () => log };
const comments: string[] = [];
const starts: number[] = [];
const startIssue = async ({ issueNumber }: { issueNumber: number }) => { starts.push(issueNumber); };
await mock.module('../src/db/connection.js', { namedExports: { db: database } });
await mock.module('../src/utils/logger.js', { defaultExport: log });
await mock.module('../src/utils/eventPublisher.js', { namedExports: { getEventPublisher: () => ({ publishActivity: async () => {} }) } });
await mock.module('../src/config/planIssueDefaults.js', { namedExports: { resolvePlanIssueDefaultSelection: async () => ({}) } });
await mock.module('../src/services/taskPlanningService.js', { namedExports: { checkAndUpdateDraftStatus: async () => {} } });
await mock.module('../src/services/taskPlanning/epicIssueLabelHandoff.js', { namedExports: { releaseEpicIssueLabels: async () => {} } });
await mock.module('../src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => ({
  request: async (_route: string, params: { body: string }) => { comments.push(params.body); return {}; },
}) } });
await mock.module('../src/webhook/planIssueTrigger.js', { namedExports: {
  labelPlanIssueForProcessing: startIssue,
  reconcileTerminalInProgressIssues: async (_repository: string, issues: unknown[]) => issues,
  finalizeEpicPlanIfComplete: async () => true,
} });

const { enqueueIssueDispatch, findIssueDispatch, settleIssueDispatch, ISSUE_DISPATCH_ABANDON_AFTER_MS } = await import('../src/queue/issueDispatch.js');
const { beginIssueJobAttempt, deferIssueJobOnDiskPressure, recordIssueJobAdmitted } = await import('../src/queue/issueDiskPressureDeferral.js');
const { settleIssueJobCompletion, settleIssueJobFailure } = await import('../src/queue/issueJobSettlement.js');
const { WorktreeDiskPressureError } = await import('../src/storage/lifecycle.js');
const { createEpicExecutionQueue, getEpicExecutionQueue, startEpicQueueHead } = await import('../src/services/taskPlanning/epicExecutionQueue.js');
const { diskPressureRefusedReason } = await import('../src/services/taskPlanning/epicQueueBlockedHead.js');

await database.schema.createTable('task_drafts', table => {
  table.string('draft_id').primary(); table.boolean('paused').defaultTo(false); table.text('context_config');
});
await database.schema.createTable('plan_issues', table => {
  table.increments('id'); table.string('draft_id'); table.string('repository'); table.integer('issue_number'); table.integer('pr_number');
  table.string('status'); table.string('task_id'); table.timestamp('updated_at'); table.timestamp('created_at').defaultTo(database.fn.now());
});
for (const migrate of [epicQueues, finalization, useEpic, parallel, recovery, issueStates, graph, blockedEvents, issueDispatches]) await migrate(database);
after(async () => database.destroy());

const ISSUE = 7;
const MEASURED = { filesystem: '/tmp/git-processor/worktrees', freeBytes: 6.2 * 1024 ** 3, reserveBytes: 2 * 1024 ** 3, reservedBytes: 4 * 1024 ** 3, claimCount: 4, taskBytes: 1024 ** 3 };
const DETAILS = 'filesystem /tmp/git-processor/worktrees: free 6.2 GiB < required 7.0 GiB = reserve 2.0 GiB + 4 other claims × 1.0 GiB + this job 1.0 GiB';

/** A queue that can only add jobs and read them: no job can be removed or replaced. */
class AddOnlyQueue {
  jobs = new Map<string, FakeJob>();
  async add(name: string, data: Record<string, unknown>, opts: { jobId: string; attempts?: number }) {
    // As BullMQ: an add under an ID that already exists is a no-op.
    if (!this.jobs.has(opts.jobId)) this.jobs.set(opts.jobId, new FakeJob(opts.jobId, name, data, opts.attempts ?? 1));
    return this.jobs.get(opts.jobId);
  }
  async getJob(jobId: string) { return this.jobs.get(jobId); }
}

class FakeJob {
  state = 'waiting';
  attemptsMade = 0;
  finishedOn?: number;
  token = 'token';
  opts: { attempts: number };
  constructor(readonly id: string, readonly name: string, public data: Record<string, unknown>, attempts: number) { this.opts = { attempts }; }
  async getState() { return this.state; }
  async updateData(data: Record<string, unknown>) { this.data = data; }
  async moveToDelayed() { this.state = 'delayed'; }
}

let queue: AddOnlyQueue;
let jobs: FakeJob[];
const job = () => jobs.at(-1)!;
const request = () => enqueueIssueDispatch(queue, {
  name: 'processGitHubIssue', data: { repoOwner: 'acme', repoName: 'repo', number: ISSUE, triggeringLabel: 'AI', correlationId: 'corr' },
  opts: { attempts: 3, removeOnComplete: true, removeOnFail: true },
}, { database });
const refusal = () => new WorktreeDiskPressureError(MEASURED);

type Step = (outcomes: string[]) => Promise<void>;
const step = {
  /** The daemon or the plan route requests a run of the issue. */
  enqueue: (async outcomes => { outcomes.push((await request()).status); jobs = [...queue.jobs.values()]; }) as Step,
  /** Two requests at the same moment (webhook and polling, or two `implement_plan` calls). */
  enqueueTwice: (async outcomes => { outcomes.push(...(await Promise.all([request(), request()])).map(o => o.status).sort()); jobs = [...queue.jobs.values()]; }) as Step,
  /** The worker picks the job up. */
  pickUp: (async () => { job().state = 'active'; await beginIssueJobAttempt(job()); }) as Step,
  /** Admission refuses the attempt; the same job waits. */
  defer: (async () => {
    await assert.rejects(deferIssueJobOnDiskPressure(job(), async () => { throw refusal(); }, { maxWaitMs: 60 * 60_000 }), { name: 'DelayedError' });
  }) as Step,
  /** Admission passes; the processor runs. */
  admit: (async () => { await recordIssueJobAdmitted(job()); }) as Step,
  /** The processor fails; BullMQ retries the job. */
  failAndRetry: (async () => { job().attemptsMade++; job().state = 'delayed'; await settleIssueJobFailure(job(), new Error('processor failed')); }) as Step,
  /** The processor fails on the last attempt. */
  failFinally: (async () => {
    job().attemptsMade = job().opts.attempts; job().state = 'failed'; job().finishedOn = Date.now();
    await settleIssueJobFailure(job(), new Error('processor failed'));
  }) as Step,
  /** Admission refuses again after the total wait ran out: the job fails for good on that refusal. */
  refuseFinally: (async () => {
    job().data = { ...job().data, diskPressureDeferrals: 6, diskPressureSince: Date.now() - 61 * 60_000 };
    const final = await deferIssueJobOnDiskPressure(job(), async () => { throw refusal(); }, { maxWaitMs: 60 * 60_000 }).catch(error => error as Error);
    assert.equal((final as Error).name, 'UnrecoverableError');
    job().attemptsMade++; job().state = 'failed'; job().finishedOn = Date.now();
    await settleIssueJobFailure(job(), final as Error);
  }) as Step,
  complete: (async () => { job().state = 'completed'; await settleIssueJobCompletion(job()); }) as Step,
  /** The issue joins a newer plan after the dispatch was enqueued: that plan issue does not point at it. */
  newerDraft: (async () => {
    await database('task_drafts').insert({ draft_id: 'newer', context_config: '{}' });
    await database('plan_issues').insert({ draft_id: 'newer', repository: 'acme/repo', issue_number: ISSUE, status: 'processing', created_at: '2999-01-01 00:00:00' });
  }) as Step,
  /** The job ends, but the worker has not recorded that on the row yet. */
  finishUnrecorded: (async () => { job().state = 'completed'; }) as Step,
  /** The job is not in the queue (yet, or any more) moments after the row last changed. */
  loseJob: (async () => { queue.jobs.clear(); }) as Step,
  /** The row last changed long ago and its job is gone, as when the process that owned it died. */
  abandon: (async () => {
    queue.jobs.clear();
    await database('issue_dispatches').update({ updated_at: Date.now() - ISSUE_DISPATCH_ABANDON_AFTER_MS - 1 });
  }) as Step,
};

type PlanSetup = 'none' | 'processing' | 'merged' | 'epic-queue';
interface Case {
  name: string;
  plan?: PlanSetup;
  steps: Step[];
  outcomes?: string[];
  state: string;
  started: boolean;
  /** Jobs the queue holds; none is ever removed. */
  jobCount: number;
  planStatus?: string;
  comment?: RegExp[];
  notInComment?: RegExp[];
  check?: () => Promise<void>;
}

const NEVER_STARTED = [/could not start on this issue/, /No attempt of this run started, so nothing was changed\./];
const STARTED_BEFORE = [/stopped retrying this issue/, /latest attempt was refused/, /after earlier attempts of this run had already run/];
const NO_ASSURANCES = [/nothing was changed/i, /changed nothing/i, /branch/i, /commit/i, /pull request/i];

const cases: Case[] = [
  { name: 'a first request queues a dispatch under a fresh job ID', steps: [step.enqueue], outcomes: ['added'], state: 'queued', started: false, jobCount: 1,
    check: async () => {
      const row = (await findIssueDispatch({ owner: 'acme', repo: 'repo', number: ISSUE }, { database }))!;
      assert.equal(job().id, `issue-acme-repo-${ISSUE}-${row.dispatch_id}`);
      assert.equal(job().data.issueDispatchId, row.dispatch_id);
    } },
  { name: 'F1: a request while the dispatch is queued is served by it', steps: [step.enqueue, step.enqueue], outcomes: ['added', 'already_queued'],
    state: 'queued', started: false, jobCount: 1 },
  { name: 'F1: two concurrent requests queue exactly one dispatch', steps: [step.enqueueTwice], outcomes: ['added', 'already_queued'],
    state: 'queued', started: false, jobCount: 1 },
  { name: 'a request while the dispatch is deferred for disk space is served by it', steps: [step.enqueue, step.pickUp, step.defer, step.enqueue],
    outcomes: ['added', 'already_queued'], state: 'deferred', started: false, jobCount: 1,
    check: async () => {
      assert.equal(job().state, 'delayed');
      assert.equal(job().attemptsMade, 0, 'the deferral does not consume the attempt budget');
      const row = (await database('issue_dispatches').first())!;
      assert.ok(Number(row.retry_at) >= Date.now() + 60_000, 'the retry is minutes away');
      assert.equal(row.details, DETAILS);
    } },
  { name: 'a request while the dispatch is processing is served by it', steps: [step.enqueue, step.pickUp, step.admit, step.enqueue],
    outcomes: ['added', 'already_queued'], state: 'processing', started: true, jobCount: 1 },
  { name: 'deferred → queued when picked up again → processing once admitted', steps: [step.enqueue, step.pickUp, step.defer, step.pickUp],
    state: 'queued', started: false, jobCount: 1,
    check: async () => {
      await step.admit([]);
      const row = (await database('issue_dispatches').first())!;
      assert.deepEqual([row.state, row.retry_at, typeof row.started_at], ['processing', null, 'number']);
      assert.equal(job().data.diskPressureDeferrals, undefined, 'admission ends the wait, so a later refusal starts a new one');
    } },
  { name: 'F2: a request after the dispatch completed queues a new one beside the old job', steps: [step.enqueue, step.pickUp, step.admit, step.complete, step.enqueue],
    outcomes: ['added', 'added'], state: 'queued', started: false, jobCount: 2,
    check: async () => {
      const [first, second] = [...queue.jobs.values()];
      assert.notEqual(first.id, second.id);
      assert.equal(first.state, 'completed', 'the earlier job is left as it is');
      // A late event of the old dispatch does not move the new one.
      first.attemptsMade = 3; first.finishedOn = Date.now();
      await settleIssueJobFailure(first, new Error('late'));
      assert.equal((await database('issue_dispatches').first())!.state, 'queued');
    } },
  { name: 'a request after the dispatch failed for good queues a new one', steps: [step.enqueue, step.pickUp, step.admit, step.failFinally, step.enqueue],
    outcomes: ['added', 'added'], state: 'queued', started: false, jobCount: 2 },
  { name: 'a request just after the job finished, before the worker recorded it, starts a new dispatch',
    steps: [step.enqueue, step.pickUp, step.admit, step.finishUnrecorded, step.enqueue], outcomes: ['added', 'added'], state: 'queued', started: false, jobCount: 2 },
  { name: 'a running dispatch whose job is gone no longer blocks the issue', steps: [step.enqueue, step.pickUp, step.admit, step.loseJob, step.enqueue],
    outcomes: ['added', 'added'], state: 'queued', started: false, jobCount: 1 },
  { name: 'a queued dispatch whose job is missing moments after its claim (not added yet) still serves the request', steps: [step.enqueue, step.loseJob, step.enqueue],
    outcomes: ['added', 'already_queued'], state: 'queued', started: false, jobCount: 0 },
  { name: 'an active dispatch whose job vanished long ago no longer blocks the issue', steps: [step.enqueue, step.abandon, step.enqueue],
    outcomes: ['added', 'added'], state: 'queued', started: false, jobCount: 1 },
  { name: 'F4: a final refusal with no started attempt says nothing was changed', plan: 'processing',
    steps: [step.enqueue, step.pickUp, step.defer, step.pickUp, step.refuseFinally],
    state: 'failed', started: false, jobCount: 1, planStatus: 'pending',
    comment: [...NEVER_STARTED, /waited about 61 minutes/, /or retry the issue from its plan\./] },
  { name: 'F4: an ordinary failure, then a final refusal of the retry, gives no assurances', plan: 'processing',
    steps: [step.enqueue, step.pickUp, step.admit, step.failAndRetry, step.pickUp, step.refuseFinally],
    state: 'failed', started: true, jobCount: 1, planStatus: 'pending', comment: STARTED_BEFORE, notInComment: NO_ASSURANCES },
  { name: 'F3: a final refusal leaves a plan issue that does not point at the dispatch alone', plan: 'processing',
    steps: [step.enqueue, step.newerDraft, step.pickUp, step.refuseFinally],
    state: 'failed', started: false, jobCount: 1, planStatus: 'pending', comment: NEVER_STARTED,
    check: async () => {
      assert.equal((await database('plan_issues').where({ draft_id: 'newer' }).first()).status, 'processing', 'the newer plan issue keeps its status');
    } },
  { name: 'F3: a final refusal leaves a finished plan issue that points at the dispatch alone', plan: 'merged',
    steps: [step.enqueue, step.pickUp, step.refuseFinally], state: 'failed', started: false, jobCount: 1, planStatus: 'merged',
    comment: NEVER_STARTED },
  { name: 'F3: a refusal of a dispatch already ended changes no plan issue', plan: 'processing',
    steps: [step.enqueue, step.pickUp, step.admit, step.failFinally, step.refuseFinally],
    state: 'failed', started: true, jobCount: 1, planStatus: 'processing', comment: STARTED_BEFORE },
  { name: 'a final refusal of an issue outside any plan is still reported', steps: [step.enqueue, step.pickUp, step.refuseFinally],
    state: 'failed', started: false, jobCount: 1, comment: [...NEVER_STARTED, /remove the `AI` label from this issue and add it again\.$/] },
  { name: 'a final refusal of a queued epic issue blocks it in its execution', plan: 'epic-queue',
    steps: [step.enqueue, step.pickUp, step.refuseFinally], state: 'failed', started: false, jobCount: 1, planStatus: 'pending', comment: NEVER_STARTED,
    check: async () => {
      const head = (await getEpicExecutionQueue('draft'))!.items[0];
      assert.deepEqual([head.state, head.blockedKind, head.blockedReason], ['blocked', 'dispatch_failed', diskPressureRefusedReason(ISSUE)]);
      await startEpicQueueHead('draft', { startIssue, now: () => Date.now() + 60_000 });
      assert.deepEqual(starts, [], 'the refused issue is not dispatched again at once');
    } },
];

beforeEach(async () => {
  for (const table of ['epic_execution_queue_issues', 'epic_execution_queues', 'plan_issues', 'task_drafts', 'issue_dispatches']) await database(table).delete();
  queue = new AddOnlyQueue();
  jobs = [];
  comments.length = 0;
  starts.length = 0;
});

async function setUpPlan(plan: PlanSetup): Promise<void> {
  if (plan === 'none') return;
  await database('task_drafts').insert({ draft_id: 'draft', context_config: '{}' });
  await database('plan_issues').insert({ draft_id: 'draft', repository: 'acme/repo', issue_number: ISSUE, status: plan === 'merged' ? 'merged' : 'pending' });
  if (plan === 'epic-queue') {
    await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [ISSUE, ISSUE + 1] }, { startIssue, now: () => Date.now() - 60 * 60_000 });
    await startEpicQueueHead('draft', { startIssue, now: () => Date.now() - 60 * 60_000 });
    starts.length = 0;
  }
}

for (const c of cases) {
  test(c.name, async () => {
    await setUpPlan(c.plan ?? 'none');
    const outcomes: string[] = [];
    for (const [index, run] of c.steps.entries()) {
      await run(outcomes);
      // The plan route marks its issue processing once it has enqueued the dispatch.
      if (index === 0 && (c.plan === 'processing' || c.plan === 'epic-queue')) {
        await database('plan_issues').where({ draft_id: 'draft' }).update({ status: 'processing' });
      }
    }
    if (c.outcomes) assert.deepEqual(outcomes, c.outcomes);
    const rows = await database('issue_dispatches');
    assert.equal(rows.length, 1, 'one row per issue');
    assert.equal(rows[0].state, c.state);
    assert.equal(rows[0].started_at !== null, c.started, 'started_at');
    assert.equal(queue.jobs.size, c.jobCount);
    if (c.planStatus) assert.equal((await database('plan_issues').where({ draft_id: 'draft' }).first()).status, c.planStatus);
    if (c.comment || c.notInComment) {
      assert.equal(comments.length, 1, 'one report on the issue');
      for (const pattern of c.comment ?? []) assert.match(comments[0], pattern);
      for (const pattern of c.notInComment ?? []) assert.doesNotMatch(comments[0].split('Measured at the last refusal:')[0], pattern);
      assert.ok(comments[0].includes(`Measured at the last refusal:\n\n\`\`\`\n${DETAILS}\n\`\`\``), 'the free-space numbers are reported');
    } else {
      assert.equal(comments.length, 0);
    }
    await c.check?.();
  });
}

test('a refused child job reports on its dispatch as it stands and moves nothing', async () => {
  await step.enqueue([]);
  await step.pickUp([]);
  await step.admit([]);
  await step.complete([]);
  const parent = job();
  const child = new FakeJob(`${parent.id}-child`, 'processGitHubIssue', { ...parent.data, isChildJob: true }, 1);
  jobs.push(child);
  await step.refuseFinally([]);
  assert.equal((await database('issue_dispatches').first())!.state, 'completed');
  assert.equal(comments.length, 1);
  for (const pattern of STARTED_BEFORE) assert.match(comments[0], pattern);
});

test('a job without a dispatch row (queued before rows existed) is reported without claims either way', async () => {
  const legacy = new FakeJob('issue-acme-repo-7', 'processGitHubIssue', { repoOwner: 'acme', repoName: 'repo', number: ISSUE, triggeringLabel: 'AI' }, 3);
  jobs = [legacy];
  await step.refuseFinally([]);
  assert.equal(comments.length, 1);
  assert.match(comments[0], /ProPR has no record of whether earlier attempts of this run ran/);
  assert.doesNotMatch(comments[0], /nothing was changed/i);
});

test('a dispatch whose job could not be added ends, so the next request queues a new one', async () => {
  const failing = Object.assign(new AddOnlyQueue(), { add: async () => { throw new Error('Connection is closed.'); } });
  const data = { repoOwner: 'acme', repoName: 'repo', number: ISSUE };
  await assert.rejects(enqueueIssueDispatch(failing, { name: 'processGitHubIssue', data, opts: {} }, { database }), /Connection is closed/);
  assert.equal((await database('issue_dispatches').first())!.state, 'failed');
  assert.equal((await enqueueIssueDispatch(queue, { name: 'processGitHubIssue', data, opts: {} }, { database })).status, 'added');
});

test('transitions are fenced on the dispatch: an ended dispatch does not move again', async () => {
  await step.enqueue([]);
  const { dispatch_id: id } = (await database('issue_dispatches').first())!;
  assert.equal(await settleIssueDispatch(id, 'completed', { database }), true);
  for (const outcome of ['retrying', 'failed', 'completed'] as const) assert.equal(await settleIssueDispatch(id, outcome, { database }), false);
  assert.equal((await database('issue_dispatches').first())!.state, 'completed');
});
