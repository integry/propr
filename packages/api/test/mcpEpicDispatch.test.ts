/* eslint-disable max-lines -- epic dispatch and receipt lifecycle regressions share one database and GitHub fixture */
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
let epicPR: { number: number; labels: string[] } | null = null;
let epicLookups = 0;
let epicLabelFailure = false;
let queuedLabelFailure = false;
let initialEpicFailure = false;
let interruptHeadPersistence = false;
let beforeAuth: (() => Promise<void>) | undefined;
let afterIssueRead: (() => Promise<void>) | undefined;
let afterIssueLoad: (() => Promise<void>) | undefined;
let afterEpicLookup: (() => Promise<void>) | undefined;
const auth = await import('../../core/src/auth/githubAuth.js');
await mock.module('../../core/src/auth/githubAuth.js', { namedExports: { ...auth,
  getAuthenticatedOctokit: async () => {
    const hook = beforeAuth; beforeAuth = undefined; await hook?.();
    return { request: async (route: string, input: Record<string, unknown>) => {
      const number = Number(input.issue_number);
      if (route.startsWith('GET') && route.includes('/issues/')) {
        const labels = issueLabels.get(number) ?? ['llm-old', 'base-old', 'auto-merge'];
        const hook = afterIssueRead; afterIssueRead = undefined; await hook?.();
        return { data: { labels } };
      }
      if (route.startsWith('POST') && route.includes('/labels')) {
        if (number === 20 && queuedLabelFailure) throw new Error('Queued selector update unavailable');
        if (number === 999 && epicLabelFailure) throw new Error('Epic labeling unavailable');
        const labels = input.labels as string[];
        labelCalls.push({ number, labels });
        issueLabels.set(number, [...new Set([...(issueLabels.get(number) ?? []), ...labels])]);
        return { data: [] };
      }
      if (route.startsWith('DELETE')) {
        issueLabels.set(number, (issueLabels.get(number) ?? []).filter(label => label !== input.name));
        return { data: {} };
      }
      if (route.startsWith('GET') && route.includes('/pulls')) {
        epicLookups++;
        const data = epicPR ? [{ ...epicPR, labels: [...(issueLabels.get(epicPR.number) ?? epicPR.labels)] }] : [];
        await afterEpicLookup?.();
        return { data };
      }
      throw new Error(`Unexpected route: ${route}`);
    } };
  },
} });
const eventPublisher = await import('../../core/src/utils/eventPublisher.js');
await mock.module('../../core/src/utils/eventPublisher.js', { namedExports: { ...eventPublisher,
  getEventPublisher: () => ({ publishActivity: async () => true }),
} });
const core = await import('@propr/core');
await mock.module('@propr/core', { namedExports: { ...core,
  updatePlanIssue: async (...input: Parameters<typeof core.updatePlanIssue>) => {
    if (interruptHeadPersistence && input[1] === 10 && input[2].status === 'processing') throw new Error('interrupted head persistence');
    return core.updatePlanIssue(...input);
  },
  generateCompletionComment: async () => 'Completed.',
  loadAgents: async () => [{ enabled: true, alias: 'test', supportedModels: ['model'] }],
  loadSyntheticAgents: async () => [],
  ensureEpicPR: async () => {
    if (initialEpicFailure) throw new Error('GitHub unavailable');
    return { success: true, labelName: 'base-epic', prNumber: 999 };
  },
  getPlanIssuesByDraft: async (id: string) => {
    const snapshot = await core.getPlanIssuesByDraft(id);
    const hook = afterIssueLoad;
    afterIssueLoad = undefined;
    await hook?.();
    return snapshot;
  },
  getIssueQueue: async () => ({ add: async (_name: string, job: { number: number }) => { dispatches.push(job.number); } }),
} });
const registry = core.AgentRegistry.getInstance();
mock.method(registry, 'ensureInitialized', async () => undefined);
mock.method(registry, 'getAgentByAlias', (alias: string) => alias === 'test' ? {
  config: { alias: 'test', type: 'codex', supportedModels: ['model', 'other'], defaultModel: 'model', enabled: true },
} : undefined);
const issueHelpers = await import('../routes/planIssueHelpers.js');
await mock.module('../routes/planIssueHelpers.js', { namedExports: { ...issueHelpers, getLlmLabel: async (model: string | null) => model ? `llm-${model}` : 'llm-old',
} });
const { createUpdateIssueHandler, createImplementIssueHandler } = await import('../routes/planIssueHandlers.js');
const { createQueueRemainingHandler } = await import('../routes/planExecutionQueueHandlers.js');
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
const headSelections: Array<string | null> = [];
const updates: Array<{ number: number; body: unknown }> = [];
const githubCalls: string[] = [];
let dispatchFailure = false;
let configFailure = false;
let dispatchFailureNumber: number | undefined;
let prepareFailureNumber: number | undefined;
const principal = { user: { id: 'user' }, grant: { id: 'grant' }, github: {
  request: async (route: string, input: Record<string, unknown>) => {
    githubCalls.push(route);
    if (route.startsWith('DELETE')) issueLabels.set(Number(input.issue_number), (issueLabels.get(Number(input.issue_number)) ?? []).filter(label => label !== input.name));
    return { data: {} };
  },
} } as unknown as McpPrincipal;
const deps = { db: database, policy: { repository: async () => {
  if (dispatches.length === 0 && prepareFailureNumber === 0) throw new Error('prepare failed');
  if (prepareFailureNumber !== undefined && dispatches.at(-1) === prepareFailureNumber) throw new Error('prepare failed');
}, requireScope: () => {},
  oauth: { store: { seal: (value: unknown) => JSON.stringify(value), unseal: (value: string) => JSON.parse(value) } },
} as unknown as McpPolicy, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never } satisfies ToolDeps;
const planner = {
  implementIssue: async (req: Request, res: Response) => {
    const number = Number(req.params.issueNumber);
    dispatches.push(number);
    // The real handler derives the label it removes from the selection persisted before it runs.
    headSelections.push((await database('plan_issues').where({ draft_id: planId, issue_number: number }).first()).model_name);
    if (dispatchFailure || number === dispatchFailureNumber) throw new Error('dispatch failed');
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
  dispatches.length = 0; headSelections.length = 0; updates.length = 0; githubCalls.length = 0; labelCalls.length = 0; issueLabels.clear();
  for (const number of [10, 20, 30, 40]) issueLabels.set(number, ['llm-old', 'base-old', 'auto-merge']);
  initialEpicFailure = false; interruptHeadPersistence = false; afterIssueLoad = undefined; beforeAuth = undefined; afterIssueRead = undefined;
  dispatchFailure = false; configFailure = false; dispatchFailureNumber = undefined; prepareFailureNumber = undefined;
  epicPR = null; epicLookups = 0; epicLabelFailure = false; queuedLabelFailure = false; afterEpicLookup = undefined;
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
  assert.equal(typeof data.executionId, 'string');
  assert.equal(data.executionId, queue?.executionId);
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
  const queue = await core.getEpicExecutionQueue(planId);
  assert.equal(queue?.parallel, true);
  assert.deepEqual(queue?.issues, [40, 10, 30]);
});

test('non-epic calls ignore sequential execution preference', async () => {
  const result = await run({ useEpic: false, epicExecution: 'sequential', models: [...models, ...models] });
  assert.deepEqual(dispatches, [40, 10, 30]);
  assert.equal((result.data as { executionMode: string }).executionMode, 'parallel');
  assert.equal(await core.getEpicExecutionQueue(planId), null);
});

test('a parallel epic labels its epic PR once after all children finish, without serializing dispatch', async () => {
  epicPR = { number: 999, labels: [] };
  await run({ epicExecution: 'parallel' });
  assert.deepEqual(dispatches, [40, 10, 30]);
  await core.updatePlanIssueStatus(repository, 40, core.PlanIssueStatus.MERGED);
  await core.updatePlanIssueStatus(repository, 10, core.PlanIssueStatus.CLOSED);
  assert.equal(labelCalls.some(call => call.number === 999), false);
  // The unselected issue still blocks the whole-plan completion check.
  await database('plan_issues').where({ draft_id: planId, issue_number: 20 }).update({ status: 'merged' });
  await core.updatePlanIssueStatus(repository, 30, core.PlanIssueStatus.MERGED);
  assert.equal((await core.getEpicExecutionQueue(planId))?.status, 'completed');
  assert.ok((await core.getEpicExecutionQueue(planId))?.finalizedAt);
  await core.reconcileEpicExecutionQueues();
  assert.deepEqual(labelCalls.filter(call => call.labels.includes('AI')), [{ number: 999, labels: ['AI'] }]);
});

test('a parallel epic cannot start under a non-epic queue that owes no epic finalization', async () => {
  await core.createEpicExecutionQueue({ draftId: planId, repository, issues: [20], useEpic: false });
  await assert.rejects(run({ epicExecution: 'parallel' }), error => error instanceof McpError && error.code === 'PRECONDITION_FAILED');
  assert.deepEqual(dispatches, []);
  assert.equal((await database('mcp_records').where({ kind: 'issue_execution' })).length, 0);
});

test('parallel epic dispatch failure retains finalization for an uncertain external outcome', async () => {
  dispatchFailure = true;
  await assert.rejects(run({ epicExecution: 'parallel' }), /dispatch failed/);
  assert.equal((await core.getEpicExecutionQueue(planId))?.status, 'active');
});

test('the sequential head keeps its prior model until its handler replaces that model label', async () => {
  await database('plan_issues').where({ draft_id: planId }).update({ agent_alias: 'test', model_name: 'other' });
  await run();
  assert.deepEqual(headSelections, ['other']);
  for (const number of [30, 40]) {
    assert.equal((await database('plan_issues').where({ draft_id: planId, issue_number: number }).first()).model_name, 'model');
  }
  assert.equal((await database('plan_issues').where({ draft_id: planId, issue_number: 20 }).first()).model_name, 'other');
});

test('multiple models fail before any claim, queue or GitHub call', async () => {
  await assert.rejects(run({ models: [...models, ...models] }), error => error instanceof McpError && error.code === 'INVALID_INPUT');
  assert.deepEqual(dispatches, []);
  assert.deepEqual(githubCalls, []);
  assert.equal(await core.getEpicExecutionQueue(planId), null);
  assert.equal((await database('mcp_records')).length, 0);
});

test('head rejection before labels cancels the queue and permits a fresh MCP claim', async () => {
  dispatchFailure = true;
  await assert.rejects(run(), /dispatch failed/);
  assert.equal((await core.getEpicExecutionQueue(planId))?.status, 'cancelled');
  assert.deepEqual(updates, []);
  dispatchFailure = false;
  assert.equal((await run({ idempotencyKey: 'epic-request-retry' })).status, 202);
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
  // An omitted ultrafixGoal has no literal default: it resolves from the instance rating goal only when ultrafix runs.
  const previous = { repository, planId, idempotencyKey: 'epic-request-1', issues: [40, 10, 30], models,
    useEpic: true, autoMerge: false, runUltrafix: false, ultrafixMaxCycles: 3 };
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
  await core.startEpicQueueHead(planId, { finalize: async () => true });
  const completed = await getOperation.run({ principal, args: { operationId: accepted.operationId } } as never);
  assert.equal((completed.data as { state: string }).state, 'completed');
  assert.equal((completed.data as { targetState: { epicQueue: { status: string } } }).targetState.epicQueue.status, 'completed');
});

for (const queueStatus of ['active', 'cancelled'] as const) {
  for (const mode of ['non-epic', 'parallel'] as const) {
    test(`${mode} receipt completes independently of an unrelated ${queueStatus} queue`, async () => {
      dispatchFailure = queueStatus === 'cancelled';
      if (dispatchFailure) {
        await assert.rejects(run({ issues: [10, 30] }), /dispatch failed/);
        await core.cancelEpicExecutionQueue(planId);
      }
      else await run({ issues: [10, 30] });
      assert.equal((await core.getEpicExecutionQueue(planId))?.status, queueStatus);
      dispatchFailure = false;

      const operations = new McpOperations(database);
      const parsed = args({ issues: [20], idempotencyKey: 'independent-request',
        ...(mode === 'non-epic' ? { useEpic: false } : { epicExecution: 'parallel' }) });
      const accepted = await operations.run(principal, { tool: 'implement_plan', args: parsed, repository }, operationId =>
        implement.run({ principal, args: parsed, operationId } as never));
      assert.equal(accepted.state, 'accepted');
      assert.equal(Object.hasOwn(accepted.result as object, 'executionId'), false);
      const processing = await getOperation.run({ principal, args: { operationId: accepted.operationId } } as never);
      assert.equal((processing.data as { state: string }).state, 'accepted');

      await database('plan_issues').where({ draft_id: planId, issue_number: 20 }).update({ status: 'under_review' });
      const completed = await getOperation.run({ principal, args: { operationId: accepted.operationId } } as never);
      assert.equal((completed.data as { state: string }).state, 'completed');
      assert.equal((await operations.get(principal, String(accepted.operationId))).lifecycle, 'completed');
      // A parallel epic registers its own finalization only where no active execution already owes one.
      const replacement = mode === 'parallel' && queueStatus === 'cancelled';
      assert.equal((await core.getEpicExecutionQueue(planId))?.status, replacement ? 'active' : queueStatus);
      assert.equal((await core.getEpicExecutionQueue(planId))?.parallel, replacement);
    });
  }

  test(`completed sequential receipt is independent of its ${queueStatus} replacement before its first poll`, async () => {
    const operations = new McpOperations(database);
    const parsed = args({ issues: [10, 30] });
    const accepted = await operations.run(principal, { tool: 'implement_plan', args: parsed, repository }, operationId =>
      implement.run({ principal, args: parsed, operationId } as never));
    const originalExecutionId = (accepted.result as { executionId: string }).executionId;
    assert.equal(originalExecutionId, (await core.getEpicExecutionQueue(planId))?.executionId);
    await database('plan_issues').where({ draft_id: planId }).whereIn('issue_number', [10, 30]).update({ status: 'merged' });
    await core.startEpicQueueHead(planId, { finalize: async () => true });
    assert.equal((await core.getEpicExecutionQueue(planId))?.status, 'completed');
    assert.equal((await operations.get(principal, String(accepted.operationId))).lifecycle, 'accepted');

    dispatchFailure = queueStatus === 'cancelled';
    const nextArgs = args({ issues: [40], idempotencyKey: 'replacement-request' });
    const replacement = await operations.run(principal, { tool: 'implement_plan', args: nextArgs, repository }, operationId =>
      implement.run({ principal, args: nextArgs, operationId } as never));
    if (queueStatus === 'cancelled') await core.cancelEpicExecutionQueue(planId);
    const queue = await core.getEpicExecutionQueue(planId);
    assert.equal(queue?.status, queueStatus);
    assert.notEqual(queue?.executionId, originalExecutionId);

    if (queueStatus === 'active') {
      assert.equal((replacement.result as { executionId: string }).executionId, queue?.executionId);
      await database('plan_issues').where({ draft_id: planId, issue_number: 40 }).update({ status: 'under_review' });
      const pending = await getOperation.run({ principal, args: { operationId: replacement.operationId } } as never);
      assert.equal((pending.data as { state: string }).state, 'accepted');
    }
    const completed = await getOperation.run({ principal, args: { operationId: accepted.operationId } } as never);
    assert.equal((completed.data as { state: string }).state, 'completed');
    assert.equal((await operations.get(principal, String(accepted.operationId))).lifecycle, 'completed');
    assert.equal((await core.getEpicExecutionQueue(planId))?.executionId, queue?.executionId);
    assert.equal((await core.getEpicExecutionQueue(planId))?.status, queueStatus);
  });
}

test('sequential result retains its execution identity across awaited queue finalization', async () => {
  await database('plan_issues').where({ draft_id: planId }).whereIn('issue_number', [20, 30, 40]).update({ status: 'merged' });
  // The head can finish before the initial implementation request returns.
  const handler = mock.method(planner, 'implementIssue', async (req: Request, res: Response) => {
    await database('plan_issues').where({ draft_id: planId, issue_number: Number(req.params.issueNumber) }).update({ status: 'merged' });
    res.json({ issueNumber: Number(req.params.issueNumber) });
  });
  let originalExecutionId: string | undefined;
  afterEpicLookup = async () => {
    const queue = await core.getEpicExecutionQueue(planId);
    assert.equal(queue?.status, 'completed');
    originalExecutionId = queue?.executionId;
    await core.createEpicExecutionQueue({ draftId: planId, repository, issues: [40], ready: false });
  };
  try {
    const result = await run({ issues: [10] });
    assert.equal(typeof originalExecutionId, 'string');
    assert.equal((result.data as { executionId: string }).executionId, originalExecutionId);
    assert.notEqual((await core.getEpicExecutionQueue(planId))?.executionId, originalExecutionId);
  } finally {
    handler.mock.restore();
  }
});

test('status-write hooks and concurrent webhook observers dispatch the selected successor only once', async () => {
  await run();
  await Promise.all([core.updatePlanIssueStatus(repository, 10, core.PlanIssueStatus.MERGED),
    core.updatePlanIssue(planId, 10, { status: core.PlanIssueStatus.MERGED })]);
  await core.startEpicQueueHead(planId);
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

async function startFromUI(issueNumber: number, autoMerge = false, useEpic = true, extra: Record<string, unknown> = {}) {
  const handler = createImplementIssueHandler({ verifyOwnership: async () => ({ authorized: true,
    draft: await database('task_drafts').where({ draft_id: planId }).first() }) });
  let status = 200;
  let body: unknown;
  const response = { status(code: number) { status = code; return this; }, json(value: unknown) { body = value; } };
  await handler({ params: { id: planId, issueNumber: String(issueNumber) }, user: { id: 'user' },
    body: { useEpic, autoMerge, ...extra } } as never, response as never);
  return { status, body };
}

test('UI initiated epic runs every remaining issue through the queue and finalizes once', async () => {
  epicPR = { number: 999, labels: [] };
  await database('task_drafts').where({ draft_id: planId }).update({ context_config: JSON.stringify({ useEpic: true }) });
  await database('plan_issues').where({ draft_id: planId }).update(models[0]);
  assert.equal((await startFromUI(10, true)).status, 200);
  const queue = await core.getEpicExecutionQueue(planId);
  assert.deepEqual(queue?.issues, [10, 20, 30, 40]);
  assert.equal(queue?.ready, true);
  assert.deepEqual(dispatches, [10]);
  assert.deepEqual(labelCalls.filter(call => call.labels.includes('AI')).map(call => call.number), [10]);
  for (const number of [10, 20, 30, 40]) {
    await core.updatePlanIssueStatus(repository, number, core.PlanIssueStatus.MERGED);
    await core.startEpicQueueHead(planId);
  }
  assert.deepEqual(labelCalls.filter(call => call.labels.includes('AI')).map(call => call.number), [10, 20, 30, 40, 999]);
  assert.equal((await core.getEpicExecutionQueue(planId))?.status, 'completed');
  assert.ok((await core.getEpicExecutionQueue(planId))?.finalizedAt);
  issueLabels.set(999, ['AI-done']);
  await core.reconcileEpicExecutionQueues();
  assert.equal(labelCalls.filter(call => call.number === 999).length, 1);
});

test('a completed MCP subset stays idle until the UI queues and completes the remainder', async () => {
  epicPR = { number: 999, labels: [] };
  await database('plan_issues').where({ draft_id: planId }).update(models[0]);
  await run({ issues: [10, 30] });
  const executionId = (await core.getEpicExecutionQueue(planId))?.executionId;
  await core.updatePlanIssueStatus(repository, 10, core.PlanIssueStatus.MERGED);
  await core.updatePlanIssueStatus(repository, 30, core.PlanIssueStatus.MERGED);
  await core.reconcileEpicExecutionQueues();
  assert.equal((await core.getEpicExecutionQueue(planId))?.status, 'completed');
  assert.deepEqual(labelCalls.filter(call => call.labels.includes('AI')).map(call => call.number), [30]);
  assert.equal((await startFromUI(20)).status, 200);
  const remaining = await core.getEpicExecutionQueue(planId);
  assert.deepEqual(remaining?.issues, [20, 40]);
  assert.notEqual(remaining?.executionId, executionId);
  await core.updatePlanIssueStatus(repository, 20, core.PlanIssueStatus.MERGED);
  assert.deepEqual(labelCalls.filter(call => call.labels.includes('AI')).slice(-1), [{ number: 40, labels: ['AI', 'base-epic'] }]);
  await core.updatePlanIssueStatus(repository, 40, core.PlanIssueStatus.MERGED);
  assert.equal((await core.getEpicExecutionQueue(planId))?.status, 'completed');
  assert.ok((await core.getEpicExecutionQueue(planId))?.finalizedAt);
  await core.reconcileEpicExecutionQueues();
  assert.equal(labelCalls.filter(call => call.number === 999).length, 1);
});

test('UI queues preserve issue model selections and do not publish successor trigger labels during setup', async () => {
  await database('plan_issues').where({ draft_id: planId }).update(models[0]);
  await database('plan_issues').where({ draft_id: planId, issue_number: 20 }).update({ model_name: 'other' });
  assert.equal((await startFromUI(10)).status, 200);
  assert.equal((await database('plan_issues').where({ draft_id: planId, issue_number: 20 }).first()).model_name, 'other');
  assert.deepEqual(issueLabels.get(20)?.sort(), ['base-epic', 'llm-other']);
  assert.equal(issueLabels.get(20)?.includes('AI'), false);
  await core.updatePlanIssueStatus(repository, 10, core.PlanIssueStatus.MERGED);
  assert.deepEqual(labelCalls.filter(call => call.labels.includes('AI')).map(call => call.number), [10, 20]);
  assert.ok(issueLabels.get(20)?.includes('llm-other'));
});

test('recovery completes interrupted UI setup without replacing per-issue model choices or starting successors early', async () => {
  await database('plan_issues').where({ draft_id: planId }).update(models[0]);
  await database('plan_issues').where({ draft_id: planId, issue_number: 20 }).update({ model_name: 'other' });
  queuedLabelFailure = true;
  assert.equal((await startFromUI(10)).status, 500);
  assert.equal((await core.getEpicExecutionQueue(planId))?.ready, false);
  await core.updatePlanIssueStatus(repository, 10, core.PlanIssueStatus.MERGED);
  assert.equal(labelCalls.some(call => call.number === 20 && call.labels.includes('AI')), false);
  queuedLabelFailure = false;
  await database('epic_execution_queues').where({ draft_id: planId }).update({ created_at: 0 });
  await core.reconcileEpicExecutionQueues();
  assert.equal((await core.getEpicExecutionQueue(planId))?.ready, true);
  assert.equal((await core.getEpicExecutionQueue(planId))?.cursor, 1);
  assert.equal((await database('plan_issues').where({ draft_id: planId, issue_number: 20 }).first()).model_name, 'other');
  assert.deepEqual(issueLabels.get(20)?.sort(), ['AI', 'base-epic', 'llm-test~other']);
  assert.deepEqual(labelCalls.filter(call => call.labels.includes('AI')).map(call => call.number), [10, 20]);
});

test('UI requests cannot compete with an active MCP queue', async () => {
  await run({ issues: [10, 20] });
  const queue = await core.getEpicExecutionQueue(planId);
  assert.equal((await startFromUI(30)).status, 409);
  assert.equal((await core.getEpicExecutionQueue(planId))?.executionId, queue?.executionId);
  assert.deepEqual(dispatches, [10]);
});

test('UI can replace a cancelled queue with the remaining epic', async () => {
  await database('plan_issues').where({ draft_id: planId }).update(models[0]);
  await core.createEpicExecutionQueue({ draftId: planId, repository, issues: [10] });
  await core.cancelEpicExecutionQueue(planId);
  await core.updatePlanIssueStatus(repository, 10, core.PlanIssueStatus.MERGED);
  assert.deepEqual(labelCalls, []);
  assert.equal((await startFromUI(20)).status, 200);
  assert.deepEqual((await core.getEpicExecutionQueue(planId))?.issues, [20, 30, 40]);
});

test('a failed UI epic head continues the epic instead of blocking it', async () => {
  await database('plan_issues').where({ draft_id: planId }).update(models[0]);
  assert.equal((await startFromUI(10, true)).status, 200);
  assert.equal((await core.getEpicExecutionQueue(planId))?.advanceOn, 'terminal');
  // closeFailedPlanIssue records a failed task without a PR as closed.
  await core.updatePlanIssueStatus(repository, 10, core.PlanIssueStatus.CLOSED);
  const queue = await core.getEpicExecutionQueue(planId);
  assert.equal(queue?.cursor, 1);
  assert.equal(queue?.blockedReason, null);
  assert.deepEqual(labelCalls.filter(call => call.labels.includes('AI')).slice(-1),
    [{ number: 20, labels: ['AI', 'auto-merge', 'base-epic'] }]);
});

test('a non-epic auto-merge UI request starts the next pending issue after each merge or failure', async () => {
  await database('plan_issues').where({ draft_id: planId }).update(models[0]);
  assert.equal((await startFromUI(30, true, false)).status, 200);
  const queue = await core.getEpicExecutionQueue(planId);
  assert.deepEqual(queue?.issues, [30, 10, 20, 40]);
  assert.equal(queue?.useEpic, false);
  assert.equal(queue?.advanceOn, 'terminal');
  assert.deepEqual(dispatches, [30]);
  assert.deepEqual(issueLabels.get(10)?.sort(), ['auto-merge', 'llm-model']);
  assert.equal(labelCalls.some(call => call.number !== 30 && call.labels.includes('AI')), false);
  await database('plan_issues').where({ draft_id: planId, issue_number: 30 }).update({ pr_number: 300 });
  await core.updatePlanIssueByPR(repository, 300, { status: core.PlanIssueStatus.MERGED });
  assert.deepEqual(issueLabels.get(10)?.sort(), ['AI', 'auto-merge', 'llm-model']);
  await core.updatePlanIssueStatus(repository, 10, core.PlanIssueStatus.CLOSED);
  assert.deepEqual(issueLabels.get(20)?.sort(), ['AI', 'auto-merge', 'llm-model']);
  // The plan's stored epic label belongs to an earlier epic run; non-epic successors must not target it.
  assert.deepEqual(labelCalls.filter(call => call.labels.includes('AI')).slice(1),
    [{ number: 10, labels: ['AI', 'auto-merge'] }, { number: 20, labels: ['AI', 'auto-merge'] }]);
  // Completing the non-epic queue must not activate the historical epic PR.
  epicPR = { number: 999, labels: [] };
  await core.updatePlanIssueStatus(repository, 20, core.PlanIssueStatus.MERGED);
  assert.deepEqual(issueLabels.get(40)?.sort(), ['AI', 'auto-merge', 'llm-model']);
  await core.updatePlanIssueStatus(repository, 40, core.PlanIssueStatus.MERGED);
  assert.equal((await core.getEpicExecutionQueue(planId))?.status, 'completed');
  assert.ok((await core.getEpicExecutionQueue(planId))?.finalizedAt);
  await core.reconcileEpicExecutionQueues();
  assert.equal(epicLookups, 0);
  assert.equal(labelCalls.some(call => call.number === 999), false);
});

test('non-epic UI requests without auto-merge start only the requested issue', async () => {
  await database('plan_issues').where({ draft_id: planId }).update(models[0]);
  assert.equal((await startFromUI(10, false, false)).status, 200);
  assert.equal(await core.getEpicExecutionQueue(planId), null);
  await core.updatePlanIssueStatus(repository, 10, core.PlanIssueStatus.MERGED);
  assert.deepEqual(labelCalls.filter(call => call.labels.includes('AI')).map(call => call.number), [10]);
});

test('starting another auto-merge issue during an active queue runs it without replacing the queue', async () => {
  await database('plan_issues').where({ draft_id: planId }).update(models[0]);
  assert.equal((await startFromUI(10, true, false)).status, 200);
  const executionId = (await core.getEpicExecutionQueue(planId))?.executionId;
  assert.equal((await startFromUI(20, true, false)).status, 200);
  assert.equal((await core.getEpicExecutionQueue(planId))?.executionId, executionId);
  await core.updatePlanIssueStatus(repository, 20, core.PlanIssueStatus.MERGED);
  await core.updatePlanIssueStatus(repository, 10, core.PlanIssueStatus.MERGED);
  assert.deepEqual(labelCalls.filter(call => call.labels.includes('AI')).map(call => call.number), [10, 20, 30]);
});

async function completeAllSelectedIssues() {
  await run({ issues: [10, 20, 30, 40] });
  await database('plan_issues').where({ draft_id: planId }).update({ status: 'merged' });
  await core.startEpicQueueHead(planId);
}

test('finalized epics are not relabeled after the processing label is consumed', async () => {
  epicPR = { number: 999, labels: [] };
  await completeAllSelectedIssues();
  assert.deepEqual(labelCalls.filter(call => call.number === 999), [{ number: 999, labels: ['AI'] }]);
  assert.ok((await core.getEpicExecutionQueue(planId))?.finalizedAt);
  issueLabels.set(999, ['AI-done']);
  assert.deepEqual(await core.reconcileEpicExecutionQueues(), { reconciled: 0 });
  assert.deepEqual(await core.reconcileEpicExecutionQueues(), { reconciled: 0 });
  assert.equal(epicLookups, 1);
});

test('GitHub labeling failure preserves the obligation for reconciliation', async () => {
  epicPR = { number: 999, labels: [] };
  epicLabelFailure = true;
  await completeAllSelectedIssues();
  assert.equal((await core.getEpicExecutionQueue(planId))?.finalizedAt, null);
  epicLabelFailure = false;
  await core.reconcileEpicExecutionQueues();
  assert.ok((await core.getEpicExecutionQueue(planId))?.finalizedAt);
  assert.equal(labelCalls.filter(call => call.number === 999).length, 1);
});

test('queue recovery uses persisted epic evidence to retry finalization', async () => {
  epicPR = { number: 999, labels: [] };
  epicLabelFailure = true;
  await completeAllSelectedIssues();
  assert.equal((await core.getEpicExecutionQueue(planId))?.finalizedAt, null);
  epicLabelFailure = false;
  await core.reconcileEpicExecutionQueues();
  assert.deepEqual(labelCalls.filter(call => call.number === 999), [{ number: 999, labels: ['AI'] }]);
  assert.ok((await core.getEpicExecutionQueue(planId))?.finalizedAt);
});

test('no open epic PR resolves finalization without repeating GitHub lookups', async () => {
  await completeAllSelectedIssues();
  assert.ok((await core.getEpicExecutionQueue(planId))?.finalizedAt);
  assert.equal(epicLookups, 1);
  await core.reconcileEpicExecutionQueues();
  assert.equal(epicLookups, 1);
});

test('pausing during epic lookup defers labeling until recovery after resume', async () => {
  epicPR = { number: 999, labels: [] };
  afterEpicLookup = async () => { await core.pauseDraft(planId); };
  await completeAllSelectedIssues();
  assert.equal(labelCalls.some(call => call.number === 999), false);
  assert.equal((await core.getEpicExecutionQueue(planId))?.finalizedAt, null);
  afterEpicLookup = undefined;
  await core.reconcileEpicExecutionQueues();
  assert.equal(labelCalls.some(call => call.number === 999), false);
  await core.resumeDraft(planId);
  await core.reconcileEpicExecutionQueues();
  assert.equal(labelCalls.filter(call => call.number === 999).length, 1);
  assert.ok((await core.getEpicExecutionQueue(planId))?.finalizedAt);
});

test('a child becoming pending during epic lookup keeps finalization owed', async () => {
  epicPR = { number: 999, labels: [] };
  afterEpicLookup = async () => {
    await database('plan_issues').where({ draft_id: planId, issue_number: 40 }).update({ status: 'pending' });
  };
  await completeAllSelectedIssues();
  assert.equal(labelCalls.some(call => call.number === 999), false);
  assert.equal((await core.getEpicExecutionQueue(planId))?.finalizedAt, null);
  afterEpicLookup = undefined;
  await database('plan_issues').where({ draft_id: planId, issue_number: 40 }).update({ status: 'merged' });
  await core.reconcileEpicExecutionQueues();
  assert.ok((await core.getEpicExecutionQueue(planId))?.finalizedAt);
});

test('replacement during epic lookup revokes the old finalizer before labeling', async () => {
  epicPR = { number: 999, labels: [] };
  afterEpicLookup = async () => {
    await core.createEpicExecutionQueue({ draftId: planId, repository, issues: [40] });
  };
  await completeAllSelectedIssues();
  assert.equal(labelCalls.some(call => call.number === 999), false);
  const queue = await core.getEpicExecutionQueue(planId);
  assert.equal(queue?.status, 'active');
  assert.equal(queue?.finalizedAt, null);
  assert.equal(queue?.finalizationStartedAt, null);
});

for (const failure of ['prepare', 'dispatch'] as const) {
  test(`parallel finalization survives second child ${failure} failure after the first starts`, async () => {
    epicPR = { number: 999, labels: [] };
    if (failure === 'prepare') prepareFailureNumber = 10;
    else dispatchFailureNumber = 20;
    await assert.rejects(run({ issues: [10, 20], epicExecution: 'parallel' }), new RegExp(`${failure} failed`));
    assert.equal((await core.getEpicExecutionQueue(planId))?.status, 'active');
    assert.equal((await database('plan_issues').where({ draft_id: planId, issue_number: 10 }).first()).status, 'processing');
    if (failure === 'prepare') {
      assert.equal(await database('mcp_records').where({ kind: 'issue_execution', id: `${planId}:20` }).first(), undefined);
      prepareFailureNumber = undefined;
      await run({ issues: [20], epicExecution: 'parallel', idempotencyKey: 'retry-child' });
      assert.equal((await database('plan_issues').where({ draft_id: planId, issue_number: 20 }).first()).status, 'processing');
    } else {
      assert.ok(await database('mcp_records').where({ kind: 'issue_execution', id: `${planId}:20` }).first());
    }
    for (const number of [20, 30, 40]) await core.updatePlanIssueStatus(repository, number, core.PlanIssueStatus.CLOSED);
    await core.updatePlanIssueStatus(repository, 10, core.PlanIssueStatus.MERGED);
    assert.equal((await core.getEpicExecutionQueue(planId))?.status, 'completed');
    assert.ok((await core.getEpicExecutionQueue(planId))?.finalizedAt);
    assert.equal(labelCalls.filter(call => call.number === 999).length, 1);
  });
}

for (const epicExecution of ['parallel', 'sequential']) {
  test(`${epicExecution} preparation failure before any dispatch cancels only its own queue`, async () => {
    prepareFailureNumber = 0;
    await assert.rejects(run({ epicExecution }), /prepare failed/);
    assert.deepEqual(dispatches, []);
    assert.equal((await core.getEpicExecutionQueue(planId))?.status, 'cancelled');
  });
}

for (const useEpic of [true, false]) {
  test(`UI useEpic=${useEpic} retains its queue when implementation starts then rejects`, async () => {
    await database('plan_issues').where({ draft_id: planId }).update(models[0]);
    const { enqueueEpicImplementation, enqueueAutoMergeImplementation } = await import('../routes/planIssueEpicQueue.js');
    const enqueue = useEpic ? enqueueEpicImplementation : enqueueAutoMergeImplementation;
    await assert.rejects(enqueue({ draftId: planId, repository, issueNumber: 10, autoMerge: true,
      contextConfig: null, implement: async () => {
        await database('plan_issues').where({ draft_id: planId, issue_number: 10 }).update({ status: 'processing' });
        throw new Error('uncertain dispatch');
      } }), /uncertain dispatch/);
    assert.equal((await core.getEpicExecutionQueue(planId))?.status, 'active');
    assert.equal((await core.getEpicExecutionQueue(planId))?.ready, false);
  });
}

test('preparation failure under an existing epic cannot cancel its finalization obligation', async () => {
  await run({ issues: [10] });
  const original = await core.getEpicExecutionQueue(planId);
  prepareFailureNumber = 10;
  await assert.rejects(run({ issues: [20], epicExecution: 'parallel' }), /prepare failed/);
  const queue = await core.getEpicExecutionQueue(planId);
  assert.equal(queue?.executionId, original?.executionId);
  assert.equal(queue?.status, 'active');
  prepareFailureNumber = undefined;
  await run({ issues: [20], epicExecution: 'parallel' });
  assert.equal((await core.getEpicExecutionQueue(planId))?.executionId, original?.executionId);
  assert.equal((await database('plan_issues').where({ draft_id: planId, issue_number: 20 }).first()).status, 'processing');
});


test('UI epic rejected before publishing labels can be retried', async () => {
  await database('task_drafts').where({ draft_id: planId }).update({ context_config: JSON.stringify({ useEpic: true }) });
  await database('plan_issues').where({ draft_id: planId }).update(models[0]);
  initialEpicFailure = true;
  assert.equal((await startFromUI(10)).status, 500);
  initialEpicFailure = false;
  assert.equal((await core.getEpicExecutionQueue(planId))?.status, 'cancelled');
  assert.equal((await startFromUI(10)).status, 200);
});

test('reconciliation cancels a never-started MCP queue and releases its claims for retry', async () => {
  configFailure = true;
  await assert.rejects(run(), /selector sync failed/);
  await database('plan_issues').where({ draft_id: planId, issue_number: 10 }).update({ status: 'pending', agent_alias: null, model_name: null });
  issueLabels.set(10, []);
  await database('epic_execution_queues').where({ draft_id: planId }).update({ created_at: 0 });
  await core.reconcileEpicExecutionQueues();
  assert.equal((await core.getEpicExecutionQueue(planId))?.status, 'cancelled');
  configFailure = false;
  assert.equal((await run({ idempotencyKey: 'epic-request-retry' })).status, 202);
});

test('a competing auto-merge request loses its claim before any successor configuration', async () => {
  const { enqueueAutoMergeImplementation } = await import('../routes/planIssueEpicQueue.js');
  afterIssueLoad = async () => { await run({ issues: [10, 20], autoMerge: false }); };
  await enqueueAutoMergeImplementation({ draftId: planId, issueNumber: 30, repository, contextConfig: null, implement: async () => undefined });
  assert.deepEqual(issueLabels.get(20)?.sort(), ['base-epic', 'llm-model']);
  assert.deepEqual((await core.getEpicExecutionQueue(planId))?.issues, [10, 20]);
  // A stale label added out of band must still be removed by dispatch authority.
  issueLabels.set(20, [...issueLabels.get(20)!, 'auto-merge']);
  await core.updatePlanIssueStatus(repository, 10, core.PlanIssueStatus.MERGED);
  assert.equal(issueLabels.get(20)?.includes('auto-merge'), false);
});

for (const partial of [{ agent_alias: null, model_name: null }, { agent_alias: 'test', model_name: null }, { agent_alias: null, model_name: 'model' }, { agent_alias: null, model_name: 'other' }]) {
  test(`setup recovery resolves successor defaults independently of the head: ${JSON.stringify(partial)}`, async () => {
    const defaultAgent = mock.method(registry, 'getDefaultAgent', () => registry.getAgentByAlias('test'));
    try {
      await database('plan_issues').where({ draft_id: planId, issue_number: 10 }).update({ agent_alias: 'test', model_name: 'other', status: 'processing' });
      await database('plan_issues').where({ draft_id: planId, issue_number: 20 }).update(partial);
      issueLabels.set(10, ['base-epic', 'llm-test~other', 'AI']);
      await core.createEpicExecutionQueue({ draftId: planId, repository, issues: [10, 20], ready: false }, { now: () => 0 });
      await core.reconcileEpicExecutionQueues();
      const successor = await database('plan_issues').where({ draft_id: planId, issue_number: 20 }).first();
      assert.equal(successor.agent_alias, 'test');
      assert.equal(successor.model_name, partial.model_name ?? 'model');
      assert.equal((await core.getEpicExecutionQueue(planId))?.ready, true);
      assert.equal(issueLabels.get(20)?.includes(`llm-test~${partial.model_name ?? 'model'}`), true);
    } finally { defaultAgent.mock.restore(); }
  });
}

test('successful no-change head releases its successor with auto-merge disabled', async () => {
  await mock.module('../../../src/jobs/issueJob/config.js', { namedExports: { redisClient: {} } });
  await mock.module('../../../src/github/autoMergeOperations.js', { namedExports: { enableAutoMerge: async () => ({ success: true }) } });
  const { handleNoCodeChanges } = await import('../../../src/jobs/issueJobPostProcessingHelpers.js');
  await run({ issues: [10, 20], autoMerge: false });
  await handleNoCodeChanges({ octokit: { request: async () => ({ data: {} }) } as never,
    issueRef: { repoOwner: 'acme', repoName: 'repo', number: 10 } as never,
    claudeResult: { success: true } as never, currentIssueData: { data: { labels: [{ name: 'AI' }] } },
    AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', correlatedLogger: core.logger });
  assert.equal((await database('plan_issues').where({ draft_id: planId, issue_number: 10 }).first()).status, 'merged');
  assert.equal((await core.getEpicExecutionQueue(planId))?.cursor, 1);
  assert.deepEqual(labelCalls.filter(call => call.labels.includes('AI')).map(call => call.number), [20]);
  assert.equal(issueLabels.get(20)?.includes('auto-merge'), false);
});


test('non-epic queue owns successors and holds advancement across configuration awaits', async () => {
  const { enqueueAutoMergeImplementation } = await import('../routes/planIssueEpicQueue.js');
  await database('plan_issues').where({ draft_id: planId }).update(models[0]);
  beforeAuth = async () => {
    const queue = await core.getEpicExecutionQueue(planId);
    assert.equal(queue?.ready, false);
    await core.updatePlanIssueStatus(repository, 10, core.PlanIssueStatus.MERGED);
    assert.equal((await core.getEpicExecutionQueue(planId))?.cursor, 0);
    assert.equal(labelCalls.some(call => call.labels.includes('AI')), false);
  };
  await enqueueAutoMergeImplementation({ draftId: planId, issueNumber: 10, repository, contextConfig: null,
    implement: async () => { await database('plan_issues').where({ draft_id: planId, issue_number: 10 }).update({ status: 'processing' }); } });
  assert.equal((await core.getEpicExecutionQueue(planId))?.ready, true);
  assert.equal((await core.getEpicExecutionQueue(planId))?.cursor, 1);
  assert.deepEqual(labelCalls.filter(call => call.labels.includes('AI')).map(call => call.number), [20]);
});

for (const evidence of ['processing-label', 'status-changed-during-read', 'replacement'] as const) {
  test(`never-started cancellation preserves durable work with ${evidence}`, async () => {
    const queue = await core.createEpicExecutionQueue({ draftId: planId, repository, issues: [10, 20], ready: false });
    if (evidence === 'processing-label') issueLabels.set(10, ['AI']);
    if (evidence === 'status-changed-during-read') afterIssueRead = async () => {
      await database('plan_issues').where({ draft_id: planId, issue_number: 10 }).update({ status: 'processing' });
    };
    if (evidence === 'replacement') afterIssueRead = async () => {
      await core.cancelEpicExecutionQueue(planId, queue.executionId);
      await core.createEpicExecutionQueue({ draftId: planId, repository, issues: [10, 20], ready: false });
    };
    assert.equal(await core.cancelUnstartedEpicExecutionQueue(queue), false);
    assert.equal((await core.getEpicExecutionQueue(planId))?.status, 'active');
  });
}

test('retry only releases MCP claims belonging to the cancelled execution', async () => {
  const queue = await core.createEpicExecutionQueue({ draftId: planId, repository, issues: [10, 20], ready: false });
  await core.cancelUnstartedEpicExecutionQueue(queue);
  await database('mcp_records').insert({ kind: 'issue_execution', id: `${planId}:20`, owner_id: 'user',
    value: JSON.stringify({ operationId: 'other', executionId: 'other-execution' }), expires_at: null });
  await assert.rejects(run({ issues: [10, 20] }), error => error instanceof McpError && error.code === 'IMPLEMENTATION_ALREADY_REQUESTED');
  assert.equal((await database('mcp_records').where({ kind: 'issue_execution', id: `${planId}:20` }).first()).value,
    JSON.stringify({ operationId: 'other', executionId: 'other-execution' }));
});

test('non-epic configuration failure is recovered without restoring the draft epic branch', async () => {
  await database('plan_issues').where({ draft_id: planId }).update(models[0]);
  queuedLabelFailure = true;
  assert.equal((await startFromUI(10, true, false)).status, 500);
  assert.equal((await core.getEpicExecutionQueue(planId))?.ready, false);
  queuedLabelFailure = false;
  await database('epic_execution_queues').where({ draft_id: planId }).update({ created_at: 0 });
  await core.reconcileEpicExecutionQueues();
  assert.equal((await core.getEpicExecutionQueue(planId))?.ready, true);
  assert.equal(issueLabels.get(20)?.some(label => label.startsWith('base-')), false);
  assert.equal(issueLabels.get(20)?.includes('auto-merge'), true);
});

for (const entry of ['MCP', 'UI epic', 'UI auto-merge'] as const) {
  for (const observedStatus of ['pending', 'merged'] as const) {
    test(`${entry} recovers the requested head model after dispatch interrupts before persistence (${observedStatus})`, async () => {
      await database('plan_issues').where({ draft_id: planId }).update({ agent_alias: 'test', model_name: 'other' });
      issueLabels.set(10, ['llm-test~other']);
      interruptHeadPersistence = true;
      if (entry === 'MCP') {
        const realHandler = createImplementIssueHandler({ verifyOwnership: async () => ({ authorized: true,
          draft: await database('task_drafts').where({ draft_id: planId }).first() }) }, { enqueueEpics: false });
        const handler = mock.method(planner, 'implementIssue', realHandler as never);
        try { await assert.rejects(run({ issues: [10, 20] }), error => error instanceof McpError && error.status === 500); }
        finally { handler.mock.restore(); }
      } else {
        assert.equal((await startFromUI(10, true, entry === 'UI epic', { models })).status, 500);
      }
      interruptHeadPersistence = false;
      const queue = (await core.getEpicExecutionQueue(planId))!;
      assert.equal(queue.ready, false);
      assert.deepEqual(queue.headSelection, models[0]);
      assert.equal((await database('plan_issues').where({ draft_id: planId, issue_number: 10 }).first()).model_name, 'other');
      assert.ok(issueLabels.get(10)?.includes('llm-test~model'));
      assert.equal(issueLabels.get(10)?.includes('llm-test~other'), false);
      await database('epic_execution_queues').where({ draft_id: planId }).update({ created_at: 0 });
      await database('plan_issues').where({ draft_id: planId, issue_number: 10 }).update({ status: observedStatus });
      await core.reconcileEpicExecutionQueues();
      assert.equal((await core.getEpicExecutionQueue(planId))?.ready, true);
      assert.equal((await database('plan_issues').where({ draft_id: planId, issue_number: 10 }).first()).model_name, 'model');
      await core.updatePlanIssueStatus(repository, 10, core.PlanIssueStatus.MERGED);
      assert.equal((await core.getEpicExecutionQueue(planId))?.cursor, 1);
      assert.ok(issueLabels.get(20)?.includes('AI'));
    });
  }
}

test('a remaining non-epic auto-merge execution inherits unresolved epic finalization', async () => {
  epicPR = { number: 999, labels: [] };
  await run({ issues: [10] });
  await core.updatePlanIssueStatus(repository, 10, core.PlanIssueStatus.MERGED);
  const previous = (await core.getEpicExecutionQueue(planId))!;
  assert.equal(previous.status, 'completed');
  assert.equal(previous.finalizedAt, null);
  await database('plan_issues').where({ draft_id: planId }).whereIn('issue_number', [20, 30, 40]).update(models[0]);
  assert.equal((await startFromUI(20, true, false)).status, 200);
  const replacement = (await core.getEpicExecutionQueue(planId))!;
  assert.notEqual(replacement.executionId, previous.executionId);
  assert.equal(replacement.useEpic, false);
  assert.equal(replacement.owesEpicFinalization, true);
  // The inherited obligation also covers a fresh parallel epic entry point.
  await run({ issues: [40], epicExecution: 'parallel' });
  assert.equal((await core.getEpicExecutionQueue(planId))?.executionId, replacement.executionId);
  for (const number of [20, 30, 40]) await core.updatePlanIssueStatus(repository, number, core.PlanIssueStatus.MERGED);
  assert.equal(labelCalls.filter(call => call.number === 999).length, 1);
  assert.ok((await core.getEpicExecutionQueue(planId))?.finalizedAt);
});

test('parallel failure releases later never-attempted children but preserves uncertain dispatch claims', async () => {
  dispatchFailureNumber = 20;
  await assert.rejects(run({ issues: [10, 20, 30], epicExecution: 'parallel' }), /dispatch failed/);
  for (const number of [10, 20]) assert.ok(await database('mcp_records').where({ kind: 'issue_execution', id: `${planId}:${number}` }).first());
  assert.equal(await database('mcp_records').where({ kind: 'issue_execution', id: `${planId}:30` }).first(), undefined);
  dispatchFailureNumber = undefined;
  await run({ issues: [30], epicExecution: 'parallel' });
  assert.equal((await database('plan_issues').where({ draft_id: planId, issue_number: 30 }).first()).status, 'processing');
});

test('setup recovery cannot restore a stale head selection after the execution is replaced', async () => {
  await database('plan_issues').where({ draft_id: planId }).update(models[0]);
  const old = await core.createEpicExecutionQueue({ draftId: planId, repository, issues: [10, 20], ready: false,
    headSelection: { agent_alias: 'test', model_name: 'other' } }, { now: () => 0 });
  issueLabels.set(10, ['base-epic', 'llm-test~other', 'AI']);
  afterIssueRead = async () => {
    await core.cancelEpicExecutionQueue(planId, old.executionId);
    await core.createEpicExecutionQueue({ draftId: planId, repository, issues: [10, 30], ready: false, headSelection: models[0] });
  };
  await core.reconcileEpicExecutionQueues();
  assert.equal((await database('plan_issues').where({ draft_id: planId, issue_number: 10 }).first()).model_name, 'model');
  assert.notEqual((await core.getEpicExecutionQueue(planId))?.executionId, old.executionId);
  assert.equal((await core.getEpicExecutionQueue(planId))?.ready, false);
});

async function queueRemainingFromUI(body: Record<string, unknown> = {}) {
  const handler = createQueueRemainingHandler({ verifyOwnership: async () => ({ authorized: true,
    draft: await database('task_drafts').where({ draft_id: planId }).first() }) });
  let status = 200;
  let payload: unknown;
  const response = { status(code: number) { status = code; return this; }, json(value: unknown) { payload = value; } };
  await handler({ params: { id: planId }, user: { id: 'user' }, body } as never, response as never);
  return { status, body: payload as { queued?: number[]; alreadyQueued?: boolean; error?: string } };
}

test('Queue Remaining queues pending epic issues behind a running issue without starting them', async () => {
  await database('task_drafts').where({ draft_id: planId }).update({ context_config: JSON.stringify({ useEpic: true, epicLabel: 'base-epic' }) });
  await database('plan_issues').where({ draft_id: planId }).update(models[0]);
  await database('plan_issues').where({ draft_id: planId, issue_number: 10 }).update({ status: 'processing' });
  const result = await queueRemainingFromUI();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.queued, [20, 30, 40]);
  const queue = await core.getEpicExecutionQueue(planId);
  assert.deepEqual(queue?.issues, [10, 20, 30, 40]);
  assert.equal(queue?.ready, true);
  assert.equal(labelCalls.some(call => call.labels.includes('AI')), false);
  assert.deepEqual(issueLabels.get(20)?.sort(), ['base-epic', 'llm-model']);
  await core.updatePlanIssueStatus(repository, 10, core.PlanIssueStatus.MERGED);
  assert.deepEqual(labelCalls.filter(call => call.labels.includes('AI')).map(call => call.number), [20]);
});

test('Queue Remaining extends an active queue once and is idempotent afterwards', async () => {
  await database('plan_issues').where({ draft_id: planId }).update(models[0]);
  await database('task_drafts').where({ draft_id: planId }).update({ context_config: JSON.stringify({ useEpic: true, epicLabel: 'base-epic' }) });
  await run({ issues: [10, 30] });
  const executionId = (await core.getEpicExecutionQueue(planId))?.executionId;
  const first = await queueRemainingFromUI();
  assert.equal(first.status, 200);
  assert.equal(first.body.alreadyQueued, false);
  const queue = await core.getEpicExecutionQueue(planId);
  assert.equal(queue?.executionId, executionId);
  assert.deepEqual(queue?.issues, [10, 30, 20, 40]);
  assert.equal(issueLabels.get(20)?.includes('AI'), false);
  const second = await queueRemainingFromUI();
  assert.equal(second.status, 200);
  assert.equal(second.body.alreadyQueued, true);
  assert.deepEqual((await core.getEpicExecutionQueue(planId))?.issues, [10, 30, 20, 40]);
});

test('Queue Remaining defers to the row start when nothing runs, and needs auto-merge outside an epic', async () => {
  await database('task_drafts').where({ draft_id: planId }).update({ context_config: JSON.stringify({ autoMerge: true }) });
  assert.equal((await queueRemainingFromUI()).status, 409);
  await database('plan_issues').where({ draft_id: planId, issue_number: 10 }).update({ status: 'processing' });
  assert.equal((await queueRemainingFromUI({ autoMerge: false })).status, 409);
  assert.equal(await core.getEpicExecutionQueue(planId), null);
  await database('plan_issues').where({ draft_id: planId }).update(models[0]);
  const queued = await queueRemainingFromUI();
  assert.equal(queued.status, 200);
  const queue = await core.getEpicExecutionQueue(planId);
  assert.equal(queue?.useEpic, false);
  assert.deepEqual(issueLabels.get(30)?.sort(), ['auto-merge', 'llm-model']);
});
