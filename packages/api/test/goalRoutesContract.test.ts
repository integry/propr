import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import {
  closeConnection,
  GoalLifecycleService,
  GoalRepository,
  type AgentConfig,
  type RepoToMonitor,
} from '@propr/core';
import { up } from '../../core/src/db/migrations/20260831000000_create_goal_control_plane.js';
import { configureDemoMode, resetConfiguredDemoMode } from '../demoMode.js';
import { createGoalRoutes } from '../routes/goalRoutes.js';

interface ResponseState { statusCode: number; body: unknown }
type SqliteConnection = { pragma: (value: string) => unknown };

let database: Knex;
const agents: AgentConfig[] = [{
  id: 'a1', type: 'claude', alias: 'claude', enabled: true, dockerImage: 'img',
  configPath: '~/.claude', supportedModels: ['claude-opus-4-8', 'claude-sonnet-5'],
  goalCapable: true, defaultModel: 'claude-opus-4-8',
}];
const repositories = [{ name: 'octo/repo', enabled: true } as RepoToMonitor];

function response(): { res: Response; state: ResponseState } {
  const state: ResponseState = { statusCode: 200, body: undefined };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(body: unknown) { state.body = body; return this; },
  } as unknown as Response;
  return { res, state };
}

function request(options: {
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
} = {}): Request {
  const headers = options.headers ?? {};
  return {
    user: { id: 'user-1' }, body: options.body ?? {}, params: options.params ?? {},
    query: options.query ?? {},
    header(name: string) { return headers[name] ?? headers[name.toLowerCase()]; },
  } as unknown as Request;
}

function routes() {
  return createGoalRoutes({
    db: database,
    services: {
      loadAgents: async () => agents,
      loadRepositories: async () => repositories,
    },
  });
}

async function create(objective: string, key: string): Promise<ResponseState> {
  const result = response();
  await routes().createGoal(request({
    body: { objective, repository: 'octo/repo', agent: 'claude', model: 'claude-opus-4-8' },
    headers: { 'Idempotency-Key': key },
  }), result.res);
  return result.state;
}

const FORBIDDEN_PUBLIC_KEYS = new Set([
  'ownerUserId', 'leaseOwner', 'leaseEpoch', 'leaseExpiresAt',
  'idempotencyKey', 'deliveryAttempts', 'lastError', 'attemptCount', 'id',
  'owner_user_id', 'lease_owner', 'lease_epoch', 'lease_expires_at',
  'idempotency_key', 'claimToken', 'requestHash', 'responseJson',
]);

function assertNoControllerInternals(value: unknown, path = 'response'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoControllerInternals(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    assert.equal(FORBIDDEN_PUBLIC_KEYS.has(key), false, `${path}.${key} is controller-internal`);
    assertNoControllerInternals(nested, `${path}.${key}`);
  }
}

before(async () => {
  database = knex({
    client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true,
    pool: { afterCreate(connection: SqliteConnection, done: (error: Error | null, value: SqliteConnection) => void) {
      connection.pragma('foreign_keys = ON');
      connection.pragma('busy_timeout = 1000');
      done(null, connection);
    } },
  });
  await up(database);
  resetConfiguredDemoMode();
  configureDemoMode(false);
});

after(async () => {
  resetConfiguredDemoMode();
  await database.destroy();
  await closeConnection();
});

describe('goal HTTP contract', () => {
  test('projects every public goal record response through canonical DTOs', async () => {
    const api = routes();
    const created = await create('public DTO goal', 'dto-create');
    const goalId = (created.body as { goal: { goalId: string } }).goal.goalId;
    const repository = new GoalRepository(database);
    const lease = await repository.claimLease(goalId, 'dto-controller', 60_000);
    const fence = { leaseOwner: 'dto-controller', leaseEpoch: lease.epoch };
    await repository.addNode(goalId, {
      kind: 'root_epic', title: 'Public node', idempotencyKey: 'private-node-key', ...fence,
    });
    await repository.appendEvent(goalId, {
      kind: 'domain', eventType: 'public-event', payload: { progress: 1 },
      idempotencyKey: 'private-event-key', ...fence,
    });

    const message = response();
    await api.enqueueMessage(request({
      params: { goalId }, body: { body: 'Correct this' },
      headers: { 'Idempotency-Key': 'private-message-key' },
    }), message.res);
    const detail = response();
    await api.getGoal(request({ params: { goalId } }), detail.res);
    const model = response();
    await api.requestModelChange(request({
      params: { goalId }, body: { model: 'claude-sonnet-5' },
      headers: { 'Idempotency-Key': 'dto-model' },
    }), model.res);
    const events = response();
    await api.readEvents(request({ params: { goalId } }), events.res);
    const paused = response();
    await api.pauseGoal(request({
      params: { goalId }, headers: { 'Idempotency-Key': 'dto-pause' },
    }), paused.res);
    const cancelled = response();
    await api.cancelGoal(request({
      params: { goalId }, headers: { 'Idempotency-Key': 'dto-cancel' },
    }), cancelled.res);

    const resumable = await create('public resume DTO goal', 'dto-resume-create');
    const resumableId = (resumable.body as { goal: { goalId: string } }).goal.goalId;
    const lifecycle = new GoalLifecycleService(repository);
    await lifecycle.pause(resumableId, { idempotencyKey: 'dto-resume-pause' });
    const resumableLease = await repository.claimLease(resumableId, 'dto-resume-controller', 60_000);
    await lifecycle.confirmPaused(resumableId, {
      leaseOwner: 'dto-resume-controller', leaseEpoch: resumableLease.epoch,
      idempotencyKey: 'dto-resume-confirm',
    });
    const resumed = response();
    await api.resumeGoal(request({
      params: { goalId: resumableId }, headers: { 'Idempotency-Key': 'dto-resume' },
    }), resumed.res);

    for (const publicResponse of [
      created.body, detail.state.body, paused.state.body, resumed.state.body,
      cancelled.state.body, model.state.body, message.state.body, events.state.body,
    ]) {
      assertNoControllerInternals(publicResponse);
    }
    assert.deepEqual(
      Object.keys((events.state.body as { events: Array<Record<string, unknown>> }).events[0]).sort(),
      ['createdAt', 'cursor', 'eventType', 'goalId', 'kind', 'payload', 'schemaVersion', 'sequence']
    );
  });

  test('requires one bounded idempotency key on every mutation', async () => {
    const api = routes();
    const missingCreate = response();
    await api.createGoal(request({ body: {
      objective: 'missing key', repository: 'octo/repo', agent: 'claude', model: 'claude-opus-4-8',
    } }), missingCreate.res);
    assert.equal((missingCreate.state.body as { code: string }).code, 'goal_invalid_idempotency_key');
    const created = await create('mutation goal', 'mutation-create');
    const goalId = (created.body as { goal: { goalId: string } }).goal.goalId;
    const calls: Array<(res: Response) => Promise<void>> = [
      res => api.pauseGoal(request({ params: { goalId } }), res),
      res => api.resumeGoal(request({ params: { goalId } }), res),
      res => api.cancelGoal(request({ params: { goalId } }), res),
      res => api.requestModelChange(request({ params: { goalId }, body: { model: 'claude-sonnet-5' } }), res),
      res => api.enqueueMessage(request({ params: { goalId }, body: { body: 'fix' } }), res),
    ];
    for (const call of calls) {
      const result = response();
      await call(result.res);
      assert.equal((result.state.body as { code: string }).code, 'goal_invalid_idempotency_key');
    }
    const oversized = response();
    await api.pauseGoal(request({ params: { goalId }, headers: { 'Idempotency-Key': 'x'.repeat(256) } }), oversized.res);
    assert.equal((oversized.state.body as { code: string }).code, 'goal_invalid_idempotency_key');
  });

  test('accepts the body key fallback and bounds mutation text', async () => {
    const api = routes();
    const fallback = response();
    await api.createGoal(request({ body: {
      objective: 'body fallback', repository: 'octo/repo', agent: 'claude',
      model: 'claude-opus-4-8', idempotencyKey: 'body-key',
    } }), fallback.res);
    assert.equal(fallback.state.statusCode, 201);
    const tooLong = await create('x'.repeat(4001), 'long-objective');
    assert.equal((tooLong.body as { code: string }).code, 'goal_validation_error');
    const goalId = (fallback.state.body as { goal: { goalId: string } }).goal.goalId;
    const message = response();
    await api.enqueueMessage(request({
      params: { goalId }, body: { body: 'x'.repeat(4001) },
      headers: { 'Idempotency-Key': 'long-message' },
    }), message.res);
    assert.equal((message.state.body as { code: string }).code, 'goal_validation_error');
  });

  test('returns shared summaries with strict keyset pagination and filters', async () => {
    await create('alpha objective', 'alpha-create');
    await create('beta objective', 'beta-create');
    await create('gamma objective', 'gamma-create');
    const api = routes();
    const first = response();
    await api.listGoals(request({ query: { limit: '1' } }), first.res);
    const page1 = first.state.body as { goals: Array<Record<string, unknown>>; nextCursor: string };
    assert.equal('ownerUserId' in page1.goals[0], false);
    assert.equal('leaseOwner' in page1.goals[0], false);
    assert.equal(typeof page1.goals[0].nodeCount, 'number');
    const second = response();
    await api.listGoals(request({ query: { limit: '1', cursor: page1.nextCursor } }), second.res);
    assert.notEqual((second.state.body as { goals: Array<{ goalId: string }> }).goals[0].goalId, page1.goals[0].goalId);
    const search = response();
    await api.listGoals(request({ query: { search: 'alpha' } }), search.res);
    assert.deepEqual((search.state.body as { goals: Array<{ objective: string }> }).goals.map(goal => goal.objective), ['alpha objective']);
    for (const query of [{ limit: '0' }, { limit: '101' }, { limit: '1.5' }, { page: '2' }]) {
      const invalid = response();
      await api.listGoals(request({ query }), invalid.res);
      assert.equal(invalid.state.statusCode, 400);
    }
    const cursor = response();
    await api.listGoals(request({ query: { cursor: 'malformed' } }), cursor.res);
    assert.equal((cursor.state.body as { code: string }).code, 'goal_invalid_cursor');
  });
});
