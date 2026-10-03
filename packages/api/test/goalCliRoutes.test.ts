import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import { closeConnection, closeEventPublisher } from '@propr/core';
import { createGoalRoutes } from '../routes/goalRoutes.js';
import { withLiveOutputReads } from './liveOutputRedisFake.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ownerId = 'owner-1';
const strangerId = 'owner-2';
const repository = 'acme/repo';
const otherRepository = 'acme/other';

const goalDefaults = {
  owner_id: ownerId, owner_login: 'alice', objective: 'Fixture objective', launch_strategy: 'direct',
  initial_prompt: 'Fixture prompt', agent_id: 'codex', agent_alias: 'codex', agent_type: 'codex',
  requested_model: 'model-a', desired_state: 'running', artifact_refs: '[]', artifact_stats: '{}',
  run_generation: 0, paused_ms: 0, resume_requested: false, control_generation: 0, control_ack_generation: 0,
  checkpoint_count: 0,
};

function request(userId: string, params: Record<string, string> = {}, query: Record<string, string> = {}): Request {
  return { user: { id: userId, username: userId }, params, query, body: {}, method: 'GET', get: () => undefined } as unknown as Request;
}

async function call(handler: (req: Request, res: Response) => Promise<void>, req: Request): Promise<{ status: number; body: Json }> {
  const state: { status: number; body: Json } = { status: 200, body: {} };
  const res = {
    status(code: number) { state.status = code; return this; },
    json(body: Json) { state.body = body; return this; },
  } as unknown as Response;
  await handler(req, res);
  return state;
}

async function seed(db: Knex): Promise<void> {
  await db('goals').insert([
    { goal_id: 'goal-running', repository, current_task_id: 'task-running', final_pr_number: 41,
      checkpoint_interval_minutes: 15, checkpoint_count: 2, last_checkpoint_at: '2026-09-05 12:00:10',
      last_checkpoint_commit_sha: 'abc1234', effective_model: 'model-a',
      created_at: '2026-09-05 12:00:00', updated_at: '2026-09-05 12:00:30', started_at: '2026-09-05 12:00:00' },
    { goal_id: 'goal-paused', repository, current_task_id: 'task-paused', desired_state: 'paused',
      pause_confirmed_at: '2026-09-04 12:00:10', created_at: '2026-09-04 12:00:00', updated_at: '2026-09-06 12:00:00' },
    { goal_id: 'goal-completed', repository: otherRepository, current_task_id: 'task-completed', result_state: 'completed',
      created_at: '2026-09-03 12:00:00', updated_at: '2026-09-03 12:00:30', completed_at: '2026-09-03 12:00:30' },
    { goal_id: 'goal-failed', repository, current_task_id: 'task-failed', result_state: 'failed',
      failure_reason: 'Provider exited', created_at: '2026-09-02 12:00:00', updated_at: '2026-09-02 12:00:30' },
    { goal_id: 'goal-stranger', owner_id: strangerId, repository, current_task_id: 'task-stranger',
      created_at: '2026-09-07 12:00:00', updated_at: '2026-09-07 12:00:00' },
  ].map(row => ({ ...goalDefaults, ...row })));
  await db('tasks').insert([
    { task_id: 'task-running', repository, task_type: 'goal', correlation_id: 'goal-running', created_at: '2026-09-05 12:00:00' },
    { task_id: 'child-failed', repository, task_type: 'issue', correlation_id: 'goal-running', created_at: '2026-09-05 12:02:00' },
    { task_id: 'child-merged', repository, task_type: 'issue', correlation_id: 'goal-running', pr_number: 77, created_at: '2026-09-05 12:01:00' },
  ]);
  await db('task_history').insert([
    { task_id: 'task-running', state: 'processing', timestamp: '2026-09-05 12:00:01' },
    { task_id: 'child-merged', state: 'completed', timestamp: '2026-09-05 12:01:41' },
    { task_id: 'child-failed', state: 'failed', timestamp: '2026-09-05 12:02:21', reason: 'Fixture agent stopped' },
  ]);
  await db('notification_pull_request_state').insert({ repository, pr_number: 77, merged_at: '2026-09-05T12:01:45.000Z' });
  await db('goal_inputs').insert([1, 2, 3].map(index => ({
    input_id: `input-${index}`, goal_id: 'goal-running', owner_id: ownerId, idempotency_key: `seed-input-${index}`,
    operation: 'goal.input', payload_hash: `hash-${index}`, kind: 'input', message: `Correction ${index}`,
    display_message: `Correction ${index}`, attachment_count: 0, state: index === 1 ? 'delivered' : 'pending',
    created_at: `2026-09-05 12:00:0${index}`, delivered_at: index === 1 ? '2026-09-05 12:00:05' : null,
  })));
}

test('goal REST reads expose paginated lists, the shared inspect detail and input history to their owner only', async () => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
    await seed(db);
    const routes = createGoalRoutes({
      db,
      taskQueue: {} as never,
      redisClient: withLiveOutputReads({ get: async () => null }) as never,
      previewReader: { project: async (rows: unknown[]) => rows.map(() => ({ previews: [] })) } as never,
    });

    // The unpaginated dashboard read keeps its recency order and shape.
    const dashboard = await call(routes.list, request(ownerId));
    assert.equal(dashboard.status, 200);
    assert.deepEqual(dashboard.body.goals.map((goal: Json) => goal.id),
      ['goal-paused', 'goal-running', 'goal-completed', 'goal-failed']);
    assert.equal(dashboard.body.nextOffset, null);

    // Explicit pages walk the immutable creation order without gaps or repeats.
    const first = await call(routes.list, request(ownerId, {}, { limit: '2' }));
    assert.deepEqual(first.body.goals.map((goal: Json) => goal.id), ['goal-running', 'goal-paused']);
    assert.equal(first.body.nextOffset, 2);
    const second = await call(routes.list, request(ownerId, {}, { limit: '2', offset: '2' }));
    assert.deepEqual(second.body.goals.map((goal: Json) => goal.id), ['goal-completed', 'goal-failed']);
    assert.equal(second.body.nextOffset, 2 + 2);
    const last = await call(routes.list, request(ownerId, {}, { limit: '2', offset: '4' }));
    assert.deepEqual(last.body.goals, []);
    assert.equal(last.body.nextOffset, null);

    const ids = async (query: Record<string, string>) =>
      (await call(routes.list, request(ownerId, {}, query))).body.goals.map((goal: Json) => goal.id);
    assert.deepEqual(await ids({ state: 'active', limit: '20' }), ['goal-running', 'goal-paused']);
    assert.deepEqual(await ids({ state: 'running', limit: '20' }), ['goal-running']);
    assert.deepEqual(await ids({ state: 'paused', limit: '20' }), ['goal-paused']);
    assert.deepEqual(await ids({ state: 'failed', limit: '20' }), ['goal-failed']);
    assert.deepEqual(await ids({ state: 'all', repository: otherRepository, limit: '20' }), ['goal-completed']);
    assert.equal((await call(routes.list, request(ownerId, {}, { state: 'bogus' }))).status, 400);
    assert.equal((await call(routes.list, request(ownerId, {}, { limit: '0' }))).status, 400);
    assert.equal((await call(routes.list, request(ownerId, {}, { repository: 'not a repo' }))).status, 400);
    assert.deepEqual((await call(routes.list, request(strangerId, {}, { limit: '20' }))).body.goals.map((goal: Json) => goal.id),
      ['goal-stranger']);

    const inspected = await call(routes.detail, request(ownerId, { goalId: 'goal-running' }));
    assert.equal(inspected.status, 200);
    assert.equal(inspected.body.goal.id, 'goal-running');
    assert.equal(inspected.body.goal.checkpoint.count, 2);
    const { detail } = inspected.body;
    assert.deepEqual(detail.progress.tasks, { total: 3, active: 1, completed: 1, failed: 1, cancelled: 0 });
    assert.equal(detail.progress.recentTerminalTransitions[0].taskId, 'child-failed');
    assert.equal(detail.progress.recentTerminalTransitions[0].reason, 'Fixture agent stopped');
    assert.equal(detail.progress.checkpoint.lastCommitSha, 'abc1234');
    assert.equal(detail.pendingInput.undeliveredInputs, 2);
    assert.deepEqual(detail.pullRequests.map((pr: Json) => [pr.number, pr.role, pr.state]),
      [[41, 'final', null], [77, 'task', 'merged']]);

    const page = await call(routes.inputs, request(ownerId, { goalId: 'goal-running' }, { limit: '2' }));
    assert.deepEqual(page.body.inputs.map((input: Json) => [input.id, input.state]),
      [['input-3', 'pending'], ['input-2', 'pending']]);
    assert.equal(page.body.nextOffset, 2);
    const older = await call(routes.inputs, request(ownerId, { goalId: 'goal-running' }, { limit: '2', offset: '2' }));
    assert.deepEqual(older.body.inputs.map((input: Json) => [input.id, input.state]), [['input-1', 'delivered']]);
    assert.equal(older.body.nextOffset, null);
    assert.equal((await call(routes.inputs, request(ownerId, { goalId: 'goal-running' }, { limit: '101' }))).status, 400);

    // Another user's goal is indistinguishable from a missing one on every read.
    for (const handler of [routes.get, routes.detail, routes.inputs]) {
      const denied = await call(handler, request(strangerId, { goalId: 'goal-running' }));
      assert.equal(denied.status, 404);
      assert.doesNotMatch(JSON.stringify(denied.body), /Correction|abc1234/);
    }
  } finally {
    await db.destroy();
    await closeEventPublisher();
    await closeConnection();
  }
});
