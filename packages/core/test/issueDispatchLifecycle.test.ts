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
  /** Set to hold the next add until it is released, as a producer suspended between its claim and its add. */
  held: { reached: () => void; gate: Promise<void> } | null = null;
  async add(name: string, data: Record<string, unknown>, opts: { jobId: string; attempts?: number }) {
    const held = this.held;
    this.held = null;
    if (held) { held.reached(); await held.gate; }
    // As BullMQ: an add under an ID that already exists is a no-op.
    if (!this.jobs.has(opts.jobId)) this.jobs.set(opts.jobId, new FakeJob(opts.jobId, name, data, opts.attempts ?? 1));
    return this.jobs.get(opts.jobId);
  }
  async getJob(jobId: string) { return this.jobs.get(jobId); }
  async getJobs(states: string[]) { return [...this.jobs.values()].filter(entry => states.includes(entry.state)); }
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

/** The final refusal of `target`, settled by the issue worker's failure handler. */
async function refuseFinally(target: FakeJob, issueQueue: { getJobs(states: string[]): Promise<FakeJob[]> } = queue): Promise<void> {
  target.data = { ...target.data, diskPressureDeferrals: 6, diskPressureSince: Date.now() - 61 * 60_000 };
  const final = await deferIssueJobOnDiskPressure(target, async () => { throw refusal(); }, { maxWaitMs: 60 * 60_000 }).catch(error => error as Error);
  assert.equal((final as Error).name, 'UnrecoverableError');
  target.attemptsMade++; target.state = 'failed'; target.finishedOn = Date.now();
  await settleIssueJobFailure(target, final as Error, { issueQueue });
}
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
  refuseFinally: (async () => { await refuseFinally(job()); }) as Step,
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

test('F5: a producer resuming after its dispatch was taken over does not run beside the newer dispatch', async () => {
  await setUpPlan('processing');
  let reached!: () => void;
  let release!: () => void;
  const atAdd = new Promise<void>(resolve => { reached = resolve; });
  queue.held = { reached, gate: new Promise<void>(resolve => { release = resolve; }) };
  // Producer A has committed its dispatch and is suspended before its job reaches the queue.
  const producerA = request();
  await atAdd;
  const claimedA = (await database('issue_dispatches').first())!;
  await database('issue_dispatches').update({ updated_at: Date.now() - ISSUE_DISPATCH_ABANDON_AFTER_MS - 1 });
  // Producer B finds A's job absent long after A's claim and takes the issue over.
  const producerB = await request();
  assert.equal(producerB.status, 'added');
  assert.notEqual(producerB.dispatchId, claimedA.dispatch_id);
  // A resumes and adds its job under its own ID.
  release();
  await producerA;
  const jobA = queue.jobs.get(claimedA.job_id)!;
  const jobB = queue.jobs.get(producerB.jobId)!;
  assert.ok(jobA && jobB, 'both jobs are in the queue');

  // A's job reaches admission: it is skipped before its processor, and B's dispatch does not move.
  jobA.state = 'active';
  await beginIssueJobAttempt(jobA);
  assert.equal(await recordIssueJobAdmitted(jobA), false, 'the superseded job does not enter its processor');
  jobA.state = 'completed';
  await settleIssueJobCompletion(jobA);
  let row = (await database('issue_dispatches').first())!;
  assert.deepEqual([row.dispatch_id, row.state, row.started_at], [producerB.dispatchId, 'queued', null]);
  const planIssue = await database('plan_issues').where({ draft_id: 'draft' }).first();
  assert.equal(planIssue.issue_dispatch_id, producerB.dispatchId, 'the plan issue follows the dispatch that took the issue over');

  // B's job is admitted as usual.
  jobB.state = 'active';
  await beginIssueJobAttempt(jobB);
  assert.equal(await recordIssueJobAdmitted(jobB), true);
  row = (await database('issue_dispatches').first())!;
  assert.deepEqual([row.dispatch_id, row.state, typeof row.started_at], [producerB.dispatchId, 'processing', 'number']);
  // A redelivery of a job whose dispatch ended but still holds the issue is not a takeover: it runs, and its dispatcher deduplicates it.
  jobB.state = 'completed';
  await settleIssueJobCompletion(jobB);
  assert.equal(await recordIssueJobAdmitted(jobB), true);
  assert.equal((await database('issue_dispatches').first())!.state, 'completed', 'the ended dispatch does not move');
});

test('F5: a superseded job refused for disk pressure until its wait ran out reports nothing and moves nothing', async () => {
  await setUpPlan('processing');
  await step.enqueue([]);
  const jobA = job();
  // A's job vanished long ago; B takes the issue over. A's job then turns up (its producer added it late).
  await step.abandon([]);
  const producerB = await request();
  queue.jobs.set(jobA.id, jobA);
  await database('plan_issues').where({ draft_id: 'draft' }).update({ status: 'processing' });
  jobA.state = 'active';
  await beginIssueJobAttempt(jobA);
  await refuseFinally(jobA);
  assert.equal(comments.length, 0, 'the issue is not told that its run stopped: B holds it');
  const row = (await database('issue_dispatches').first())!;
  assert.deepEqual([row.dispatch_id, row.state], [producerB.dispatchId, 'queued']);
  assert.equal((await database('plan_issues').where({ draft_id: 'draft' }).first()).status, 'processing');
});

/**
 * A plan issue whose dispatcher passed admission, queued `count` execution
 * children and completed: its dispatch is completed, the plan issue still
 * processing while execution is expected.
 */
async function completedDispatcherWithChildren(count: number): Promise<FakeJob[]> {
  await step.enqueue([]);
  await database('plan_issues').where({ draft_id: 'draft' }).whereIn('status', ['pending']).update({ status: 'processing' });
  await step.pickUp([]);
  await step.admit([]);
  const parent = job();
  const children = Array.from({ length: count }, (_, index) => {
    const child = new FakeJob(`${parent.id}-child-${index}`, 'processGitHubIssue', { ...parent.data, isChildJob: true }, 1);
    queue.jobs.set(child.id, child);
    return child;
  });
  parent.state = 'completed';
  await settleIssueJobCompletion(parent);
  assert.equal((await database('issue_dispatches').first())!.state, 'completed');
  return children;
}

/** A child picked up and refused at admission until its wait ran out, without entering its processor. */
async function refuseChild(child: FakeJob, issueQueue?: { getJobs(states: string[]): Promise<FakeJob[]> }): Promise<void> {
  child.state = 'active';
  await beginIssueJobAttempt(child);
  await refuseFinally(child, issueQueue);
}

const planStatus = async (draftId = 'draft') => (await database('plan_issues').where({ draft_id: draftId }).first()).status;

test('F6: the final refusal of the last unstarted child of a completed dispatcher blocks its plan issue for retry', async () => {
  await setUpPlan('epic-queue');
  const [child] = await completedDispatcherWithChildren(1);
  await refuseChild(child);
  assert.equal(await planStatus(), 'pending', 'the plan issue is no longer processing');
  const head = (await getEpicExecutionQueue('draft'))!.items[0];
  assert.deepEqual([head.state, head.blockedKind, head.blockedReason], ['blocked', 'dispatch_failed', diskPressureRefusedReason(ISSUE)]);
  await startEpicQueueHead('draft', { startIssue, now: () => Date.now() + 60_000 });
  assert.deepEqual(starts, [], 'the refused issue is not dispatched again at once');
  assert.equal(comments.length, 1);
  assert.match(comments[0], /or retry the issue from its plan\./);
  assert.equal((await database('issue_dispatches').first())!.state, 'completed', 'the child does not move the dispatch');
});

test('F6: a refused child leaves its plan issue processing while a sibling is still in flight, and the last refusal releases it', async () => {
  await setUpPlan('processing');
  const [first, second] = await completedDispatcherWithChildren(2);
  await refuseChild(first);
  assert.equal(await planStatus(), 'processing', 'the sibling still waiting may yet run');
  second.state = 'delayed';
  await refuseChild(second);
  assert.equal(await planStatus(), 'pending');
  assert.equal(comments.length, 2, 'each refused child is reported on the issue');
});

test('F6: a refused child leaves a plan issue a newer dispatch took over', async () => {
  await setUpPlan('processing');
  const [child] = await completedDispatcherWithChildren(1);
  // A newer request starts a new dispatch of the issue; the plan issue now points at it.
  const newer = await request();
  assert.equal(newer.status, 'added');
  await refuseChild(child);
  const planIssue = await database('plan_issues').where({ draft_id: 'draft' }).first();
  assert.deepEqual([planIssue.status, planIssue.issue_dispatch_id], ['processing', newer.dispatchId]);
  const row = (await database('issue_dispatches').first())!;
  assert.deepEqual([row.dispatch_id, row.state], [newer.dispatchId, 'queued']);
});

test('F6: a refused child leaves a finished plan issue as it is', async () => {
  await setUpPlan('merged');
  const [child] = await completedDispatcherWithChildren(1);
  await refuseChild(child);
  assert.equal(await planStatus(), 'merged');
  assert.equal(comments.length, 1);
});

test('F6: a refused child leaves its plan issue to a dispatcher that will run again', async () => {
  await setUpPlan('processing');
  await step.enqueue([]);
  await database('plan_issues').where({ draft_id: 'draft' }).update({ status: 'processing' });
  await step.pickUp([]);
  await step.admit([]);
  const parent = job();
  const child = new FakeJob(`${parent.id}-child`, 'processGitHubIssue', { ...parent.data, isChildJob: true }, 1);
  queue.jobs.set(child.id, child);
  // The dispatcher failed after queueing its child; BullMQ retries it.
  await step.failAndRetry([]);
  await refuseChild(child);
  assert.equal(await planStatus(), 'processing');
});

test('F6: a refused child leaves its plan issue as it is when the queue cannot be read', async () => {
  await setUpPlan('processing');
  const [child] = await completedDispatcherWithChildren(1);
  await refuseChild(child, { getJobs: async () => { throw new Error('Connection is closed.'); } });
  assert.equal(await planStatus(), 'processing', 'executions in flight are unknown, so nothing is released');
  assert.equal(comments.length, 1);
});

/**
 * A newer dispatch takes the issue over from a completed dispatcher whose child
 * is still deferred; the newer dispatcher selects the same execution, and its
 * add deduplicates against the retained child (child job IDs are deterministic),
 * which keeps the older dispatch ID. Returns the newer dispatch ID and its parent job.
 */
async function newerDispatcherReusing(child: FakeJob): Promise<{ newerId: string; newerParent: FakeJob }> {
  child.state = 'delayed';
  const newer = await request();
  assert.equal(newer.status, 'added');
  const newerParent = queue.jobs.get(newer.jobId)!;
  jobs = [newerParent];
  await step.pickUp([]);
  await step.admit([]);
  await queue.add('processGitHubIssue', { ...newerParent.data, isChildJob: true }, { jobId: child.id });
  assert.notEqual(queue.jobs.get(child.id)!.data.issueDispatchId, newer.dispatchId, 'the retained child keeps the older dispatch ID');
  await step.complete([]);
  return { newerId: newer.dispatchId, newerParent };
}

test('F7: a retained child a newer dispatcher reused releases the plan issue once it is the last execution in flight', async () => {
  await setUpPlan('epic-queue');
  const [child] = await completedDispatcherWithChildren(1);
  const { newerId } = await newerDispatcherReusing(child);
  await refuseChild(child);
  const planIssue = await database('plan_issues').where({ draft_id: 'draft' }).first();
  assert.deepEqual([planIssue.status, planIssue.issue_dispatch_id], ['pending', newerId], 'released, still linked to the newer dispatch');
  const head = (await getEpicExecutionQueue('draft'))!.items[0];
  assert.deepEqual([head.state, head.blockedKind], ['blocked', 'dispatch_failed']);
  assert.equal(comments.length, 1);
  assert.match(comments[0], /or retry the issue from its plan\./);
  const row = (await database('issue_dispatches').first())!;
  assert.deepEqual([row.dispatch_id, row.state], [newerId, 'completed'], 'the child does not move the newer dispatch');
});

test('F7: a retained child a newer dispatcher reused leaves the plan issue to that dispatcher\'s other executions in flight', async () => {
  await setUpPlan('processing');
  const [child] = await completedDispatcherWithChildren(1);
  const { newerParent } = await newerDispatcherReusing(child);
  const other = new FakeJob(`${newerParent.id}-child-other`, 'processGitHubIssue', { ...newerParent.data, isChildJob: true }, 1);
  queue.jobs.set(other.id, other);
  await refuseChild(child);
  assert.equal(await planStatus(), 'processing', 'the newer dispatch\'s other child may yet run');
  await refuseChild(other);
  assert.equal(await planStatus(), 'pending');
});

test('F7: a retained child leaves the plan issue to a newer dispatcher still running', async () => {
  await setUpPlan('processing');
  const [child] = await completedDispatcherWithChildren(1);
  child.state = 'delayed';
  const newer = await request();
  jobs = [queue.jobs.get(newer.jobId)!];
  await step.pickUp([]);
  await step.admit([]);
  await refuseChild(child);
  assert.equal(await planStatus(), 'processing');
});

/** A dispatcher that queued a child, then failed after it (recording its receipt) and was retried by BullMQ. */
async function dispatcherFailedAfterQueueingChild(): Promise<{ parent: FakeJob; child: FakeJob }> {
  await step.enqueue([]);
  await database('plan_issues').where({ draft_id: 'draft' }).update({ status: 'processing' });
  await step.pickUp([]);
  await step.admit([]);
  const parent = job();
  const child = new FakeJob(`${parent.id}-child`, 'processGitHubIssue', { ...parent.data, isChildJob: true }, 1);
  queue.jobs.set(child.id, child);
  await step.failAndRetry([]);
  return { parent, child };
}

for (const childState of ['waiting', 'delayed', 'active']) {
  test(`F8: a parent refused for good after queueing a child leaves its plan issue while that child is ${childState}`, async () => {
    await setUpPlan('epic-queue');
    const { child } = await dispatcherFailedAfterQueueingChild();
    child.state = childState;
    await step.pickUp([]);
    await step.refuseFinally([]);
    assert.equal((await database('issue_dispatches').first())!.state, 'failed', 'the dispatcher\'s dispatch ends');
    assert.equal(await planStatus(), 'processing', 'the child may still run');
    const head = (await getEpicExecutionQueue('draft'))!.items[0];
    assert.notEqual(head.state, 'blocked', 'the execution is not marked as a failed dispatch');
    // The child is refused in turn: nothing of the issue is in flight any more.
    await refuseChild(child);
    assert.equal(await planStatus(), 'pending');
    const released = (await getEpicExecutionQueue('draft'))!.items[0];
    assert.deepEqual([released.state, released.blockedKind], ['blocked', 'dispatch_failed']);
  });
}

test('F8: a parent refused for good leaves its plan issue as it is when the queue cannot be read', async () => {
  await setUpPlan('processing');
  await dispatcherFailedAfterQueueingChild();
  await step.pickUp([]);
  await refuseFinally(job(), { getJobs: async () => { throw new Error('Connection is closed.'); } });
  assert.equal((await database('issue_dispatches').first())!.state, 'failed');
  assert.equal(await planStatus(), 'processing');
});
