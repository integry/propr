import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { up } from '../src/db/migrations/20261003000000_add_epic_execution_queues.js';
import { up as finalization } from '../src/db/migrations/20261003010000_add_epic_queue_finalization.js';
import { up as useEpic } from '../src/db/migrations/20261003020000_add_epic_queue_use_epic.js';
import { up as parallel } from '../src/db/migrations/20261003030000_add_epic_queue_parallel.js';
import { up as recovery } from '../src/db/migrations/20261003040000_add_epic_queue_recovery_intent.js';
import { safeUpdateLabels } from '../src/utils/github/labelOperations.js';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const log = { info() {}, warn() {}, error() {}, debug() {}, withCorrelation: () => log };
let configured = ['AI'];
let labels = new Set<string>();
let failAdd = false;
let failRemove = false;
let removalBarrier: Promise<void> | undefined;
const events: string[] = [];
const octokit = { async request(route: string, body: Record<string, unknown>) {
  if (route.startsWith('GET ')) return { data: { labels: [...labels].map(name => ({ name })) } };
  if (route.startsWith('POST ')) {
    const added = body.labels as string[];
    events.push(`add:${body.issue_number}:${added.join(',')}`);
    if (failAdd) throw new Error('GitHub unavailable');
    added.forEach(label => labels.add(label));
  } else if (route.startsWith('DELETE ')) {
    events.push(`remove:${body.issue_number}:${body.name}`);
    await removalBarrier;
    if (failRemove) throw new Error('GitHub unavailable');
    if (!labels.delete(body.name as string)) throw Object.assign(new Error('Label absent'), { status: 404 });
  } else throw new Error(`Unexpected route: ${route}`);
  return { data: {} };
} };
await mock.module('../src/db/connection.js', { namedExports: { db: database } });
await mock.module('../src/utils/logger.js', { defaultExport: log });
await mock.module('../src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => octokit } });
await mock.module('../src/daemon/configLoader.js', { namedExports: { getPrimaryProcessingLabels: () => configured } });
await mock.module('../src/config/planIssueManager.js', { namedExports: {
  PlanIssueStatus: { PENDING: 'pending', PROCESSING: 'processing', UNDER_REVIEW: 'under_review',
    IN_REFINEMENT: 'in_refinement', REFINEMENT_PROCESSING: 'refinement_processing', MERGED: 'merged', CLOSED: 'closed' },
} });
await mock.module('../src/webhook/planIssueTrigger.js', { namedExports: {
  labelPlanIssueForProcessing: async ({ issueNumber }: { issueNumber: number }) => { events.push(`start:${issueNumber}`); },
  reconcileTerminalInProgressIssues: async (_repository: string, issues: unknown[]) => issues,
  finalizeEpicPlanIfComplete: async () => { events.push('finalize'); return true; },
} });
await mock.module('@propr/core', { namedExports: { safeUpdateLabels } });
const { completeIssueLabels, completeIssueLabelsBestEffort } = await import('../../../src/jobs/issueJobCompletionLabels.js');
const { createEpicExecutionQueue, getEpicExecutionQueue, startEpicQueueHead, reconcileEpicExecutionQueues } =
  await import('../src/services/taskPlanning/epicExecutionQueue.js');

await database.schema.createTable('task_drafts', table => {
  table.string('draft_id').primary(); table.boolean('paused').defaultTo(false); table.text('context_config');
});
await database.schema.createTable('plan_issues', table => {
  table.increments('id'); table.string('draft_id'); table.integer('issue_number'); table.string('status');
});
await database.schema.createTable('tasks', table => {
  table.string('task_id').primary(); table.string('repository'); table.integer('issue_number'); table.string('task_type');
});
await database.schema.createTable('task_history', table => {
  table.increments('history_id'); table.string('task_id'); table.string('state');
});
for (const migrate of [up, finalization, useEpic, parallel, recovery]) await migrate(database);
/** Records the issue's worker task in `state`, as the worker state manager would. */
async function workerTask(state: string, taskId = 'task-10') {
  await database('tasks').insert({ task_id: taskId, repository: 'acme/repo', issue_number: 10, task_type: 'issue' }).onConflict('task_id').ignore();
  await database('task_history').insert({ task_id: taskId, state });
}
after(async () => database.destroy());
beforeEach(async () => {
  await database('epic_execution_queues').delete();
  await database('task_drafts').delete();
  await database('plan_issues').delete();
  await database('task_history').delete();
  await database('tasks').delete();
  await database('task_drafts').insert({ draft_id: 'draft' });
  await database('plan_issues').insert([
    { draft_id: 'draft', issue_number: 10, status: 'merged' },
    { draft_id: 'draft', issue_number: 20, status: 'pending' },
  ]);
  configured = ['AI']; labels = new Set(['AI', 'AI-processing', 'base-epic', 'bug']);
  failAdd = false; failRemove = false; removalBarrier = undefined; events.length = 0;
  await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [10, 20] });
});
async function complete(primaryLabel = 'AI', triggeringLabel: string | null = primaryLabel) {
  await completeIssueLabels({ octokit: octokit as never,
    issueRef: { repoOwner: 'acme', repoName: 'repo', number: 10, triggeringLabel: triggeringLabel ?? undefined },
    AI_PROCESSING_TAG: `${primaryLabel}-processing`, AI_DONE_TAG: `${primaryLabel}-done`, correlatedLogger: log as never });
}

test('completion publishes done before releasing AI, then the queue starts its successor', async () => {
  await complete();
  await startEpicQueueHead('draft');
  assert.deepEqual(events, ['add:10:AI-done', 'remove:10:AI', 'remove:10:AI-processing', 'start:20']);
  assert.deepEqual([...labels].sort(), ['AI-done', 'base-epic', 'bug']);
});

test('custom PRIMARY_PROCESSING_LABELS and old jobs without triggeringLabel use the configured prefix', async () => {
  configured = ['Robot', 'Assistant'];
  labels = new Set(['Assistant', 'Assistant-processing', 'bug']);
  await complete('Assistant', null);
  await startEpicQueueHead('draft');
  assert.deepEqual(events, ['add:10:Assistant-done', 'remove:10:Assistant', 'remove:10:Assistant-processing', 'start:20']);
  assert.deepEqual([...labels].sort(), ['Assistant-done', 'bug']);
});

test('a merge before worker completion holds the cursor until done and cleanup succeed', async () => {
  await workerTask('processing');
  await assert.rejects(startEpicQueueHead('draft'), /Waiting for 'AI-done'/);
  assert.equal((await getEpicExecutionQueue('draft'))?.cursor, 0);
  assert.match((await getEpicExecutionQueue('draft'))?.blockedReason ?? '', /Waiting for 'AI-done'/);
  assert.deepEqual(events, []);
  labels.add('AI-done');
  await reconcileEpicExecutionQueues();
  assert.deepEqual(events, ['remove:10:AI', 'remove:10:AI-processing', 'start:20']);
  assert.equal((await getEpicExecutionQueue('draft'))?.blockedReason, null);
});

test('a merged head whose run will never publish done releases its bare trigger', async () => {
  // A stopped task loses only AI-processing; a human then fixes and merges the PR.
  labels = new Set(['AI', 'base-epic']);
  await startEpicQueueHead('draft');
  assert.deepEqual(events, ['remove:10:AI', 'start:20']);
  assert.equal((await getEpicExecutionQueue('draft'))?.cursor, 1);
  assert.deepEqual([...labels], ['base-epic']);
});

test('failed completion publication keeps the trigger and prevents handoff', async () => {
  await workerTask('processing');
  failAdd = true;
  await assert.rejects(complete(), /Failed to add 'AI-done'/);
  await assert.rejects(startEpicQueueHead('draft'), /Waiting for 'AI-done'/);
  assert.deepEqual(events, ['add:10:AI-done']);
  assert.ok(labels.has('AI'));
  assert.equal((await getEpicExecutionQueue('draft'))?.cursor, 0);
});

test('failed removal blocks advancement and recovery retries cleanup before starting the next issue', async () => {
  labels.add('AI-done'); failRemove = true;
  await assert.rejects(startEpicQueueHead('draft'), /Failed to remove 'AI'/);
  assert.equal((await getEpicExecutionQueue('draft'))?.cursor, 0);
  assert.match((await getEpicExecutionQueue('draft'))?.blockedReason ?? '', /Could not release issue #10/);
  assert.ok(!events.includes('start:20'));
  failRemove = false; events.length = 0;
  await reconcileEpicExecutionQueues();
  assert.deepEqual(events, ['remove:10:AI', 'remove:10:AI-processing', 'start:20']);
  assert.equal((await getEpicExecutionQueue('draft'))?.cursor, 1);
  assert.equal((await getEpicExecutionQueue('draft'))?.blockedReason, null, 'the stale release failure is cleared');
});

test('concurrent observers cannot start the successor while removal is still pending', async () => {
  labels.add('AI-done');
  let release!: () => void;
  removalBarrier = new Promise(resolve => { release = resolve; });
  let observed!: () => void;
  const deleting = new Promise<void>(resolve => { observed = resolve; });
  const original = octokit.request;
  const request = mock.method(octokit, 'request', async (route: string, body: Record<string, unknown>) => {
    if (route.startsWith('DELETE ')) observed();
    return original(route, body);
  });
  try {
    const first = startEpicQueueHead('draft');
    await deleting;
    assert.equal((await getEpicExecutionQueue('draft'))?.cursor, 0);
    assert.ok(!events.includes('start:20'));
    const second = startEpicQueueHead('draft');
    release();
    await Promise.all([first, second]);
    assert.equal(events.filter(event => event === 'start:20').length, 1);
    assert.ok(!labels.has('AI'));
    assert.ok(!labels.has('AI-processing'));
  } finally { release(); request.mock.restore(); }
});

test('terminal-policy failed issues release triggers without claiming successful completion', async () => {
  await database('epic_execution_queues').where({ draft_id: 'draft' }).update({ advance_on: 'terminal' });
  await database('plan_issues').where({ issue_number: 10 }).update({ status: 'closed' });
  await startEpicQueueHead('draft');
  assert.deepEqual(events, ['remove:10:AI', 'remove:10:AI-processing', 'start:20']);
  assert.ok(!labels.has('AI-done'));
});

test('the final child releases all configured triggers before epic finalization', async () => {
  configured = ['AI', 'Assistant'];
  labels = new Set(['AI', 'AI-done', 'Assistant', 'Assistant-done']);
  await database('epic_execution_queues').where({ draft_id: 'draft' }).update({ issues: '[10]' });
  await startEpicQueueHead('draft');
  assert.deepEqual(events, ['remove:10:AI', 'remove:10:Assistant', 'finalize']);
});

test('another trigger without its own done marker is separate work and is left alone', async () => {
  configured = ['AI', 'Assistant'];
  for (const [policy, status] of [['merged', 'merged'], ['terminal', 'closed']] as const) {
    events.length = 0;
    await database('epic_execution_queues').delete();
    await createEpicExecutionQueue({ draftId: 'draft', repository: 'acme/repo', issues: [10, 20] });
    await database('epic_execution_queues').where({ draft_id: 'draft' }).update({ advance_on: policy });
    await database('plan_issues').where({ issue_number: 10 }).update({ status });
    labels = new Set(['AI', 'AI-done', 'Assistant', 'Assistant-processing']);
    await startEpicQueueHead('draft');
    assert.deepEqual(events, ['remove:10:AI', 'start:20'], policy);
    assert.deepEqual([...labels].sort(), ['AI-done', 'Assistant', 'Assistant-processing'], policy);
    assert.equal((await getEpicExecutionQueue('draft'))?.cursor, 1, policy);
  }
});

test('mixed completion states release only the triggers whose work is finished', async () => {
  configured = ['AI', 'Assistant', 'Robot'];
  // The queue's own trigger finished; Assistant finished too; Robot never ran.
  labels = new Set(['AI', 'AI-done', 'Assistant', 'Assistant-done', 'Robot']);
  await startEpicQueueHead('draft');
  assert.deepEqual(events, ['remove:10:AI', 'remove:10:Assistant', 'start:20']);
  assert.deepEqual([...labels].sort(), ['AI-done', 'Assistant-done', 'Robot']);
});

test('a merged head still waits for the queue trigger while another trigger is done', async () => {
  await workerTask('processing');
  configured = ['AI', 'Assistant'];
  labels = new Set(['AI', 'AI-processing', 'Assistant', 'Assistant-done']);
  await assert.rejects(startEpicQueueHead('draft'), /Waiting for 'AI-done'/);
  assert.deepEqual(events, []);
  assert.equal((await getEpicExecutionQueue('draft'))?.cursor, 0);
});

test('a finished worker whose done publication and processing cleanup both failed does not block handoff', async () => {
  await workerTask('processing');
  failAdd = true; failRemove = true;
  const result = await completeIssueLabelsBestEffort({ octokit: octokit as never,
    issueRef: { repoOwner: 'acme', repoName: 'repo', number: 10, triggeringLabel: 'AI' },
    AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', correlatedLogger: log as never });
  assert.equal(result.published, false);
  assert.deepEqual([...labels].sort(), ['AI', 'AI-processing', 'base-epic', 'bug'], 'both label mutations failed');

  // GitHub recovers and the PR merges while the worker is still finishing post-processing.
  failAdd = false; failRemove = false; events.length = 0;
  await assert.rejects(startEpicQueueHead('draft'), /Waiting for 'AI-done'/);
  assert.equal((await getEpicExecutionQueue('draft'))?.cursor, 0);

  // Once the worker's task is terminal, reconciliation releases the leftover labels and advances.
  await workerTask('completed');
  await reconcileEpicExecutionQueues();
  assert.deepEqual(events, ['remove:10:AI', 'remove:10:AI-processing', 'start:20']);
  assert.deepEqual([...labels].sort(), ['base-epic', 'bug']);
  assert.equal((await getEpicExecutionQueue('draft'))?.cursor, 1);
  assert.equal((await getEpicExecutionQueue('draft'))?.blockedReason, null);
});
