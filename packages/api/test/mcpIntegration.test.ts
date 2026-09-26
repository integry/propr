import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { up as initial } from '../../core/src/db/migrations/20251216000000_initial_sqlite_schema.js';
import { up as planIssues } from '../../core/src/db/migrations/20260120000000_add_plan_issues.js';
import { up as planIssueTasks } from '../../core/src/db/migrations/20260121000000_add_task_id_to_plan_issues.js';
import { up as taskPullRequests } from '../../core/src/db/migrations/20260216000000_add_pr_number_to_tasks.js';
import { up as mcpMigration } from '../../core/src/db/migrations/20260910220000_add_mcp.js';
import { McpStore } from '../mcp/store.js';
import { McpOAuthProvider } from '../mcp/oauth.js';
import { McpError } from '../mcp/config.js';
import { McpPolicy, type McpPrincipal } from '../mcp/policy.js';
import { buildMcpServer } from '../mcp/server.js';
import { createToolCatalog, executeTool, type ToolDeps } from '../mcp/tools.js';

after(async () => closeConnection());

test('both official SDK protocol eras execute real draft/revision/publication/task transitions over the same HTTP endpoint', async () => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await initial(db); await planIssues(db); await planIssueTasks(db); await taskPullRequests(db); await mcpMigration(db);
  await db.schema.alterTable('task_drafts', table => table.boolean('paused').defaultTo(false));
  await db.schema.createTable('goals', table => {
    table.string('goal_id'); table.string('owner_id'); table.string('repository'); table.string('current_task_id');
    table.string('launch_strategy'); table.string('session_id'); table.timestamp('started_at'); table.timestamp('updated_at');
  });
  const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'test-instance', encryptionKey: randomBytes(32) };
  const oauth = new McpOAuthProvider(new McpStore(db, config.encryptionKey), config);
  const policy = new McpPolicy(oauth, config);
  let authorized = true;
  policy.repository = async (_principal, repository) => { if (!authorized || repository !== 'acme/repo') throw new McpError('REPOSITORY_FORBIDDEN', 'Denied', 403); };
  const githubIssues: Array<Record<string, unknown>> = [];
  const principal: McpPrincipal = { user: { id: '123', login: 'tester', username: 'tester', displayName: 'Test', email: null, avatarUrl: null, accessToken: 'fixture-github-credential' }, authorization: { role: 'member', permissions: [], source: 'local' },
    grant: { id: 'grant-1', ownerId: '123', clientId: 'client-1', clientName: 'Test', instanceId: config.instanceId, resource: config.resource, scopes: ['read', 'plan', 'publish', 'execute'], repositories: ['acme/repo'], createdAt: Date.now(), expiresAt: Date.now() + 60000, revoked: false, membershipSource: 'local' }, scopes: ['read', 'plan', 'publish', 'execute'],
    github: { request: async (route: string, payload: Record<string, unknown>) => {
      assert.equal(route, 'POST /repos/{owner}/{repo}/issues');
      githubIssues.push(payload); return { data: { number: githubIssues.length, title: payload.title, html_url: `https://github.com/acme/repo/issues/${githubIssues.length}` } };
    } } as never };
  const deps: ToolDeps = { db, policy, taskQueue: {} as never, redisClient: { get: async () => null } as never, runtimeBuildQueue: {} as never };
  const catalog = createToolCatalog(deps);
  const app = express(); app.use(express.json());
  const wire: Array<{ method: string; version?: string }> = [];
  app.all('/api/mcp', async (req, res) => {
    if (req.headers.authorization !== 'Bearer fixture-mcp-access') { res.status(401).end(); return; }
    wire.push({ method: req.body?.method, version: req.get('mcp-protocol-version') });
    res.set('Cache-Control', 'no-store');
    const handler = createMcpHandler(() => buildMcpServer(principal, deps, catalog), { legacy: 'stateless' });
    try { await toNodeHandler(handler)(req, res, req.body); } finally { await handler.close(); }
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`);
  try {
    for (const modern of [true, false]) {
      const client = modern ? new Client({ name: 'test-modern', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } }) : new LegacyClient({ name: 'test-legacy', version: '1' });
      const transport = modern ? new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer fixture-mcp-access' } } }) : new LegacyTransport(url, { requestInit: { headers: { Authorization: 'Bearer fixture-mcp-access' } } });
      await client.connect(transport as never);
      try {
        const inventory = await client.listTools();
        assert.ok(inventory.tools.some(tool => tool.name === 'create_plan'));
        assert.ok(inventory.tools.some(tool => tool.name === 'get_agent_activity'));
        assert.ok(!inventory.tools.some(tool => tool.name === 'merge_pull_request'));
        const resources = await client.listResources(); assert.equal(resources.resources.length, 6);
        const promptList = await client.listPrompts(); assert.equal(promptList.prompts.length, 8);
        const prompt = await client.getPrompt({ name: 'plan_change', arguments: { request: 'Improve reliability' } }); assert.equal(prompt.messages.length, 1);
        assert.equal((await db('task_drafts').count('* as count').first())!.count, modern ? 0 : 1);
        const call = async (name: string, args: Record<string, unknown>) => {
          const result = await client.callTool({ name, arguments: args });
          assert.notEqual(result.isError, true, JSON.stringify(result));
          return result.structuredContent as { data: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
        };
        const args = { repository: 'acme/repo', name: `Reliability ${modern}`, prompt: 'Improve reliability', idempotencyKey: `create-plan-${modern}`, plan: [{ title: 'Handle failures', body: 'Persist results', implementation: 'Use the existing state machine' }] };
        const create = await call('create_plan', args);
        assert.equal(create.data.state, 'completed');
        const id = create.data.result.planId;
        const duplicate = await call('create_plan', args); assert.equal(duplicate.data.operationId, create.data.operationId);
        const get = await call('get_plan', { repository: 'acme/repo', planId: id }); assert.equal(get.data.status, 'draft');
        const updated = await call('update_plan', { repository: 'acme/repo', planId: id, expectedRevision: 0, name: 'Reviewed reliability', idempotencyKey: `update-plan-${modern}` });
        assert.equal(updated.data.result.revision, 1);
        const stale = await call('update_plan', { repository: 'acme/repo', planId: id, expectedRevision: 0, name: 'Stale overwrite', idempotencyKey: `stale-plan-${modern}` });
        assert.equal(stale.data.state, 'failed'); assert.equal(stale.data.result.error.code, 'STALE_REVISION');
        const published = await call('publish_plan', { repository: 'acme/repo', planId: id, expectedRevision: 1, idempotencyKey: `publish-plan-${modern}` });
        assert.equal(published.data.state, 'completed');
        assert.equal((await db('task_drafts').where({ draft_id: id }).first()).status, 'executed');
        assert.equal((await db('plan_issues').where({ draft_id: id }).count('* as count').first())!.count, 1);
        const resource = await client.readResource({ uri: `propr://instances/test-instance/plans/${id}` }); assert.equal(resource.contents.length, 1);
        await db('tasks').insert({ task_id: `task-${modern}`, repository: 'acme/repo', task_type: 'issue', issue_number: 1 });
        await db('task_history').insert({ task_id: `task-${modern}`, state: 'processing' });
        let task = await call('get_task', { repository: 'acme/repo', taskId: `task-${modern}` }); assert.equal(task.data.latestEvent.state, 'processing');
        await db('task_history').insert({ task_id: `task-${modern}`, state: 'completed' });
        task = await call('get_task', { repository: 'acme/repo', taskId: `task-${modern}` }); assert.equal(task.data.latestEvent.state, 'completed');
        const activity = await call('get_agent_activity', { repository: 'acme/repo', taskId: `task-${modern}` });
        assert.deepEqual(activity.data.activity, []);
        assert.equal(activity.data.target.taskId, `task-${modern}`);
        authorized = false;
        const denied = await client.callTool({ name: 'get_plan', arguments: { repository: 'acme/repo', planId: id } }); assert.equal(denied.isError, true);
        authorized = true;
        const crossUser = { ...principal, user: { ...principal.user, id: '999' } };
        await assert.rejects(executeTool(catalog.find(tool => tool.name === 'get_plan')!, { repository: 'acme/repo', planId: id }, crossUser, deps), /Target not found/);
      } finally { await client.close(); }
    }
    assert.ok(wire.some(item => item.method === 'server/discover' && item.version === '2026-07-28'));
    assert.ok(wire.some(item => item.method === 'initialize'));
    assert.ok(wire.some(item => item.method === 'tools/call' && item.version === '2025-11-25'));
    assert.equal(githubIssues.length, 2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await db.destroy(); }
});

test('MCP task, goal and plan lists paginate in deterministic newest-first order', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });

  const repository = 'acme/repo';
  const newest = '2026-09-01 12:00:00';
  const middle = '2026-08-01 12:00:00';
  const oldest = '2026-06-01 12:00:00';
  await db('tasks').insert([
    { task_id: '1024', repository, task_type: 'issue', created_at: oldest },
    { task_id: '10149', repository, task_type: 'pr_comment', pr_number: 288, created_at: middle },
    { task_id: '10150', repository, task_type: 'review', pr_number: 188, created_at: newest },
    { task_id: '10151', repository, issue_number: 88, task_type: 'issue', model_name: 'gpt-5.6', pr_number: 188,
      initial_job_data: JSON.stringify({ title: 'Make task lists self-explanatory', subtitle: 'Expose bounded lifecycle context', agentAlias: 'codex' }), created_at: newest },
  ]);
  await db('task_history').insert({ task_id: '10151', state: 'processing', timestamp: '2026-09-01 12:00:02' });
  await db('task_history').insert({ task_id: '10151', state: 'claude_execution', timestamp: '2026-09-01 12:00:03' });
  await db('task_history').insert([
    ...['1024', '10149', '10150'].map(task_id => ({ task_id, state: 'completed', timestamp: newest })),
    { task_id: '10151', state: 'failed', timestamp: '2026-09-01 12:00:12', reason: 'Fixture agent stopped',
      metadata: JSON.stringify({ error: { message: 'Agent exited before completing the requested edits' } }) },
  ]);
  await db('goals').insert([
    { goal_id: 'goal-z-old', owner_id: '123', repository, current_task_id: 'goal-task-old', created_at: oldest, updated_at: oldest },
    { goal_id: 'goal-a-middle', owner_id: '123', repository, current_task_id: 'goal-task-middle', created_at: middle, updated_at: middle },
    { goal_id: 'goal-a-new', owner_id: '123', repository, current_task_id: 'goal-task-new-a', final_pr_number: 189,
      artifact_refs: JSON.stringify([{ type: 'pull_request', number: 189 }]), created_at: newest, updated_at: newest },
    { goal_id: 'goal-b-new', owner_id: '123', repository, title: 'Enrich MCP list results', objective: 'Make every MCP list result understandable without another fetch.',
      desired_state: 'running', result_state: 'completed', current_task_id: 'goal-task-new-b', agent_alias: 'codex', requested_model: 'gpt-5.6',
      effective_model: 'gpt-5.6-codex', final_pr_number: 288, artifact_refs: JSON.stringify([{ type: 'pull_request', number: 288, state: 'closed' }]),
      created_at: newest, updated_at: '2026-09-01 12:00:20', started_at: '2026-09-01 12:00:01', completed_at: '2026-09-01 12:00:20' },
  ].map(row => ({
    desired_state: 'running', owner_login: 'tester', objective: 'Fixture objective', launch_strategy: 'direct', initial_prompt: 'Fixture prompt',
    agent_id: 'codex', agent_alias: 'codex', agent_type: 'codex', requested_model: 'gpt-5.6', ...row,
  })));
  await db('task_drafts').insert([
    { draft_id: 'plan-z-old', user_id: '123', repository, created_at: oldest, updated_at: oldest },
    { draft_id: 'plan-a-middle', user_id: '123', repository, created_at: middle, updated_at: middle },
    { draft_id: 'plan-a-new', user_id: '123', repository, status: 'failed',
      generation_trace: JSON.stringify({}), refinement_result: JSON.stringify({ error: 'Refinement failed' }),
      created_at: newest, updated_at: newest },
    { draft_id: 'plan-b-new', user_id: '123', repository, name: 'MCP list summaries', initial_prompt: 'Add compact summaries to list tools.',
      context_config: JSON.stringify({ generationModel: 'codex:gpt-5.6' }), status: 'merged', mcp_revision: 3, paused: false,
      created_at: newest, updated_at: '2026-09-01 12:00:30' },
  ].map(row => ({ mcp_revision: 0, paused: false, ...row })));
  await db('plan_issues').insert({ draft_id: 'plan-b-new', repository, issue_number: 88, task_id: '10151', pr_number: 188, status: 'closed', agent_alias: 'codex', model_name: 'gpt-5.6' });
  await db('plan_issues').insert([
    { draft_id: 'plan-a-middle', repository, issue_number: 90, task_id: '1024', pr_number: 999, status: 'merged', agent_alias: 'z-old', model_name: 'z-old' },
    { draft_id: 'plan-a-middle', repository, issue_number: 91, task_id: '1024', pr_number: 288, status: 'closed', agent_alias: 'a-latest', model_name: 'a-latest' },
    { draft_id: 'plan-a-middle', repository, issue_number: 92, pr_number: 289, status: 'under_review' },
  ]);
  await db('notification_pull_request_state').insert([
    { repository, pr_number: 288, merged_at: '2026-09-01T12:00:21.000Z' },
    { repository, pr_number: 289, merged_at: '2026-09-01T12:00:21.000Z' },
    { repository: 'other/repo', pr_number: 188, merged_at: '2026-09-01T12:00:21.000Z' },
  ]);
  await db('repo_todo_categories').insert({ category_id: 'category-1', user_id: '123', repository, name: 'API', order_index: 0 });
  await db('repo_todos').insert({ todo_id: 'todo-1', user_id: '123', repository, category_id: 'category-1', content: 'Keep list payloads compact',
    order_index: 0, is_completed: false, linked_draft_id: 'plan-b-new', created_at: newest, updated_at: newest });

  const deps: ToolDeps = { db, policy: {} as McpPolicy, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never };
  const catalog = createToolCatalog(deps);
  const principal = { user: { id: '123' } } as McpPrincipal;
  const page = async (name: string, offset: number) => {
    const tool = catalog.find(candidate => candidate.name === name)!;
    const result = await tool.run({ principal, args: { repository, offset, limit: 2 } });
    assert.equal(result.status, 200);
    return result.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  const queries: Array<{ sql: string; bindings: readonly Knex.RawBinding[] }> = [];
  const captureQuery = (query: { sql: string; bindings: readonly Knex.RawBinding[] }) => queries.push(query);
  db.on('query', captureQuery);
  const taskPageOne = await page('list_tasks', 0);
  db.off('query', captureQuery);
  const taskQuery = queries.find(query => query.sql.includes('latest_history'))!;
  const queryPlan = await db.raw(`EXPLAIN QUERY PLAN ${taskQuery.sql}`, taskQuery.bindings);
  const accessPlan = queryPlan.map((row: { detail: string }) => row.detail).join('\n');
  assert.doesNotMatch(accessPlan, /SCAN task_history|MATERIALIZE latest_history/);
  // SQLite may choose a single-column or composite index, with or without covering it.
  // Require task-ID lookups without tying the regression to a particular query planner.
  assert.match(accessPlan, /SEARCH task_history USING (?:COVERING )?INDEX \S+ \(task_id=\?\)/);
  assert.match(accessPlan, /SEARCH plan_issues USING (?:COVERING )?INDEX \S+ \(task_id=\?\)/);
  const taskPageTwo = await page('list_tasks', taskPageOne.nextOffset);
  assert.deepEqual(taskPageOne.tasks.map((task: { task_id: string }) => task.task_id), ['10151', '10150']);
  assert.deepEqual(taskPageTwo.tasks.map((task: { task_id: string }) => task.task_id), ['10149', '1024']);
  assert.equal(taskPageOne.tasks[1].pr_number, 188);
  assert.equal(taskPageOne.tasks[1].pr_state, null);
  assert.equal(taskPageTwo.tasks[0].pr_state, 'merged');
  assert.equal(taskPageTwo.tasks[1].pr_number, 288);
  assert.equal(taskPageTwo.tasks[1].agent_alias, 'a-latest');
  assert.equal(taskPageTwo.tasks[1].model_name, 'a-latest');
  await db('notification_pull_request_state').where({ repository, pr_number: 288 }).delete();
  assert.equal((await page('list_tasks', 2)).tasks[1].pr_state, 'closed');
  await db('notification_pull_request_state').insert({ repository, pr_number: 288, merged_at: '2026-09-01T12:00:21.000Z' });
  await db('tasks').where({ task_id: '1024' }).update({ pr_number: 188 });
  const mismatchedTask = (await page('list_tasks', 2)).tasks[1];
  assert.equal(mismatchedTask.pr_number, 188);
  assert.equal(mismatchedTask.pr_state, null);
  await db('notification_pull_request_state').insert({ repository, pr_number: 188, merged_at: '2026-09-01T12:00:21.000Z' });
  assert.equal((await page('list_tasks', 2)).tasks[1].pr_state, 'merged');
  await db('notification_pull_request_state').where({ repository, pr_number: 188 }).delete();
  assert.deepEqual(taskPageOne.tasks[0], {
    task_id: '10151', repository, issue_number: 88, task_type: 'issue', title: 'Make task lists self-explanatory',
    summary: 'Expose bounded lifecycle context', state: 'failed', agent_alias: 'codex', model_name: 'gpt-5.6',
    pr_number: 188, pr_state: 'closed', created_at: newest, updated_at: '2026-09-01 12:00:12',
    started_at: '2026-09-01 12:00:02', completed_at: '2026-09-01 12:00:12', elapsed_ms: 10_000,
    failure_reason: 'Agent exited before completing the requested edits',
  });

  const goalPageOne = await page('list_goals', 0);
  const goalPageTwo = await page('list_goals', goalPageOne.nextOffset);
  assert.deepEqual(goalPageOne.goals.map((goal: { goal_id: string }) => goal.goal_id), ['goal-b-new', 'goal-a-new']);
  assert.deepEqual(goalPageTwo.goals.map((goal: { goal_id: string }) => goal.goal_id), ['goal-a-middle', 'goal-z-old']);
  assert.equal(goalPageOne.goals[0].summary, 'Make every MCP list result understandable without another fetch.');
  assert.equal(goalPageOne.goals[0].agent_alias, 'codex');
  assert.equal(goalPageOne.goals[0].model_name, 'gpt-5.6-codex');
  assert.equal(goalPageOne.goals[0].pr_state, 'merged');
  assert.equal(goalPageOne.goals[1].pr_number, 189);
  assert.equal(goalPageOne.goals[1].pr_state, null);
  assert.equal(goalPageOne.goals[0].elapsed_ms, 19_000);

  const planPageOne = await page('list_plans', 0);
  const planPageTwo = await page('list_plans', planPageOne.nextOffset);
  assert.deepEqual(planPageOne.plans.map((plan: { draft_id: string }) => plan.draft_id), ['plan-b-new', 'plan-a-new']);
  assert.deepEqual(planPageTwo.plans.map((plan: { draft_id: string }) => plan.draft_id), ['plan-a-middle', 'plan-z-old']);
  assert.deepEqual(planPageOne.plans[0].issue_counts, { total: 1, pending: 0, active: 0, merged: 0, closed: 1 });
  assert.deepEqual(planPageOne.plans[0].agent_models, [{ agent_alias: 'codex', model_name: 'gpt-5.6' }]);
  assert.deepEqual(planPageOne.plans[0].pull_requests, [{ number: 188, state: 'closed' }]);

  assert.equal(planPageOne.plans[0].generation_model, 'codex:gpt-5.6');
  assert.equal(planPageOne.plans[1].failure_reason, 'Refinement failed');
  for (const plan of planPageOne.plans) {
    assert.equal(plan.completed_at, null);
    assert.equal(plan.elapsed_ms, null);
  }
  const renameResult = await catalog.find(tool => tool.name === 'update_plan')!.run({
    principal, args: { repository, planId: 'plan-a-new', expectedRevision: 0, name: 'Renamed failed plan' },
  });
  assert.equal(renameResult.status, 200);
  const renamedPlan = (await page('list_plans', 0)).plans.find((plan: { draft_id: string }) => plan.draft_id === 'plan-a-new');
  assert.equal(renamedPlan.title, 'Renamed failed plan');
  assert.equal(renamedPlan.status, 'failed');
  assert.notEqual(renamedPlan.updated_at, planPageOne.plans[1].updated_at);
  assert.equal(renamedPlan.completed_at, null);
  assert.equal(renamedPlan.elapsed_ms, null);
  assert.deepEqual(planPageTwo.plans[0].pull_requests, [
    { number: 999, state: 'merged' }, { number: 288, state: 'merged' }, { number: 289, state: 'merged' },
  ]);

  const todos = await page('list_todos', 0);
  assert.deepEqual(todos.items[0], {
    todo_id: 'todo-1', repository, title: 'Keep list payloads compact', summary: null,
    is_completed: false, category: { id: 'category-1', name: 'API' },
    linked_plan: { id: 'plan-b-new', title: 'MCP list summaries', status: 'merged' },
    order_index: 0, created_at: newest, updated_at: newest,
  });

});
