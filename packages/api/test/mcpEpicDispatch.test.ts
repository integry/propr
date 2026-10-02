import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import type { McpTool, ToolDeps } from '../mcp/tools.js';
import type { McpPrincipal, McpPolicy } from '../mcp/policy.js';
import type { createPlannerRoutes } from '../routes/plannerRoutes.js';

const root = await mkdtemp(path.join(tmpdir(), 'propr-epic-mcp-'));
process.env.DATA_DIR = root;
process.env.DB_FILENAME = path.join(root, 'test.sqlite');
const labelCalls: Array<{ number: number; labels: string[] }> = [];
const issueLabels = new Map<number, string[]>();
const auth = await import('../../core/src/auth/githubAuth.js');
await mock.module('../../core/src/auth/githubAuth.js', { namedExports: { ...auth,
  getAuthenticatedOctokit: async () => ({ request: async (route: string, input: Record<string, unknown>) => {
    const number = Number(input.issue_number);
    if (route.startsWith('GET') && route.includes('/issues/')) return { data: { labels: issueLabels.get(number) ?? ['llm-old', 'base-old', 'auto-merge'] } };
    if (route.startsWith('POST') && route.includes('/labels')) {
      const labels = input.labels as string[];
      labelCalls.push({ number, labels });
      issueLabels.set(number, [...new Set([...(issueLabels.get(number) ?? []), ...labels])]);
      return { data: [] };
    }
    if (route.startsWith('DELETE')) {
      issueLabels.set(number, (issueLabels.get(number) ?? []).filter(label => label !== input.name));
      return { data: {} };
    }
    if (route.startsWith('GET') && route.includes('/pulls')) return { data: [] };
    throw new Error(`Unexpected route: ${route}`);
  } }),
} });
const eventPublisher = await import('../../core/src/utils/eventPublisher.js');
await mock.module('../../core/src/utils/eventPublisher.js', { namedExports: { ...eventPublisher,
  getEventPublisher: () => ({ publishActivity: async () => true }),
} });
const core = await import('@propr/core');
await mock.module('@propr/core', { namedExports: { ...core,
  loadAgents: async () => [{ enabled: true, alias: 'test', supportedModels: ['model'] }],
  loadSyntheticAgents: async () => [],
} });
const issueHelpers = await import('../routes/planIssueHelpers.js');
await mock.module('../routes/planIssueHelpers.js', { namedExports: { ...issueHelpers, getLlmLabel: async (model: string | null) => model ? `llm-${model}` : 'llm-old' } });
const { createUpdateIssueHandler } = await import('../routes/planIssueHandlers.js');
const realUpdateIssue = createUpdateIssueHandler({ verifyOwnership: async () => ({ authorized: true,
  draft: await core.db('task_drafts').where({ draft_id: planId }).first() }) });
const { addPlanningTools, planEpicDispatch } = await import('../mcp/toolsPlanning.js');
const { createToolCatalog } = await import('../mcp/tools.js');
const { McpOperations } = await import('../mcp/operations.js');
const { McpError } = await import('../mcp/config.js');
const database = core.db;
await database.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
after(async () => { await core.closeConnection(); await rm(root, { recursive: true, force: true }); });

const repository = 'acme/repo';
const planId = '10000000-0000-4000-8000-000000000001';
const models = [{ agent_alias: 'test', model_name: 'model' }];
const dispatches: number[] = [];
const updates: Array<{ number: number; body: unknown }> = [];
const githubCalls: string[] = [];
let dispatchFailure = false;
let configFailure = false;
const principal = { user: { id: 'user' }, grant: { id: 'grant' }, github: {
  request: async (route: string, input: Record<string, unknown>) => {
    githubCalls.push(route);
    if (route.startsWith('DELETE')) issueLabels.set(Number(input.issue_number), (issueLabels.get(Number(input.issue_number)) ?? []).filter(label => label !== input.name));
    return { data: {} };
  },
} } as unknown as McpPrincipal;
const deps = { db: database, policy: { repository: async () => {}, requireScope: () => {},
  oauth: { store: { seal: (value: unknown) => JSON.stringify(value) } },
} as unknown as McpPolicy, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never } satisfies ToolDeps;
const planner = {
  implementIssue: async (req: Request, res: Response) => {
    const number = Number(req.params.issueNumber);
    dispatches.push(number);
    if (dispatchFailure) throw new Error('dispatch failed');
    await database('plan_issues').where({ draft_id: planId, issue_number: number }).update({ status: 'processing', ...models[0] });
    res.json({ issueNumber: number });
  },
  updateIssue: async (req: Request, res: Response) => {
    if (configFailure) throw new Error('selector sync failed');
    updates.push({ number: Number(req.params.issueNumber), body: req.body });
    await realUpdateIssue(req as unknown as Parameters<typeof realUpdateIssue>[0], res);
  },
} as unknown as ReturnType<typeof createPlannerRoutes>;
const tools: McpTool[] = [];
addPlanningTools(tools, deps, planner);
const implement = tools.find(tool => tool.name === 'implement_plan')!;
const getPlan = tools.find(tool => tool.name === 'get_plan')!;
const getOperation = createToolCatalog(deps).find(tool => tool.name === 'get_operation')!;
const args = (extra: Record<string, unknown> = {}) => implement.schema.parse({ repository, planId,
  idempotencyKey: 'epic-request-1', issues: [40, 10, 30], models, useEpic: true, ...extra });
const run = (extra: Record<string, unknown> = {}) => implement.run({ principal, args: args(extra), operationId: 'operation' } as never);

beforeEach(async () => {
  await database('task_drafts').delete();
  await database('mcp_records').delete();
  await database('mcp_operations').delete();
  await database('task_drafts').insert({ draft_id: planId, user_id: 'user', repository, status: 'executed', context_config: JSON.stringify({ epicLabel: 'base-epic' }) });
  await database('plan_issues').insert([10, 20, 30, 40].map(issue_number => ({ draft_id: planId, repository, issue_number, status: 'pending' })));
  dispatches.length = 0; updates.length = 0; githubCalls.length = 0; labelCalls.length = 0; issueLabels.clear();
  for (const number of [10, 20, 30, 40]) issueLabels.set(number, ['llm-old', 'base-old', 'auto-merge']);
  dispatchFailure = false; configFailure = false;
});

test('pure policy orders only selected epic issues, and preserves parallel/non-epic dispatch order', () => {
  const input = { issues: [40, 10, 30], planOrder: [10, 20, 30, 40], useEpic: true, modelCount: 1 };
  assert.deepEqual(planEpicDispatch(input), { mode: 'sequential', advanceOn: 'merged', dispatchNow: [10], queued: [30, 40] });
  assert.deepEqual(planEpicDispatch({ ...input, epicExecution: 'parallel', modelCount: 4 }).dispatchNow, [40, 10, 30]);
  assert.equal(planEpicDispatch({ ...input, useEpic: false, epicExecution: 'sequential', modelCount: 4 }).mode, 'parallel');
  assert.equal(planEpicDispatch({ ...input, epicAdvanceOn: 'terminal' }).advanceOn, 'terminal');
  assert.throws(() => planEpicDispatch({ ...input, modelCount: 2 }), error => error instanceof McpError && error.code === 'INVALID_INPUT');
});

test('sequential MCP dispatches exactly one head and configures/claims every selected successor', async () => {
  const result = await run();
  assert.deepEqual(dispatches, [10]);
  assert.deepEqual(updates, [30, 40].map(number => ({ number, body: { ...models[0], syncEpicLabels: true } })));
  assert.equal(result.status, 202);
  const data = result.data as Record<string, unknown>;
  assert.equal(data.executionMode, 'sequential');
  assert.equal(data.advanceOn, 'merged');
  assert.deepEqual(data.started, [10]);
  assert.deepEqual(data.queued, [30, 40]);
  const queue = await core.getEpicExecutionQueue(planId);
  assert.deepEqual(queue?.issues, [10, 30, 40]);
  assert.equal(queue?.ready, true);
  for (const number of [30, 40]) {
    assert.deepEqual(issueLabels.get(number)?.sort(), ['base-epic', 'llm-model']);
    const configured = await database('plan_issues').where({ draft_id: planId, issue_number: number }).first();
    assert.equal(configured.agent_alias, 'test');
    assert.equal(configured.model_name, 'model');
    assert.equal(configured.status, 'pending');
  }
  assert.equal(labelCalls.some(call => call.labels.includes('AI')), false);
  assert.equal((await database('mcp_records').where({ kind: 'issue_execution' })).length, 3);
  const unselected = await database('plan_issues').where({ draft_id: planId, issue_number: 20 }).first();
  assert.equal(unselected.status, 'pending');
  await assert.rejects(run({ issues: [30], idempotencyKey: 'epic-request-2' }), error => error instanceof McpError && error.code === 'IMPLEMENTATION_ALREADY_REQUESTED');
  assert.deepEqual(dispatches, [10]);
  const plan = await getPlan.run({ principal, args: { repository, planId } } as never);
  assert.equal((plan.data as { epicQueue: { head: number } }).epicQueue.head, 10);
});

test('parallel and non-epic modes preserve fan-out and multi-model support', async () => {
  await run({ epicExecution: 'parallel', models: [...models, ...models] });
  assert.deepEqual(dispatches, [40, 10, 30]);
  assert.deepEqual(updates, []);
  assert.equal(await core.getEpicExecutionQueue(planId), null);
});

test('non-epic calls ignore sequential execution preference', async () => {
  const result = await run({ useEpic: false, epicExecution: 'sequential', models: [...models, ...models] });
  assert.deepEqual(dispatches, [40, 10, 30]);
  assert.equal((result.data as { executionMode: string }).executionMode, 'parallel');
});

test('multiple models fail before any claim, queue or GitHub call', async () => {
  await assert.rejects(run({ models: [...models, ...models] }), error => error instanceof McpError && error.code === 'INVALID_INPUT');
  assert.deepEqual(dispatches, []);
  assert.deepEqual(githubCalls, []);
  assert.equal(await core.getEpicExecutionQueue(planId), null);
  assert.equal((await database('mcp_records')).length, 0);
});

test('head dispatch failure cancels the queue; selector failure holds progression', async () => {
  dispatchFailure = true;
  await assert.rejects(run(), /dispatch failed/);
  assert.equal((await core.getEpicExecutionQueue(planId))?.status, 'cancelled');
  assert.deepEqual(updates, []);
});

test('selector failure keeps the durable queue unready for recovery', async () => {
  configFailure = true;
  await assert.rejects(run(), /selector sync failed/);
  const queue = await core.getEpicExecutionQueue(planId);
  assert.equal(queue?.status, 'active');
  assert.equal(queue?.ready, false);
  assert.match(queue?.blockedReason ?? '', /Preparing/);
});

test('new optional schema fields preserve the pre-upgrade parsed payload and receipt hash', async () => {
  const parsed = args();
  assert.equal(Object.hasOwn(parsed, 'epicExecution'), false);
  assert.equal(Object.hasOwn(parsed, 'epicAdvanceOn'), false);
  const operations = new McpOperations(database);
  const previous = { repository, planId, idempotencyKey: 'epic-request-1', issues: [40, 10, 30], models,
    useEpic: true, autoMerge: false, runUltrafix: false, ultrafixGoal: 9, ultrafixMaxCycles: 3 };
  assert.deepEqual(parsed, previous);
  const before = await operations.run(principal, { tool: 'implement_plan', args: previous, repository }, async () => ({ status: 202, data: { planId, issues: previous.issues } }));
  const replay = await operations.replay(principal, 'implement_plan', parsed);
  assert.equal(replay?.operationId, before.operationId);
});

test('sequential receipt exposes queue and remains accepted through under_review until completed', async () => {
  const operations = new McpOperations(database);
  const parsed = args();
  const accepted = await operations.run(principal, { tool: 'implement_plan', args: parsed, repository }, operationId =>
    implement.run({ principal, args: parsed, operationId } as never));
  await database('plan_issues').where({ draft_id: planId }).whereIn('issue_number', [10, 30, 40]).update({ status: 'under_review' });
  const receipt = await getOperation.run({ principal, args: { operationId: accepted.operationId } } as never);
  const data = receipt.data as { state: string; targetState: { epicQueue: { status: string } } };
  assert.equal(data.state, 'accepted');
  assert.equal(data.targetState.epicQueue.status, 'active');
  await database('plan_issues').where({ draft_id: planId }).whereIn('issue_number', [10, 30, 40]).update({ status: 'merged' });
  await core.startEpicQueueHead(planId, { finalize: async () => {} });
  const completed = await getOperation.run({ principal, args: { operationId: accepted.operationId } } as never);
  assert.equal((completed.data as { state: string }).state, 'completed');
  assert.equal((completed.data as { targetState: { epicQueue: { status: string } } }).targetState.epicQueue.status, 'completed');
});

test('status-write hooks and concurrent webhook observers dispatch the selected successor only once', async () => {
  await run();
  await Promise.all([core.updatePlanIssueStatus(repository, 10, core.PlanIssueStatus.MERGED),
    core.updatePlanIssue(planId, 10, { status: core.PlanIssueStatus.MERGED })]);
  await core.triggerNextPendingIssue(planId, repository, 'base-epic', core.logger.withCorrelation('queue-test'));
  assert.deepEqual(labelCalls.filter(call => call.labels.includes('AI')).map(call => call.number), [30]);
  assert.equal((await core.getEpicExecutionQueue(planId))?.cursor, 1);
  assert.equal(issueLabels.get(30)?.includes('auto-merge'), false);
});

test('PR status hook and resume route release a head held by pause', async () => {
  await run();
  assert.equal((await core.pauseDraft(planId)).success, true);
  await database('plan_issues').where({ draft_id: planId, issue_number: 10 }).update({ pr_number: 100 });
  await core.updatePlanIssueByPR(repository, 100, { status: core.PlanIssueStatus.MERGED });
  assert.equal((await core.getEpicExecutionQueue(planId))?.cursor, 1);
  assert.equal(labelCalls.some(call => call.labels.includes('AI')), false);
  assert.equal((await core.resumeDraft(planId)).success, true);
  assert.deepEqual(labelCalls.filter(call => call.labels.includes('AI')).map(call => call.number), [30]);
});

test('drafts without a queue retain the legacy processing, auto-merge and epic labels', async () => {
  await database('plan_issues').where({ draft_id: planId, issue_number: 10 }).update({ status: 'merged' });
  await core.triggerNextPendingIssue(planId, repository, 'base-epic', core.logger.withCorrelation('legacy-test'));
  assert.deepEqual(labelCalls, [{ number: 20, labels: ['AI', 'auto-merge', 'base-epic'] }]);
});
