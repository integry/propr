import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ToolDeps } from '../mcp/tools.js';
import type { McpPrincipal } from '../mcp/policy.js';

test('an omitted ultrafixGoal tracks the instance ultrafix_rating_goal on every MCP tool that declares it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-ultrafix-goal-'));
  process.env.DATA_DIR = root; process.env.DB_FILENAME = path.join(root, 'core.sqlite'); process.env.NODE_ENV = 'test';
  const core = await import('@propr/core');
  try {
    await core.runMigrations();
    const { McpStore } = await import('../mcp/store.js');
    const { McpOAuthProvider } = await import('../mcp/oauth.js');
    const { McpPolicy } = await import('../mcp/policy.js');
    const { createToolCatalog, executeTool } = await import('../mcp/tools.js');
    const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'fixture-instance', encryptionKey: randomBytes(32) };
    const policy = new McpPolicy(new McpOAuthProvider(new McpStore(core.db, config.encryptionKey), config), config);
    policy.repository = async () => {};
    let issue = 40;
    const deps = { db: core.db, policy, taskQueue: {}, redisClient: {}, runtimeBuildQueue: {},
      taskSubmissionServices: {
        authorize: async () => ({ id: 'repo', name: 'owner/repo', enabled: true, baseBranch: 'main' }),
        routing: async () => ({ agentAlias: 'agent', model: 'model', routingLabel: 'llm-model' }),
        getOctokit: async () => ({ request: async (route: string) => route === 'POST /repos/{owner}/{repo}/issues'
          ? { data: { number: ++issue, html_url: `https://github.com/owner/repo/issues/${issue}` } } : { data: [] } }) as never,
        processingLabels: async () => ['AI'],
        enqueue: async () => {},
      } } as unknown as ToolDeps;
    const catalog = createToolCatalog(deps);
    const tool = (name: string) => catalog.find(item => item.name === name)!;
    const principal = { user: { id: 'alice', username: 'alice' }, authorization: { permissions: [] },
      grant: { id: 'grant-1', repositories: ['owner/repo'] }, scopes: ['read', 'execute', 'review'] } as unknown as McpPrincipal;

    // No literal default is declared anywhere: the schema leaves the goal unset and says where it comes from.
    for (const [name, field] of [['create_task', 'ultrafixGoal'], ['implement_plan', 'ultrafixGoal'], ['start_ultrafix', 'ultrafixGoal'], ['run_ultrafix', 'goal']] as const) {
      const shape = tool(name).schema.shape[field];
      assert.equal(shape.isOptional(), true, `${name}.${field} must be optional`);
      assert.equal(shape.parse(undefined), undefined, `${name}.${field} must not default to a literal`);
      assert.match(shape.description ?? '', /instance ultrafix rating goal/);
    }
    for (const name of ['create_task', 'implement_plan']) assert.match(tool(name).description, /omitted ultrafixGoal defaults to the instance ultrafix rating goal/);
    assert.match(tool('start_ultrafix').description, /instance ultrafix rating goal/);

    const storedGoal = async (key: string) => {
      const receipt = (await executeTool(tool('create_task'), { repository: 'owner/repo', instruction: 'Fix it', runUltrafix: true, idempotencyKey: key }, principal, deps)).data as { state: string; result: { submissionId: string } };
      assert.equal(receipt.state, 'queued');
      const row = await core.db('task_submissions').where({ id: receipt.result.submissionId }).first('payload');
      return JSON.parse(row.payload).ultrafixGoal;
    };
    await core.saveUltrafixRatingGoal(8);
    assert.equal(await storedGoal('goal-default-eight'), 8);
    await core.saveUltrafixRatingGoal(5);
    assert.equal(await storedGoal('goal-default-five'), 5);
    const explicit = (await executeTool(tool('create_task'), { repository: 'owner/repo', instruction: 'Fix it', runUltrafix: true, ultrafixGoal: 10, idempotencyKey: 'goal-explicit' }, principal, deps)).data as { result: { submissionId: string } };
    assert.equal(JSON.parse((await core.db('task_submissions').where({ id: explicit.result.submissionId }).first('payload')).payload).ultrafixGoal, 10);
  } finally {
    await core.closeConnection();
    await rm(root, { recursive: true, force: true });
  }
});
