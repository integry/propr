import assert from 'node:assert/strict';
import { after, test, mock } from 'node:test';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import knex from 'knex';
import express from 'express';
import type { RedisClientType } from 'redis';
import type { McpPrincipal } from '../mcp/policy.js';
import type { ToolDeps, McpTool } from '../mcp/tools.js';
import { withLiveOutputReads } from './liveOutputRedisFake.js';

const repository = 'acme/repo';
const forbiddenRepository = 'acme/forbidden';
const ownerId = '123';
const strangerId = '999';
const goalId = '11111111-1111-4111-8111-111111111111';
const strangerGoalId = '77777777-7777-4777-8777-777777777777';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const goalDefaults = {
  owner_id: ownerId, owner_login: 'tester', repository, objective: 'Fixture objective', launch_strategy: 'direct',
  initial_prompt: 'Fixture prompt', agent_id: 'codex', agent_alias: 'codex', agent_type: 'codex',
  requested_model: 'fixture-model', desired_state: 'running', artifact_refs: '[]', artifact_stats: '{}',
  run_generation: 1, run_claim: 'claim-1', session_id: 'thread-1', paused_ms: 0, resume_requested: false,
  control_generation: 0, control_ack_generation: 0, checkpoint_count: 0, title: 'Wait fixture',
  claimed_at: '2026-10-04 10:00:00', started_at: '2026-10-04 10:00:00',
  created_at: '2026-10-04 10:00:00', updated_at: '2026-10-04 10:00:00',
};

after(async () => {
  const { closeConnection } = await import('@propr/core');
  await closeConnection();
});

test('wait_goal and GET /api/goals/:goalId/wait expose the bounded wait contract with authorization and cleanup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'propr-mcp-goal-wait-'));
  process.env.DATA_DIR = root;
  process.env.DB_FILENAME = path.join(root, 'propr.sqlite');
  process.env.NODE_ENV = 'test';
  const core = await import('@propr/core');
  const configured = [repository, forbiddenRepository].map(name => ({ name, enabled: true, baseBranch: 'main' }));
  const boundary = await mock.module('@propr/core', { namedExports: { ...core, loadMonitoredReposRaw: async () => configured } });
  const { McpError } = await import('../mcp/config.js');
  const { McpPolicy } = await import('../mcp/policy.js');
  const { McpStore } = await import('../mcp/store.js');
  const { McpOAuthProvider } = await import('../mcp/oauth.js');
  const { createToolCatalog, executeTool } = await import('../mcp/tools.js');
  const { createGoalRoutes } = await import('../routes/goalRoutes.js');
  const { activeGoalWaiterCount, notifyGoalWaiters } = await import('../services/goalWait.js');

  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  const redisClient = withLiveOutputReads({ get: async () => null }) as unknown as RedisClientType;
  try {
    await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
    await db('goals').insert([
      { ...goalDefaults, goal_id: goalId, current_task_id: 'goal-task-wait' },
      { ...goalDefaults, goal_id: strangerGoalId, owner_id: strangerId, current_task_id: 'goal-task-stranger' },
    ]);
    const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'wait-instance', encryptionKey: randomBytes(32) };
    const store = new McpStore(db, config.encryptionKey);
    const policy = new McpPolicy(new McpOAuthProvider(store, config), config);
    policy.repository = async (_principal, target) => {
      if (target === forbiddenRepository) throw new McpError('REPOSITORY_FORBIDDEN', 'Denied', 403);
    };
    const goalServices = { loadVisualPreviewSettings: async () => ({ enabled: false, types: ['image'] }) };
    const deps: ToolDeps = { db, policy, redisClient, taskQueue: {} as never, runtimeBuildQueue: {} as never, goalServices: goalServices as never };
    const catalog = createToolCatalog(deps);
    const grant = { id: 'wait-grant', ownerId, clientId: 'client', clientName: 'Wait', instanceId: config.instanceId,
      resource: config.resource, scopes: ['read'], repositories: [repository, forbiddenRepository],
      createdAt: Date.now(), expiresAt: Date.now() + 600_000, revoked: false, membershipSource: 'local' };
    await store.put('grant', grant.id, grant);
    const principal = { user: { id: ownerId, username: 'tester', login: 'tester' },
      authorization: { role: 'member', source: 'local', permissions: [] }, scopes: ['read'], grant } as unknown as McpPrincipal;
    const tool = (name: string): McpTool => catalog.find(candidate => candidate.name === name)!;
    const call = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
      await executeTool(tool(name), args, principal, deps, signal);

    assert.equal(tool('wait_goal').readOnly, true);
    assert.equal(tool('wait_goal').scope, 'read');
    assert.match(tool('wait_goal').description, /timed_out/);

    // A timeout is an ordinary structured result, not an error or a goal failure.
    const timedOut = await call('wait_goal', { repository, goalId, until: 'completed', timeoutSeconds: 0.1 });
    assert.equal(timedOut.data.outcome, 'timed_out');
    assert.equal(timedOut.data.condition, 'completed');
    assert.equal(timedOut.data.goal.lifecycleState, 'running');
    assert.equal(timedOut.data.goal.terminal, false);
    assert.match(timedOut.data.cursor, /^gwc1\./);
    assert.match(timedOut.summary, /timed out/);

    // Requesting a pause through the goal row does not satisfy a confirmed-pause wait; confirmation does.
    await db('goals').where({ goal_id: goalId }).update({ desired_state: 'paused', paused_at: '2026-10-04 10:01:00' });
    const pausing = await call('wait_goal', { repository, goalId, until: 'paused', afterCursor: timedOut.data.cursor, timeoutSeconds: 0.1 });
    assert.equal(pausing.data.outcome, 'timed_out');
    assert.equal(pausing.data.goal.lifecycleState, 'pausing');
    const pending = call('wait_goal', { repository, goalId, until: 'paused', afterCursor: pausing.data.cursor, timeoutSeconds: 5 });
    await new Promise(resolve => setTimeout(resolve, 30));
    await db('goals').where({ goal_id: goalId }).update({ pause_confirmed_at: '2026-10-04 10:01:05' });
    notifyGoalWaiters(goalId);
    const paused = await pending;
    assert.equal(paused.data.outcome, 'matched');
    assert.equal(paused.data.event.state, 'paused');
    assert.equal(paused.data.event.previousState, 'pausing');
    assert.match(paused.summary, /matched/);

    // Immediate match without a cursor.
    const immediate = await call('wait_goal', { repository, goalId, until: 'paused' });
    assert.equal(immediate.data.matchedImmediately, true);

    // Cursor failures are explicit errors carrying recovery instructions.
    await assert.rejects(call('wait_goal', { repository, goalId, afterCursor: 'gwc1.bogus' }), (error: Json) => {
      assert.equal(error.code, 'CURSOR_INVALID');
      assert.match(String(error.details?.recovery), /Omit afterCursor/);
      return true;
    });
    const strangerCursor = Buffer.from(JSON.stringify({ g: strangerGoalId, s: 1 })).toString('base64url');
    await assert.rejects(call('wait_goal', { repository, goalId, afterCursor: `gwc1.${strangerCursor}` }), { code: 'CURSOR_WRONG_GOAL' });
    await assert.rejects(call('wait_goal', { repository, goalId, timeoutSeconds: 31 }), /timeoutSeconds|less than or equal|too_big|31/i);

    // Every request is owner- and repository-scoped.
    await assert.rejects(call('wait_goal', { repository, goalId: strangerGoalId, timeoutSeconds: 0 }), { code: 'NOT_FOUND' });
    await assert.rejects(call('wait_goal', { repository: forbiddenRepository, goalId, timeoutSeconds: 0 }), { code: 'REPOSITORY_FORBIDDEN' });

    // Revoking the grant ends an open wait before any further event is returned.
    const revocable = call('wait_goal', { repository, goalId, afterCursor: immediate.data.cursor, timeoutSeconds: 5 });
    await new Promise(resolve => setTimeout(resolve, 30));
    await store.put('grant', grant.id, { ...grant, revoked: true });
    await db('goals').where({ goal_id: goalId }).update({ resume_requested: true });
    notifyGoalWaiters(goalId);
    await assert.rejects(revocable, { code: 'ACCESS_REVOKED' });
    await store.put('grant', grant.id, grant);

    // MCP cancellation releases the waiter and leaves the goal running as it was.
    const before = await db('goals').where({ goal_id: goalId }).first();
    const controller = new AbortController();
    const cancelled = call('wait_goal', { repository, goalId, until: 'completed', timeoutSeconds: 30 }, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(activeGoalWaiterCount(goalId), 1);
    controller.abort();
    await assert.rejects(cancelled, { code: 'WAIT_ABORTED' });
    assert.equal(activeGoalWaiterCount(goalId), 0);
    assert.deepEqual(await db('goals').where({ goal_id: goalId }).first(), before);

    // A real HTTP disconnect through serveMcpRequest releases the waiter too.
    // The response-close listener and the SDK's per-request signal each abort
    // the open wait on their own; the wait only stays open if both are lost.
    const { serveMcpRequest } = await import('../mcp/server.js');
    const app = express();
    app.use(express.json());
    let served = 0;
    app.post('/api/mcp', async (req, res) => {
      try { await serveMcpRequest({ principal, deps, catalog }, req, res); }
      finally { served++; }
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const waitFor = async (condition: () => boolean, what: string) => {
      for (let attempt = 0; attempt < 200 && !condition(); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
      assert.ok(condition(), what);
    };
    const post = (args: Record<string, unknown>) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_goal', arguments: args } });
      const outgoing = httpRequest({
        host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/api/mcp', method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body) },
      });
      const response = new Promise<string>((resolve, reject) => {
        outgoing.once('error', reject);
        outgoing.once('response', incoming => {
          let text = '';
          incoming.setEncoding('utf8').on('data', chunk => { text += chunk; }).on('end', () => resolve(text)).on('error', reject);
        });
      });
      outgoing.end(body);
      return { outgoing, response };
    };
    try {
      // The same transport answers a wait that is allowed to finish.
      const answered = await post({ repository, goalId, until: 'completed', timeoutSeconds: 0 }).response;
      assert.match(answered, /timed_out/);
      await waitFor(() => served === 1, 'the answered request finished');
      assert.equal(activeGoalWaiterCount(goalId), 0);

      const open = post({ repository, goalId, until: 'completed', timeoutSeconds: 30 });
      open.response.catch(() => { /* the client hangs up below */ });
      await waitFor(() => activeGoalWaiterCount(goalId) === 1, 'the wait is open over HTTP');
      const disconnectedAt = Date.now();
      open.outgoing.destroy();
      await waitFor(() => activeGoalWaiterCount(goalId) === 0, 'the disconnect released the waiter');
      await waitFor(() => served === 2, 'the request handler returned after the disconnect');
      assert.ok(Date.now() - disconnectedAt < 5_000, 'released by the disconnect, not by the 30 second timeout');
      assert.deepEqual(await db('goals').where({ goal_id: goalId }).first(), before, 'a disconnect never changes the goal');
      // The slot was returned: the owner can wait again immediately.
      assert.equal((await call('wait_goal', { repository, goalId, until: 'completed', timeoutSeconds: 0 })).data.outcome, 'timed_out');
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }

    // Existing polling clients keep working unchanged.
    const polled = await call('get_goal', { repository, goalId });
    assert.equal(polled.data.goal.id, goalId);

    // The REST endpoint used by `propr goal wait` shares the contract.
    const routes = createGoalRoutes({ db, redisClient, taskQueue: {} as never, ...goalServices } as never);
    const respond = async (user: string, params: Record<string, string>, query: Record<string, string> = {}) => {
      let body: Json = {};
      let status = 200;
      const res = { writableEnded: false, status(code: number) { status = code; return res; }, json(value: Json) { body = value; res.writableEnded = true; return res; },
        once() { return res; }, off() { return res; } };
      await routes.wait({ user: { id: user }, query, params, get: () => undefined } as never, res as never);
      return { status, body };
    };
    const rest = await respond(ownerId, { goalId }, { until: 'terminal', timeoutSeconds: '0.1' });
    assert.equal(rest.status, 200);
    assert.equal(rest.body.outcome, 'timed_out');
    assert.equal((await respond(ownerId, { goalId }, { until: 'done' })).status, 400);
    assert.equal((await respond(ownerId, { goalId }, { timeoutSeconds: '45' })).status, 400);
    assert.equal((await respond(strangerId, { goalId }, { timeoutSeconds: '0' })).status, 404);
    const restCursor = await respond(ownerId, { goalId }, { afterCursor: 'gwc1.bogus' });
    assert.equal(restCursor.status, 400);
    assert.equal(restCursor.body.code, 'CURSOR_INVALID');
    assert.ok(restCursor.body.recovery);
    await db('goals').where({ goal_id: goalId }).update({ result_state: 'completed' });
    const completed = await respond(ownerId, { goalId }, { until: 'completed', afterCursor: rest.body.cursor, timeoutSeconds: '1' });
    assert.equal(completed.body.outcome, 'matched');
    assert.equal(completed.body.goal.goalCompleted, true);
    assert.deepEqual([completed.body.goal.lifecycleState, completed.body.goal.resultState, completed.body.goal.terminal], ['completed', 'completed', true]);

    // Resuming past the consumed completion returns unreachable at once on both
    // surfaces, even though the terminal state itself satisfies the condition.
    for (const until of ['completed', 'terminal']) {
      const startedAt = Date.now();
      const restAgain = await respond(ownerId, { goalId }, { until, afterCursor: completed.body.cursor, timeoutSeconds: '30' });
      assert.equal(restAgain.status, 200);
      assert.equal(restAgain.body.outcome, 'unreachable');
      assert.equal(restAgain.body.cursor, completed.body.cursor);
      const mcpAgain = await call('wait_goal', { repository, goalId, until, afterCursor: completed.body.cursor, timeoutSeconds: 30 });
      assert.equal(mcpAgain.data.outcome, 'unreachable');
      assert.equal(mcpAgain.data.goal.goalCompleted, true);
      assert.match(mcpAgain.summary, /can no longer match: the goal is completed and records no further events/);
      assert.ok(Date.now() - startedAt < 5_000, 'neither surface waited for the timeout');
    }
    // Without a cursor the completed state still matches immediately.
    assert.equal((await call('wait_goal', { repository, goalId, until: 'terminal', timeoutSeconds: 30 })).data.matchedImmediately, true);
    assert.equal(activeGoalWaiterCount(), 0);
  } finally {
    boundary.restore();
    await db.destroy();
  }
});
