import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Knex } from 'knex';
import { createStatsRoutes } from '../routes/statsRoutes.js';
import { getTasksFromDb } from '../routes/taskHelpers.js';
import { MAX_WORK_ROWS } from '../routes/dashboardQueries.js';
import {
  NOW,
  call,
  clearDashboardTestDatabase,
  createDashboardTestDatabase,
  createTestDashboardRoutes,
  daysAgo,
  minutesAgo,
  seedTask as seedTaskInto,
  type QueueStub,
  type TaskSeed,
} from './dashboardTestHarness.js';

let database: Knex;

before(async () => { database = await createDashboardTestDatabase(); });
after(async () => database.destroy());
beforeEach(async () => clearDashboardTestDatabase(database));

const seedTask = (seed: TaskSeed): Promise<void> => seedTaskInto(database, seed);
const routes = (queue?: QueueStub, liveDetails?: Parameters<typeof createTestDashboardRoutes>[2]) =>
  createTestDashboardRoutes(database, queue, liveDetails);

test('summary returns four integer counts that match the active endpoint for the same filter', async () => {
  await seedTask({ taskId: 'running-1', issueNumber: 11, states: [{ state: 'claude_execution', timestamp: minutesAgo(10) }] });
  await seedTask({ taskId: 'running-2', issueNumber: 12, states: [{ state: 'post_processing', timestamp: minutesAgo(8) }] });
  await seedTask({ taskId: 'queued-1', issueNumber: 13, states: [{ state: 'pending', timestamp: minutesAgo(6) }] });
  await seedTask({ taskId: 'failed-1', issueNumber: 14, states: [{ state: 'failed', timestamp: minutesAgo(30), reason: 'Tests failed' }] });
  await seedTask({ taskId: 'done-1', issueNumber: 15, states: [{ state: 'completed', timestamp: minutesAgo(45) }] });
  await seedTask({ taskId: 'other-repo', repository: 'acme/web', issueNumber: 2, states: [{ state: 'claude_execution', timestamp: minutesAgo(5) }] });

  const dashboard = routes();
  const summary = await call(dashboard.getSummary, { repository: 'all' });
  assert.equal(summary.status, 200);
  for (const key of ['needsAttention', 'running', 'queued', 'completedRecently']) {
    assert.ok(Number.isInteger(summary.body[key]), `${key} must be an integer`);
  }
  assert.deepEqual(
    { needsAttention: summary.body.needsAttention, running: summary.body.running, queued: summary.body.queued, completedRecently: summary.body.completedRecently },
    { needsAttention: 1, running: 3, queued: 1, completedRecently: 1 },
  );

  const active = await call(dashboard.getActive, { repository: 'all' });
  assert.deepEqual(active.body.counts, { running: summary.body.running, queued: summary.body.queued });
  assert.equal((active.body.queue as { queuedCount: number }).queuedCount, summary.body.queued);

  const scopedSummary = await call(dashboard.getSummary, { repository: 'integry/propr' });
  const scopedActive = await call(dashboard.getActive, { repository: 'integry/propr' });
  assert.equal(scopedSummary.body.running, 2);
  assert.deepEqual(scopedActive.body.counts, { running: scopedSummary.body.running, queued: scopedSummary.body.queued });
  assert.equal((scopedActive.body.running as unknown[]).length, scopedSummary.body.running);
});

/** The task page behind a dashboard count. */
async function taskPage(status: string, repository: string, limit = 0): Promise<{ total: number; ids: string[] }> {
  const page = await getTasksFromDb({
    db: database,
    status,
    repository,
    limit,
    offset: 0,
    previewReader: { project: async (rows: unknown[]) => rows.map(() => ({ previews: [] })) } as never,
  });
  return { total: page.total, ids: (page.tasks as Array<{ id: string }>).map(task => task.id) };
}

const taskPageTotal = async (status: string, repository: string): Promise<number> =>
  (await taskPage(status, repository)).total;

test('the dashboard and the task pages count the same work for the same filter', async () => {
  await seedTask({ taskId: 'count-running-1', issueNumber: 111, states: [{ state: 'claude_execution', timestamp: minutesAgo(12) }] });
  await seedTask({ taskId: 'count-running-2', issueNumber: 112, states: [{ state: 'processing', timestamp: minutesAgo(11) }] });
  await seedTask({ taskId: 'count-queued-1', issueNumber: 113, states: [{ state: 'queued', timestamp: minutesAgo(10) }] });
  await seedTask({ taskId: 'count-queued-2', issueNumber: 114, states: [{ state: 'pending', timestamp: minutesAgo(9) }] });
  await seedTask({ taskId: 'count-blocked', issueNumber: 115, states: [{ state: 'failed', timestamp: minutesAgo(8), reason: 'Boom' }] });
  await seedTask({ taskId: 'count-waiting-human', issueNumber: 116, states: [{ state: 'action_required', timestamp: minutesAgo(7) }] });
  // Goal tasks and other repositories stay out of the scoped counts on both sides.
  await seedTask({ taskId: 'count-goal', issueNumber: 117, taskType: 'goal', states: [{ state: 'claude_execution', timestamp: minutesAgo(6) }] });
  await seedTask({ taskId: 'count-elsewhere', repository: 'acme/web', issueNumber: 1, states: [{ state: 'claude_execution', timestamp: minutesAgo(5) }] });

  const dashboard = routes();
  for (const repository of ['all', 'integry/propr']) {
    const summary = await call(dashboard.getSummary, { repository });
    const active = await call(dashboard.getActive, { repository });
    const attention = await call(dashboard.getAttention, { repository });

    // One definition, three readings: the strip, the live section and the list
    // the count links to must never disagree.
    assert.deepEqual(active.body.counts, { running: summary.body.running, queued: summary.body.queued });
    assert.equal((attention.body.counts as { total: number }).total, summary.body.needsAttention);
    assert.equal(await taskPageTotal('active', repository), summary.body.running);
    assert.equal(await taskPageTotal('waiting', repository), summary.body.queued);
    assert.equal(await taskPageTotal('attention', repository), summary.body.needsAttention);
  }

  const scoped = await call(dashboard.getSummary, { repository: 'integry/propr' });
  assert.deepEqual(
    { running: scoped.body.running, queued: scoped.body.queued, needsAttention: scoped.body.needsAttention },
    { running: 2, queued: 2, needsAttention: 2 },
  );
});

test('a failed task that is being retried appears in active and not in attention', async () => {
  await seedTask({
    taskId: 'retried', issueNumber: 21,
    states: [{ state: 'failed', timestamp: minutesAgo(40), reason: 'Transient failure' }, { state: 'processing', timestamp: minutesAgo(5) }],
  });
  await seedTask({ taskId: 'retry-run', issueNumber: 22, createdAt: minutesAgo(60), states: [{ state: 'failed', timestamp: minutesAgo(50), reason: 'Flaky' }] });
  // A newer run of the same issue thread is queued: the system is already fixing it.
  await seedTask({ taskId: 'retry-run-2', issueNumber: 22, createdAt: minutesAgo(4), states: [{ state: 'queued', timestamp: minutesAgo(4) }] });
  await seedTask({ taskId: 'unresolved', issueNumber: 23, states: [{ state: 'failed', timestamp: minutesAgo(45), reason: 'Compile error' }] });

  const dashboard = routes();
  const attention = await call(dashboard.getAttention, { repository: 'all' });
  const ids = (attention.body.items as Array<{ taskId: string }>).map(item => item.taskId);
  assert.deepEqual(ids, ['unresolved']);

  const active = await call(dashboard.getActive, { repository: 'all' });
  const activeIds = [
    ...(active.body.running as Array<{ taskId: string }>).map(item => item.taskId),
    ...(active.body.queued as Array<{ taskId: string }>).map(item => item.taskId),
  ];
  assert.deepEqual(activeIds.sort(), ['retried', 'retry-run-2']);
});

test('a failure superseded by a later successful run is not attention', async () => {
  await seedTask({ taskId: 'first-attempt', issueNumber: 31, createdAt: daysAgo(1), states: [{ state: 'failed', timestamp: daysAgo(1), reason: 'Bad patch' }] });
  await seedTask({ taskId: 'second-attempt', issueNumber: 31, createdAt: minutesAgo(90), states: [{ state: 'completed', timestamp: minutesAgo(60) }] });

  const attention = await call(routes().getAttention, { repository: 'all' });
  assert.deepEqual(attention.body.items, []);
  assert.deepEqual(attention.body.counts, { blocked: 0, decisions: 0, total: 0 });
});

test('attention lists every item newest first, whatever its kind', async () => {
  await seedTask({ taskId: 'blocked-new', issueNumber: 41, states: [{ state: 'failed', timestamp: minutesAgo(10), reason: 'Newer failure' }] });
  await seedTask({ taskId: 'blocked-old', issueNumber: 42, states: [{ state: 'failed', timestamp: minutesAgo(120), reason: 'Older failure' }] });
  await seedTask({ taskId: 'needs-human', issueNumber: 43, states: [{ state: 'action_required', timestamp: minutesAgo(60), reason: 'Credentials expired' }] });
  await database('plan_issues').insert([
    { draft_id: 'draft-1', repository: 'integry/propr', issue_number: 51, pr_number: 501, status: 'under_review', task_id: null, created_at: daysAgo(3), updated_at: minutesAgo(30) },
    { draft_id: 'draft-1', repository: 'integry/propr', issue_number: 52, pr_number: 502, status: 'under_review', task_id: null, created_at: daysAgo(3), updated_at: minutesAgo(300) },
    { draft_id: 'draft-1', repository: 'integry/propr', issue_number: 53, pr_number: 503, status: 'processing', task_id: null, created_at: daysAgo(3), updated_at: minutesAgo(5) },
    { draft_id: 'draft-1', repository: 'integry/propr', issue_number: 54, pr_number: null, status: 'pending', task_id: null, created_at: daysAgo(3), updated_at: minutesAgo(5) },
  ]);

  const attention = await call(routes().getAttention, { repository: 'all' });
  const items = attention.body.items as Array<{ id: string; category: string; kind: string; taskType: string | null }>;
  assert.deepEqual(items.map(item => item.id), [
    'task:blocked-new', 'plan-issue:1', 'task:needs-human', 'task:blocked-old', 'plan-issue:2',
  ]);
  assert.deepEqual(items.map(item => item.taskType), ['issue', null, 'issue', 'issue', null]);
  assert.deepEqual(attention.body.counts, { blocked: 3, decisions: 2, total: 5 });
});

test('running work is listed newest first', async () => {
  await seedTask({ taskId: 'run-old', issueNumber: 45, createdAt: minutesAgo(90), states: [{ state: 'claude_execution', timestamp: minutesAgo(1) }] });
  await seedTask({ taskId: 'run-new', issueNumber: 46, createdAt: minutesAgo(5), states: [{ state: 'processing', timestamp: minutesAgo(4) }] });
  await seedTask({ taskId: 'run-mid', issueNumber: 47, createdAt: minutesAgo(30), states: [{ state: 'post_processing', timestamp: minutesAgo(20) }] });

  const active = await call(routes().getActive, { repository: 'all' });
  const running = active.body.running as Array<{ taskId: string; taskType: string | null }>;
  assert.deepEqual(running.map(item => item.taskId), ['run-new', 'run-mid', 'run-old']);
  assert.deepEqual(running.map(item => item.taskType), ['issue', 'issue', 'issue']);
});

test('a review decision is titled by the work behind it, never by its own chip', async () => {
  await seedTask({
    taskId: 'titled-run', issueNumber: 71, prNumber: 710,
    title: 'Cache repository icons across dashboard sections',
    states: [{ state: 'completed', timestamp: minutesAgo(80) }],
  });
  await seedTask({ taskId: 'untitled-run', issueNumber: 72, prNumber: 720, states: [{ state: 'completed', timestamp: minutesAgo(70) }] });
  // A run queued from a pull request records no title of its own, only the
  // branch it works on — which still says more than the PR number does.
  await database('tasks').where({ task_id: 'untitled-run' })
    .update({ initial_job_data: JSON.stringify({ branchName: 'feature/icon-cache' }) });
  await database('plan_issues').insert([
    { draft_id: 'draft-4', repository: 'integry/propr', issue_number: 71, pr_number: 710, status: 'under_review', task_id: 'titled-run', created_at: daysAgo(1), updated_at: minutesAgo(30) },
    { draft_id: 'draft-4', repository: 'integry/propr', issue_number: 72, pr_number: 720, status: 'under_review', task_id: null, created_at: daysAgo(1), updated_at: minutesAgo(20) },
  ]);

  const attention = await call(routes().getAttention, { repository: 'all' });
  const decisions = (attention.body.items as Array<Record<string, unknown>>).filter(item => item.kind === 'plan_review');
  // A plan issue has no title column, so the decision inherits one from the
  // run on its thread. Leaving it null left the UI to print `Pull request
  // #720` beside a `PR #720` chip, which tells a reviewer nothing.
  assert.deepEqual(decisions.map(item => item.title), [
    'feature/icon-cache',
    'Cache repository icons across dashboard sections',
  ]);
  assert.deepEqual(decisions.map(item => item.taskId), ['untitled-run', 'titled-run']);
});

test('dismissing every notification for a failed task leaves the task in attention', async () => {
  await seedTask({ taskId: 'blocked-task', issueNumber: 61, states: [{ state: 'failed', timestamp: minutesAgo(20), reason: 'Boom' }] });
  // Two inbox notifications about the same failure, for two different people.
  await database('notification_events').insert([
    {
      event_id: 'event-failed-1', deduplication_key: 'task-failed:blocked-task', kind: 'task_failed',
      target_json: JSON.stringify({ type: 'task', repository: 'integry/propr', taskId: 'blocked-task', issueNumber: 61 }),
      title: 'Task failed', body: 'Boom', occurred_at: minutesAgo(20),
    },
    {
      event_id: 'event-failed-2', deduplication_key: 'task-failed:blocked-task:retry', kind: 'task_failed',
      target_json: JSON.stringify({ type: 'task', repository: 'integry/propr', taskId: 'blocked-task', issueNumber: 61 }),
      title: 'Task failed again', body: 'Boom', occurred_at: minutesAgo(19),
    },
  ]);
  await database('notification_user_states').insert([
    { event_id: 'event-failed-1', user_id: 'user-1', read_at: minutesAgo(18), dismissed_at: null },
    { event_id: 'event-failed-2', user_id: 'user-1', read_at: minutesAgo(18), dismissed_at: null },
    { event_id: 'event-failed-1', user_id: 'user-2', read_at: null, dismissed_at: null },
  ]);

  const dashboard = routes();
  const before = await call(dashboard.getAttention, { repository: 'all' });
  assert.deepEqual((before.body.items as Array<{ taskId: string }>).map(item => item.taskId), ['blocked-task']);

  // Every recipient dismisses every notification about the failure.
  const dismissed = await database('notification_user_states').update({ dismissed_at: minutesAgo(1) });
  assert.equal(dismissed, 3);
  assert.equal(await database('notification_user_states').whereNull('dismissed_at').first(), undefined);

  const after = await call(dashboard.getAttention, { repository: 'all' });
  // A cleared inbox is not a resolved blocker: the item and its counts are unchanged.
  assert.deepEqual(after.body, before.body);
  assert.deepEqual((after.body.items as Array<{ taskId: string; kind: string }>).map(item => item.kind), ['task_failed']);
  assert.deepEqual(after.body.counts, { blocked: 1, decisions: 0, total: 1 });

  // And the same is true of the count the summary strip shows.
  const summary = await call(dashboard.getSummary, { repository: 'all' });
  assert.equal(summary.body.needsAttention, 1);
});

test('active reports a phase label and a live progress line, and leaves the line null when unknown', async () => {
  await seedTask({ taskId: 'live-task', issueNumber: 71, states: [{ state: 'claude_execution', timestamp: minutesAgo(3) }] });
  await seedTask({ taskId: 'silent-task', issueNumber: 72, states: [{ state: 'post_processing', timestamp: minutesAgo(2) }] });
  await seedTask({ taskId: 'waiting-task', issueNumber: 73, states: [{ state: 'queued', timestamp: minutesAgo(1) }] });

  const dashboard = routes({}, async taskId =>
    taskId === 'live-task' ? { currentTask: 'Running the test suite' } : null);
  const active = await call(dashboard.getActive, { repository: 'all' });

  const running = active.body.running as Array<Record<string, unknown>>;
  const live = running.find(item => item.taskId === 'live-task');
  const silent = running.find(item => item.taskId === 'silent-task');
  assert.deepEqual([live?.phase, live?.progressLine], ['Implementing', 'Running the test suite']);
  assert.deepEqual([silent?.phase, silent?.progressLine], ['Finishing up', null]);
  assert.ok(!('progress' in (live ?? {})), 'no synthesised percentage progress');

  const queued = active.body.queued as Array<Record<string, unknown>>;
  assert.deepEqual([queued[0].phase, queued[0].progressLine], ['Waiting', null]);
});

test('queue reason is null unless the backend knows why work is waiting', async () => {
  await seedTask({ taskId: 'queued-task', issueNumber: 81, states: [{ state: 'pending', timestamp: minutesAgo(9) }] });

  const idle = await call(routes({ activeCount: 0, workers: 2 }).getActive, { repository: 'all' });
  assert.equal((idle.body.queue as { reason: string | null }).reason, null);

  // Two workers of one slot each, three jobs running: capacity really is gone.
  const busy = await call(routes({ activeCount: 3, workers: 2 }).getActive, { repository: 'all' });
  assert.equal((busy.body.queue as { reason: string | null }).reason, 'All agents are busy');

  // One active job against ten published slots is not a busy fleet, so the
  // backend has no verified explanation to offer.
  const spare = await call(routes({ activeCount: 1, workers: 2, capacityPerWorker: 5 }).getActive, { repository: 'all' });
  assert.equal((spare.body.queue as { reason: string | null }).reason, null);

  const exhausted = await call(routes({ activeCount: 10, workers: 2, capacityPerWorker: 5 }).getActive, { repository: 'all' });
  assert.equal((exhausted.body.queue as { reason: string | null }).reason, 'All agents are busy');

  // A live worker that publishes no capacity leaves the total unknown, and an
  // unknown total can never be declared exhausted.
  const unknown = await call(routes({ activeCount: 9, workers: 2, capacityPerWorker: null }).getActive, { repository: 'all' });
  assert.equal((unknown.body.queue as { reason: string | null }).reason, null);

  const paused = await call(routes({ paused: true, activeCount: 3, workers: 2 }).getActive, { repository: 'all' });
  assert.equal((paused.body.queue as { reason: string | null }).reason, 'Queue processing is paused');

  const noWorkers = await call(routes({ activeCount: 0, workers: 0 }).getActive, { repository: 'all' });
  assert.equal((noWorkers.body.queue as { reason: string | null }).reason, 'No workers are running');
});

test('queue reason stays null when nothing is queued', async () => {
  await seedTask({ taskId: 'only-running', issueNumber: 91, states: [{ state: 'processing', timestamp: minutesAgo(4) }] });
  const active = await call(routes({ paused: true, activeCount: 5, workers: 0 }).getActive, { repository: 'all' });
  assert.deepEqual(active.body.queue, { queuedCount: 0, reason: null });
});

test('the attention count opens a list of exactly the work it counted', async () => {
  // A failure the system is already retrying: counted by neither side.
  await seedTask({ taskId: 'recovering-run', issueNumber: 301, createdAt: minutesAgo(120), states: [{ state: 'failed', timestamp: minutesAgo(110), reason: 'Flaky' }] });
  await seedTask({ taskId: 'recovering-retry', issueNumber: 301, createdAt: minutesAgo(20), states: [{ state: 'queued', timestamp: minutesAgo(20) }] });
  // A failure nobody is fixing, and work explicitly waiting on a person.
  await seedTask({ taskId: 'stuck-run', issueNumber: 302, states: [{ state: 'failed', timestamp: minutesAgo(95), reason: 'Compile error' }] });
  await seedTask({ taskId: 'asking-run', issueNumber: 303, states: [{ state: 'action_required', timestamp: minutesAgo(70), reason: 'Credentials expired' }] });
  // A completed run whose pull request is waiting on a review decision, and
  // one whose plan issue never recorded which run produced it.
  await seedTask({ taskId: 'reviewable-run', issueNumber: 304, prNumber: 3040, states: [{ state: 'completed', timestamp: minutesAgo(60) }] });
  await seedTask({ taskId: 'unlinked-run', issueNumber: 305, prNumber: 3050, states: [{ state: 'completed', timestamp: minutesAgo(50) }] });
  await database('plan_issues').insert([
    { draft_id: 'draft-3', repository: 'integry/propr', issue_number: 304, pr_number: 3040, status: 'under_review', task_id: 'reviewable-run', created_at: daysAgo(1), updated_at: minutesAgo(40) },
    { draft_id: 'draft-3', repository: 'integry/propr', issue_number: 305, pr_number: 3050, status: 'under_review', task_id: null, created_at: daysAgo(1), updated_at: minutesAgo(35) },
  ]);

  const dashboard = routes();
  const summary = await call(dashboard.getSummary, { repository: 'all' });
  const attention = await call(dashboard.getAttention, { repository: 'all' });
  const counted = (attention.body.items as Array<{ taskId: string | null }>).map(item => item.taskId);
  assert.deepEqual(counted.slice().sort(), ['asking-run', 'reviewable-run', 'stuck-run', 'unlinked-run']);

  // The list the count links to is that same projection, not a state match:
  // the recovering failure is absent from both, and both review decisions are
  // present in both — including the one that had to be resolved to its run.
  const page = await taskPage('attention', 'all', 20);
  assert.deepEqual(page.ids.slice().sort(), counted.slice().sort());
  assert.equal(page.total, summary.body.needsAttention);
  assert.equal(await taskPageTotal('attention', 'integry/propr'), summary.body.needsAttention);
});

test('the recent-completion row limit never hides running work or shrinks a count', async () => {
  // One running task, older than a flood of completions that would fill the
  // row budget several times over.
  await seedTask({ taskId: 'long-runner', issueNumber: 501, createdAt: minutesAgo(600), states: [{ state: 'claude_execution', timestamp: minutesAgo(600) }] });

  const completions = MAX_WORK_ROWS + 1;
  const tasks = [];
  const history = [];
  for (let index = 0; index < completions; index += 1) {
    const taskId = `flood-${index}`;
    const timestamp = minutesAgo(120 - (index % 100));
    tasks.push({
      task_id: taskId, repository: 'integry/propr', issue_number: 10_000 + index, pr_number: null,
      task_type: 'issue', model_name: 'claude-opus-5', created_at: timestamp,
      initial_job_data: JSON.stringify({ title: taskId }), final_result: null,
    });
    history.push({ task_id: taskId, state: 'completed', timestamp, reason: null, metadata: '{}' });
  }
  await database.batchInsert('tasks', tasks, 500);
  await database.batchInsert('task_history', history, 500);

  const dashboard = routes();
  const summary = await call(dashboard.getSummary, { repository: 'all' });
  assert.equal(summary.body.running, 1);
  // The count of finished work is aggregated, not the length of a capped list.
  assert.equal(summary.body.completedRecently, completions);

  const active = await call(dashboard.getActive, { repository: 'all' });
  assert.deepEqual((active.body.running as Array<{ taskId: string }>).map(item => item.taskId), ['long-runner']);
  assert.deepEqual(active.body.counts, { running: 1, queued: 0 });
});

test('every dashboard endpoint rejects a malformed repository filter with HTTP 400', async () => {
  const dashboard = routes();
  const stats = createStatsRoutes({ db: database, now: () => NOW });
  const handlers = [dashboard.getSummary, dashboard.getAttention, dashboard.getActive, dashboard.getOutcomes, stats.getDashboardStats];
  for (const handler of handlers) {
    const rejected = await call(handler, { repository: 'not a repository' });
    assert.equal(rejected.status, 400);
    assert.ok(typeof rejected.body.error === 'string');

    const accepted = await call(handler, { repository: 'integry/propr' });
    assert.equal(accepted.status, 200);
  }
});
