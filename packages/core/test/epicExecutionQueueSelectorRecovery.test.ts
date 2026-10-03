import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { up } from '../src/db/migrations/20261003000000_add_epic_execution_queues.js';
import { up as epicQueueFinalization } from '../src/db/migrations/20261003010000_add_epic_queue_finalization.js';
import { up as epicQueueUseEpic } from '../src/db/migrations/20261003020000_add_epic_queue_use_epic.js';
import { up as epicQueueParallel } from '../src/db/migrations/20261003030000_add_epic_queue_parallel.js';
import { up as epicQueueRecovery } from '../src/db/migrations/20261003040000_add_epic_queue_recovery_intent.js';

/**
 * Dispatch can create the epic PR and label its children while saving `context_config.epicLabel` fails.
 * The real finalizer runs here: a missing saved selector must be recovered or keep finalization owed.
 */
const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const issueLabels = new Map<number, string[]>();
const pullLookups: string[] = [];
const labelled: Array<{ issue: number; labels: string[] }> = [];
const selectorSyncs: Array<{ issue: number; add: string[] }> = [];
let beforeIssueRead: (() => Promise<void>) | null = null;
const log = { info() {}, warn() {}, error() {}, debug() {}, withCorrelation: () => log };
await mock.module('../src/db/connection.js', { namedExports: { db: database } });
await mock.module('../src/utils/logger.js', { defaultExport: log });
await mock.module('../src/config/planIssueManager.js', { namedExports: {
  PlanIssueStatus: { PENDING: 'pending', PROCESSING: 'processing', UNDER_REVIEW: 'under_review',
    IN_REFINEMENT: 'in_refinement', REFINEMENT_PROCESSING: 'refinement_processing', MERGED: 'merged', CLOSED: 'closed' },
  getPlanIssuesByDraft: async (draftId: string) => database('plan_issues').where({ draft_id: draftId }),
  updatePlanIssueStatus: async () => {},
  updatePlanIssue: async (draftId: string, issueNumber: number, updates: Record<string, unknown>) => {
    await database('plan_issues').where({ draft_id: draftId, issue_number: issueNumber }).update(updates);
  },
} });
await mock.module('../src/daemon/configLoader.js', { namedExports: { getPrimaryProcessingLabels: () => ['AI'] } });
await mock.module('../src/agents/AgentRegistry.js', { namedExports: { AgentRegistry: { getInstance: () => ({
  ensureInitialized: async () => {}, getAgentByAlias: () => undefined, getAllAgents: () => [],
}) } } });
await mock.module('../src/config/modelDefinitions.js', { namedExports: { MODEL_INFO_MAP: { model: { githubLabel: 'llm-model' } } } });
await mock.module('../src/agents/impl/openCodeUtils.js', { namedExports: { toProprOpenCodeModelId: (model: string) => model } });
await mock.module('../src/config/planIssueDefaults.js', { namedExports: {
  resolvePlanIssueDefaultSelection: async () => ({ agent_alias: 'agent', model_name: 'model' }),
} });
await mock.module('../src/utils/github/labelOperations.js', { namedExports: {
  safeUpdateLabels: async ({ issueNumber }: { issueNumber: number }, _remove: string[], add: string[]) => {
    selectorSyncs.push({ issue: issueNumber, add });
    return { success: true, errors: [] };
  },
} });
await mock.module('../src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => ({
  request: async (route: string, params: { issue_number: number; head?: string; labels?: string[] }) => {
    if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}') {
      await beforeIssueRead?.();
      return { data: { labels: (issueLabels.get(params.issue_number) ?? []).map(name => ({ name })) } };
    }
    if (route === 'GET /repos/{owner}/{repo}/pulls') {
      pullLookups.push(params.head!);
      return { data: [{ number: 99, labels: [] }] };
    }
    if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels') {
      labelled.push({ issue: params.issue_number, labels: params.labels! });
      issueLabels.set(params.issue_number, [...(issueLabels.get(params.issue_number) ?? []), ...params.labels!]);
    }
    return { data: {} };
  },
}) } });
const { PlanIssueStatus: S } = await import('../src/config/planIssueManager.js');
const { createEpicExecutionQueue, getEpicExecutionQueue, reconcileEpicExecutionQueues,
  onPlanIssueStatusChanged } = await import('../src/services/taskPlanning/epicExecutionQueue.js');

await database.schema.createTable('task_drafts', table => {
  table.string('draft_id').primary(); table.string('repository'); table.boolean('paused').defaultTo(false);
  table.text('context_config'); table.timestamp('updated_at');
});
await database.schema.createTable('plan_issues', table => {
  table.increments('id'); table.string('draft_id'); table.integer('issue_number'); table.integer('pr_number');
  table.string('status'); table.string('task_id'); table.string('agent_alias'); table.string('model_name');
});
await up(database);
await epicQueueFinalization(database);
await epicQueueUseEpic(database);
await epicQueueParallel(database);
await epicQueueRecovery(database);
after(async () => database.destroy());
beforeEach(async () => {
  await database.raw('DROP TRIGGER IF EXISTS reject_context_write');
  await database('epic_execution_queues').delete();
  await database('task_drafts').delete();
  await database('plan_issues').delete();
  // The epic exists on GitHub, but saving its selector failed during dispatch.
  await database('task_drafts').insert({ draft_id: 'draft', repository: 'acme/repo', context_config: JSON.stringify({ baseBranch: 'main' }) });
  await database('plan_issues').insert([10, 30].map(issue_number => ({ draft_id: 'draft', issue_number, status: 'pending' })));
  issueLabels.clear(); pullLookups.length = 0; labelled.length = 0; selectorSyncs.length = 0; beforeIssueRead = null;
});
const selection = { agent_alias: 'agent', model_name: 'model' };
const sequential = { draftId: 'draft', repository: 'acme/repo', issues: [10, 30], headSelection: selection, ready: false };
const parallel = { draftId: 'draft', repository: 'acme/repo', issues: [10, 30], parallel: true };
const epicPrLabels = () => labelled.filter(entry => entry.issue === 99);
async function savedContext() {
  return JSON.parse((await database('task_drafts').where({ draft_id: 'draft' }).first('context_config')).context_config);
}
async function finish(issueNumber: number) {
  await database('plan_issues').where({ draft_id: 'draft', issue_number: issueNumber }).update({ status: 'merged' });
  await onPlanIssueStatusChanged('draft', issueNumber, S.MERGED);
}
async function rejectContextWrites() {
  await database.raw(`CREATE TRIGGER reject_context_write BEFORE UPDATE OF context_config ON task_drafts
    BEGIN SELECT RAISE(ABORT, 'context write failed'); END`);
}

test('setup recovery saves the recovered epic selector so the completed queue labels its epic PR', async () => {
  await createEpicExecutionQueue(sequential, { now: () => 100 });
  await database('plan_issues').where({ issue_number: 10 }).update({ status: 'processing' });
  issueLabels.set(10, ['AI', 'base-epic', 'llm-model']);
  await reconcileEpicExecutionQueues({ now: () => 16 * 60_000 });
  assert.equal((await getEpicExecutionQueue('draft'))?.ready, true);
  assert.deepEqual(await savedContext(), { baseBranch: 'main', epicLabel: 'base-epic' });
  assert.deepEqual(selectorSyncs, [{ issue: 30, add: ['base-epic', 'llm-model'] }]);
  await finish(10);
  assert.deepEqual(labelled, [{ issue: 30, labels: ['AI', 'base-epic'] }]);
  await finish(30);
  assert.deepEqual(pullLookups, ['acme:epic']);
  assert.deepEqual(epicPrLabels(), [{ issue: 99, labels: ['AI'] }]);
  assert.ok((await getEpicExecutionQueue('draft'))?.finalizedAt);
});

test('setup recovery stays pending while the recovered epic selector cannot be saved', async () => {
  await createEpicExecutionQueue(sequential, { now: () => 100 });
  await database('plan_issues').where({ issue_number: 10 }).update({ status: 'processing' });
  issueLabels.set(10, ['AI', 'base-epic', 'llm-model']);
  await rejectContextWrites();
  assert.deepEqual(await reconcileEpicExecutionQueues({ now: () => 16 * 60_000 }), { reconciled: 0 });
  assert.equal((await getEpicExecutionQueue('draft'))?.ready, false);
  assert.equal((await getEpicExecutionQueue('draft'))?.status, 'active');
  assert.deepEqual(selectorSyncs, []);
  await database.raw('DROP TRIGGER reject_context_write');
  await reconcileEpicExecutionQueues({ now: () => 17 * 60_000 });
  assert.equal((await getEpicExecutionQueue('draft'))?.ready, true);
  assert.equal((await savedContext()).epicLabel, 'base-epic');
});

test('a parallel epic whose selector was never saved recovers it and labels the epic PR', async () => {
  await createEpicExecutionQueue(parallel);
  issueLabels.set(10, ['AI', 'base-epic']); issueLabels.set(30, ['AI', 'base-epic']);
  await finish(10);
  await finish(30);
  assert.deepEqual(pullLookups, ['acme:epic']);
  assert.deepEqual(epicPrLabels(), [{ issue: 99, labels: ['AI'] }]);
  assert.deepEqual(await savedContext(), { baseBranch: 'main', epicLabel: 'base-epic' });
  assert.ok((await getEpicExecutionQueue('draft'))?.finalizedAt);
});

test('a missing or ambiguous epic selector keeps finalization owed until one is recoverable', async () => {
  await createEpicExecutionQueue(parallel);
  await finish(10);
  await finish(30);
  assert.equal((await getEpicExecutionQueue('draft'))?.status, 'completed');
  assert.equal((await getEpicExecutionQueue('draft'))?.finalizedAt, null);
  issueLabels.set(10, ['base-epic']); issueLabels.set(30, ['base-other']);
  assert.deepEqual(await reconcileEpicExecutionQueues(), { reconciled: 1 });
  assert.equal((await getEpicExecutionQueue('draft'))?.finalizedAt, null);
  assert.deepEqual(pullLookups, []);
  assert.equal((await savedContext()).epicLabel, undefined);
  issueLabels.set(30, ['base-epic']);
  await reconcileEpicExecutionQueues();
  assert.deepEqual(epicPrLabels(), [{ issue: 99, labels: ['AI'] }]);
  assert.ok((await getEpicExecutionQueue('draft'))?.finalizedAt);
});

test('finalization stays owed while the recovered epic selector cannot be saved', async () => {
  await createEpicExecutionQueue(parallel);
  issueLabels.set(10, ['base-epic']); issueLabels.set(30, ['base-epic']);
  await rejectContextWrites();
  await finish(10);
  await finish(30);
  const queue = await getEpicExecutionQueue('draft');
  assert.equal(queue?.finalizedAt, null);
  assert.equal(queue?.finalizationStartedAt, null);
  assert.deepEqual(epicPrLabels(), []);
});

test('a replaced execution cannot save a recovered selector or label the epic PR', async () => {
  await createEpicExecutionQueue(parallel);
  issueLabels.set(10, ['base-epic']); issueLabels.set(30, ['base-epic']);
  await database('plan_issues').where({ draft_id: 'draft' }).update({ status: 'merged' });
  let replaced = false;
  beforeIssueRead = async () => {
    if (replaced) return;
    replaced = true;
    await createEpicExecutionQueue({ ...parallel, issues: [30] });
  };
  await onPlanIssueStatusChanged('draft', 30, S.MERGED);
  assert.equal(replaced, true);
  assert.equal((await savedContext()).epicLabel, undefined);
  assert.deepEqual(epicPrLabels(), []);
  const replacement = await getEpicExecutionQueue('draft');
  assert.equal(replacement?.status, 'active');
  assert.equal(replacement?.owesEpicFinalization, true);
});
