import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import type { Request, Response } from 'express';
import { closeConnection, type AgentRunAdmissionSnapshot } from '@propr/core';
import { configureDemoMode, resetConfiguredDemoMode } from '../demoMode.js';
import { McpError } from '../mcp/config.js';
import { addAdmissionTools, AGENT_RUN_ADMISSION_TOOL } from '../mcp/toolsAdmission.js';
import type { McpPrincipal } from '../mcp/policy.js';
import type { McpTool, ToolDeps } from '../mcp/tools.js';
import { AgentRunAdmissionReport } from '../openapi/schemasAdmission.js';
import { createAgentRunAdmissionRoutes } from '../routes/agentRunAdmissionRoutes.js';

after(() => closeConnection());
afterEach(() => resetConfiguredDemoMode());

const counts = (running: number) => ({ reserved: 0, running, draining: 0, recovering: 0, total: running });
const noWait = () => ({ total: 0, globalLimit: 0, agentCeiling: 0, recovering: 0, starting: 0 });

function enabledSnapshot(): AgentRunAdmissionSnapshot {
  return {
    enabled: true, asOf: '2026-11-13T10:00:00.000Z', agentCeilingsConfigured: true,
    global: {
      limit: 2, limitSource: 'PROPR_AGENT_RUN_LIMIT', generation: 0, nestedLimit: 4, nestedLimitSource: 'default',
      inUse: 2, holders: counts(2), unattributedHolders: 0, nested: { total: 0, chargedUnderParent: 0, countedAgainstOtherAgent: 0 },
      waiting: { total: 1, globalLimit: 0, agentCeiling: 1, recovering: 0, starting: 0 }, deferred: 1,
    },
    agents: [{
      alias: 'local', ceiling: 1, inUse: 1, holders: counts(1), nested: { total: 0, chargedUnderParent: 0, countedAgainstCeiling: 0 },
      waiting: { total: 1, globalLimit: 0, agentCeiling: 1, recovering: 0, starting: 0 }, deferred: 1,
      tasks: [
        { taskId: 'public-task', alias: 'local', state: 'running', nested: false },
        { taskId: 'private-task', alias: 'local', state: 'waiting', waitReason: 'alias_limit', nested: false },
        { taskId: 'unknown-task', alias: 'local', state: 'waiting', waitReason: 'starting', nested: false },
      ],
    }, {
      alias: 'cloud', ceiling: null, inUse: 1, holders: counts(1), nested: { total: 0, chargedUnderParent: 0, countedAgainstCeiling: 0 },
      waiting: noWait(), deferred: 0, tasks: [],
    }],
    repositoryWorkflowSlots: [
      { repository: 'acme/public', inUse: 1, limit: 2, waiting: 0 },
      { repository: 'acme/private', inUse: 1, limit: 1, waiting: 1 },
    ],
  };
}

const TASKS = [{ task_id: 'public-task', repository: 'acme/public' }, { task_id: 'private-task', repository: 'acme/private' }];
const db = ((table: string) => {
  assert.equal(table, 'tasks');
  return { whereIn: (_column: string, ids: string[]) => ({ select: async () => TASKS.filter(row => ids.includes(row.task_id)) }) };
}) as never;
const taskQueue = { getActiveCount: async () => 3 } as never;
const redisClient = {
  sMembers: async () => ['worker-a', 'worker-b'],
  hGetAll: async () => ({ 'worker-a': '2', 'worker-b': '3' }),
} as never;

function recorder() {
  const record: { status: number; body?: unknown; headers: Record<string, string> } = { status: 200, headers: {} };
  const response = {
    setHeader(name: string, value: string) { record.headers[name.toLowerCase()] = value; },
    status(code: number) { record.status = code; return response; },
    json(body: unknown) { record.body = body; return response; },
  } as unknown as Response;
  return { record, response };
}
const member = { authorization: { role: 'member', permissions: [], source: 'local' } } as unknown as Request;
const demo = { authorization: { role: 'member', permissions: [], source: 'demo' } } as unknown as Request;
type Report = ReturnType<typeof AgentRunAdmissionReport.parse>;

test('REST returns the report with task IDs of existing tasks and every limit labelled', async () => {
  const routes = createAgentRunAdmissionRoutes({ db, taskQueue, redisClient, readSnapshot: async () => enabledSnapshot() });
  const { record, response } = recorder();
  await routes.getAgentRunAdmission(member, response);
  assert.equal(record.status, 200);
  assert.equal(record.headers['cache-control'], 'no-store');
  const body = AgentRunAdmissionReport.parse(record.body) as Report;
  assert.deepEqual(body.agents[0].tasks.map(task => task.taskId), ['public-task', 'private-task'], 'an unknown task ID is never echoed');
  assert.equal(body.agents[0].waiting.agentCeiling, 1);
  assert.deepEqual({ inUse: body.queueWorkers.inUse, total: body.queueWorkers.total, workers: body.queueWorkers.workers }, { inUse: 3, total: 5, workers: 2 });
  assert.match(body.queueWorkers.label, /^Queue worker concurrency/);
  assert.match(body.repositoryWorkflowSlots.label, /^Repository workflow slots/);
  assert.equal(body.repositoryWorkflowSlots.repositories.length, 2);
  assert.match(body.subscriptionUsage, /get_provider_usage/);
});

test('REST gives the read-only demo viewer counts only', async () => {
  configureDemoMode(true);
  const routes = createAgentRunAdmissionRoutes({ db, taskQueue, redisClient, readSnapshot: async () => enabledSnapshot() });
  const { record, response } = recorder();
  await routes.getAgentRunAdmission(demo, response);
  const body = record.body as Report;
  assert.deepEqual(body.agents.flatMap(agent => agent.tasks), []);
  assert.deepEqual(body.repositoryWorkflowSlots.repositories, []);
  assert.equal(body.admission.global!.inUse, 2, 'counts cover everything');
});

test('REST with admission off says so and returns the remaining limits', async () => {
  const routes = createAgentRunAdmissionRoutes({
    db, taskQueue, redisClient,
    readSnapshot: async () => ({ enabled: false, asOf: '2026-11-13T10:00:00.000Z', agentCeilingsConfigured: false, agents: [], repositoryWorkflowSlots: [{ repository: 'acme/public', inUse: 1, limit: 1, waiting: 0 }] }),
  });
  const { record, response } = recorder();
  await routes.getAgentRunAdmission(member, response);
  assert.equal(record.status, 200);
  const body = AgentRunAdmissionReport.parse(record.body) as Report;
  assert.deepEqual(body.admission, { enabled: false, agentCeilingsConfigured: false, global: null });
  assert.equal(body.queueWorkers.total, 5);
  assert.equal(body.repositoryWorkflowSlots.repositories.length, 1);
});

test('REST failures use the error envelope without internal detail', async () => {
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const routes = createAgentRunAdmissionRoutes({ db, taskQueue, redisClient, readSnapshot: async () => { throw new Error('redis://secret@host'); } });
    const { record, response } = recorder();
    await routes.getAgentRunAdmission(member, response);
    assert.equal(record.status, 500);
    assert.deepEqual(record.body, { code: 'AGENT_RUN_ADMISSION_UNAVAILABLE', message: 'Agent-run admission state could not be read.' });
  } finally { console.error = originalError; }
});

test('MCP shows task IDs and repositories only within the grant the policy allows', async () => {
  const tools: McpTool[] = [];
  const policy = {
    repository: async (_principal: McpPrincipal, repository: string) => {
      if (repository.toLowerCase() === 'acme/private') throw new McpError('REPOSITORY_FORBIDDEN', 'No access.', 403);
    },
  };
  addAdmissionTools(tools, { db, taskQueue, redisClient, policy, agentRunAdmissionSnapshot: async () => enabledSnapshot() } as unknown as ToolDeps);
  const tool = tools.find(candidate => candidate.name === AGENT_RUN_ADMISSION_TOOL)!;
  assert.equal(tool.scope, 'read');
  assert.equal(tool.readOnly, true);
  const principal = { user: { id: 'u' }, grant: { repositories: ['acme/public', 'acme/private'] } } as unknown as McpPrincipal;
  const result = await tool.run({ principal, args: {} } as never);
  const body = AgentRunAdmissionReport.parse(result.data) as Report;
  assert.deepEqual(body.agents[0].tasks.map(task => task.taskId), ['public-task'], 'a task in a repository the policy refuses stays hidden');
  assert.deepEqual(body.repositoryWorkflowSlots.repositories.map(slot => slot.repository), ['acme/public']);
  const narrow = { user: { id: 'u' }, grant: { repositories: [] } } as unknown as McpPrincipal;
  const hidden = (await tool.run({ principal: narrow, args: {} } as never)).data as Report;
  assert.deepEqual(hidden.agents.flatMap(agent => agent.tasks), []);
  assert.equal(hidden.admission.global!.waiting.agentCeiling, 1);
});
