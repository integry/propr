import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import type { AgentConfig, RepoToMonitor } from '@propr/core';
import { GoalRepository, closeConnection } from '@propr/core';
import { up } from '../../core/src/db/migrations/20260831000000_create_goal_control_plane.js';
import { resetConfiguredDemoMode, configureDemoMode } from '../demoMode.js';
import { createGoalRoutes } from '../routes/goalRoutes.js';

type BetterSqliteConnection = {
  pragma: (arg: string, options?: { simple?: boolean }) => unknown;
};

let database: Knex, createCounter = 0;

function createDatabase(): Knex {
  return knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: {
      afterCreate(
        connection: BetterSqliteConnection,
        done: (error: Error | null, connection: BetterSqliteConnection) => void
      ) {
        connection.pragma('foreign_keys = ON');
        connection.pragma('recursive_triggers = ON');
        connection.pragma('busy_timeout = 1000');
        done(null, connection);
      },
    },
  });
}

const agents: AgentConfig[] = [
  {
    id: 'a1',
    type: 'claude',
    alias: 'claude',
    enabled: true,
    dockerImage: 'img',
    configPath: '~/.claude',
    supportedModels: ['claude-opus-4-8', 'claude-sonnet-5'],
    goalCapable: true,
    defaultModel: 'claude-opus-4-8',
  },
];
const repositories: RepoToMonitor[] = [
  { name: 'octo/repo', enabled: true } as RepoToMonitor,
];

function makeRoutes() {
  return createGoalRoutes({
    db: database,
    services: {
      loadAgents: async () => agents,
      loadRepositories: async () => repositories,
    },
  });
}

interface FakeResponseState {
  statusCode: number;
  body: unknown;
}

function makeResponse(): { res: Response; state: FakeResponseState } {
  const state: FakeResponseState = { statusCode: 200, body: undefined };
  const res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      state.body = payload;
      return this;
    },
  } as unknown as Response;
  return { res, state };
}

function makeRequest(options: {
  user?: { id: string } | null;
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}): Request {
  const headers = options.headers ?? {};
  return {
    user: options.user === null ? undefined : options.user ?? { id: 'user-1' },
    body: options.body ?? {},
    params: options.params ?? {},
    query: options.query ?? {},
    header(name: string) {
      return headers[name] ?? headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

async function createGoalViaApi(overrides: Record<string, unknown> = {}) {
  const routes = makeRoutes();
  const { res, state } = makeResponse();
  await routes.createGoal(
    makeRequest({
      headers: { 'Idempotency-Key': `test-create-${createCounter += 1}` },
      body: {
        objective: 'Ship it',
        repository: 'octo/repo',
        agent: 'claude',
        model: 'claude-opus-4-8',
        ...overrides,
      },
    }),
    res
  );
  return state;
}

beforeEach(async () => {
  if (database) await database.destroy();
  database = createDatabase();
  await up(database);
  resetConfiguredDemoMode();
  configureDemoMode(false);
});

after(async () => {
  resetConfiguredDemoMode();
  if (database) await database.destroy();
  // The @propr/core barrel eagerly opens the shared SQLite connection; close it
  // so the test process can exit.
  await closeConnection();
});

describe('goal routes', () => {
  test('creates a goal for the authenticated owner', async () => {
    const state = await createGoalViaApi();
    assert.equal(state.statusCode, 201);
    const goal = (state.body as { goal: { state: string } }).goal;
    assert.equal('ownerUserId' in goal, false);
    assert.equal(goal.state, 'queued');
  });

  test('rejects an unconfigured repository', async () => {
    const state = await createGoalViaApi({ repository: 'evil/repo' });
    assert.equal(state.statusCode, 403);
    assert.equal((state.body as { code: string }).code, 'goal_repository_forbidden');
  });

  test('rejects a model outside the agent catalog', async () => {
    const state = await createGoalViaApi({ model: 'gpt-5.6-sol' });
    assert.equal(state.statusCode, 400);
    assert.equal(
      (state.body as { code: string }).code,
      'goal_invalid_catalog_selection'
    );
  });

  test('requires explicit goal capability on both agent and model catalog entries', async () => {
    const originalCapability = agents[0].goalCapable;
    agents[0].goalCapable = undefined;
    const unmarkedAgent = await createGoalViaApi();
    assert.equal((unmarkedAgent.body as { code: string }).code, 'goal_invalid_catalog_selection');
    agents[0].goalCapable = originalCapability;
    agents[0].supportedModels.push('custom-unmarked-model');
    const unmarkedModel = await createGoalViaApi({ model: 'custom-unmarked-model' });
    assert.equal((unmarkedModel.body as { code: string }).code, 'goal_invalid_catalog_selection');
    agents[0].supportedModels.pop();
  });

  test('rejects out-of-bounds concurrency', async () => {
    const state = await createGoalViaApi({ maxActiveTasks: 999 });
    assert.equal(state.statusCode, 400);
    assert.equal(
      (state.body as { code: string }).code,
      'goal_concurrency_bound_exceeded'
    );
  });

  test('validates and persists the shared Ultrafix contract', async () => {
    const invalidGoal = await createGoalViaApi({ ultrafixEnabled: true, ultrafixGoal: 11, ultrafixMaxCycles: 2 });
    assert.equal((invalidGoal.body as { code: string }).code, 'goal_validation_error');
    const invalidCycles = await createGoalViaApi({ ultrafixEnabled: true, ultrafixGoal: 8, ultrafixMaxCycles: 21 });
    assert.equal((invalidCycles.body as { code: string }).code, 'goal_validation_error');
    const created = await createGoalViaApi({
      maxActiveTasks: 4,
      mergePolicy: 'auto_squash',
      ultrafixEnabled: true,
      ultrafixGoal: 8,
      ultrafixMaxCycles: 4,
    });
    const goal = (created.body as { goal: { ultrafixGoal: number; ultrafixMaxCycles: number; mergePolicy: string } }).goal;
    assert.equal(goal.ultrafixGoal, 8);
    assert.equal(goal.ultrafixMaxCycles, 4);
    assert.equal(goal.mergePolicy, 'auto_squash');
  });

  test('requires authentication', async () => {
    const routes = makeRoutes();
    const { res, state } = makeResponse();
    await routes.listGoals(makeRequest({ user: null }), res);
    assert.equal(state.statusCode, 401);
  });

  test('hides another user\'s goal behind not-found', async () => {
    const repo = new GoalRepository(database);
    const other = await repo.createGoal({
      ownerUserId: 'user-2',
      repository: 'octo/repo',
      objective: 'secret',
      agent: 'claude',
      requestedModel: 'claude-opus-4-8',
    });
    const routes = makeRoutes();
    const { res, state } = makeResponse();
    await routes.getGoal(
      makeRequest({ user: { id: 'user-1' }, params: { goalId: other.goalId } }),
      res
    );
    assert.equal(state.statusCode, 404);
    assert.equal((state.body as { code: string }).code, 'goal_not_found');
  });

  test('lists only the caller\'s goals with pagination', async () => {
    const repo = new GoalRepository(database);
    await repo.createGoal({
      ownerUserId: 'user-2',
      repository: 'octo/repo',
      objective: 'theirs',
      agent: 'claude',
      requestedModel: 'claude-opus-4-8',
    });
    await createGoalViaApi({ objective: 'mine-1' });
    await createGoalViaApi({ objective: 'mine-2' });

    const routes = makeRoutes();
    const { res, state } = makeResponse();
    await routes.listGoals(makeRequest({ query: { limit: '1' } }), res);
    const body = state.body as { goals: unknown[]; nextCursor: string | null };
    assert.equal(body.goals.length, 1);
    assert.ok(body.nextCursor);
  });

  test('enforces optimistic version on pause', async () => {
    const created = await createGoalViaApi();
    const goalId = (created.body as { goal: { goalId: string } }).goal.goalId;
    const routes = makeRoutes();
    const { res, state } = makeResponse();
    await routes.pauseGoal(
      makeRequest({ params: { goalId }, body: { expectedVersion: 99 }, headers: { 'Idempotency-Key': 'pause-version' } }),
      res
    );
    assert.equal(state.statusCode, 409);
    assert.equal(
      (state.body as { code: string }).code,
      'goal_version_conflict'
    );
  });

  test('rejects an invalid lifecycle transition with a stable conflict', async () => {
    const created = await createGoalViaApi();
    const goalId = (created.body as { goal: { goalId: string } }).goal.goalId;
    const routes = makeRoutes();
    // queued -> resume(running) is valid, then resume again is invalid.
    await routes.resumeGoal(makeRequest({ params: { goalId }, headers: { 'Idempotency-Key': 'resume-first' } }), makeResponse().res);
    const { res, state } = makeResponse();
    // running -> resume(running) is not a valid transition.
    await routes.resumeGoal(makeRequest({ params: { goalId }, headers: { 'Idempotency-Key': 'resume-second' } }), res);
    assert.equal(state.statusCode, 409);
    assert.equal(
      (state.body as { code: string }).code,
      'goal_invalid_transition'
    );
  });

  test('enqueues a message requiring an idempotency key and replays cursor', async () => {
    const created = await createGoalViaApi();
    const goalId = (created.body as { goal: { goalId: string } }).goal.goalId;
    const routes = makeRoutes();

    // Missing idempotency key is rejected.
    const missing = makeResponse();
    await routes.enqueueMessage(
      makeRequest({ params: { goalId }, body: { body: 'hi' } }),
      missing.res
    );
    assert.equal(missing.state.statusCode, 400);

    // Retried enqueue with the same key has one effect.
    for (let i = 0; i < 2; i += 1) {
      const { res } = makeResponse();
      await routes.enqueueMessage(
        makeRequest({
          params: { goalId },
          body: { body: 'please fix' },
          headers: { 'Idempotency-Key': 'msg-1' },
        }),
        res
      );
    }
    const messages = await new GoalRepository(database).getMessages(goalId);
    assert.equal(messages.length, 1);
  });

  test('reads events from an exclusive cursor', async () => {
    const created = await createGoalViaApi();
    const goalId = (created.body as { goal: { goalId: string } }).goal.goalId;
    const repo = new GoalRepository(database);
    const lease = await repo.claimLease(goalId, 'api-test-controller', 60_000);
    for (let i = 1; i <= 3; i += 1) {
      await repo.appendEvent(goalId, {
        kind: 'output',
        eventType: 'log',
        idempotencyKey: `e${i}`,
        leaseOwner: 'api-test-controller',
        leaseEpoch: lease.epoch,
      });
    }
    const routes = makeRoutes();
    const { res, state } = makeResponse();
    await routes.readEvents(
      makeRequest({ params: { goalId }, query: { afterSequence: '1', limit: '5' } }),
      res
    );
    const body = state.body as { events: Array<{ sequence: number }> };
    assert.deepEqual(
      body.events.map((e) => e.sequence),
      [2, 3]
    );
  });

  test('rejects negative cursors and unknown event kinds with stable codes', async () => {
    const created = await createGoalViaApi();
    const goalId = (created.body as { goal: { goalId: string } }).goal.goalId;
    const routes = makeRoutes();
    const cursor = makeResponse();
    await routes.readEvents(makeRequest({ params: { goalId }, query: { afterSequence: '-1' } }), cursor.res);
    assert.equal((cursor.state.body as { code: string }).code, 'goal_invalid_cursor');
    const kind = makeResponse();
    await routes.readEvents(makeRequest({ params: { goalId }, query: { kind: 'credential_dump' } }), kind.res);
    assert.equal((kind.state.body as { code: string }).code, 'goal_invalid_event_kind');
  });

  test('demo mode shares goals across users read-only', async () => {
    const repo = new GoalRepository(database);
    const goal = await repo.createGoal({
      ownerUserId: 'someone-else',
      repository: 'octo/repo',
      objective: 'shared',
      agent: 'claude',
      requestedModel: 'claude-opus-4-8',
    });
    configureDemoMode(true);
    const routes = makeRoutes();
    const { res, state } = makeResponse();
    await routes.getGoal(
      makeRequest({ user: { id: 'propr-demo' }, params: { goalId: goal.goalId } }),
      res
    );
    assert.equal(state.statusCode, 200);
    configureDemoMode(false);
  });

  test('creation is idempotent across retries with a key', async () => {
    const routes = makeRoutes();
    const first = makeResponse();
    await routes.createGoal(
      makeRequest({
        body: {
          objective: 'Ship it',
          repository: 'octo/repo',
          agent: 'claude',
          model: 'claude-opus-4-8',
        },
        headers: { 'Idempotency-Key': 'create-1' },
      }),
      first.res
    );
    const second = makeResponse();
    await routes.createGoal(
      makeRequest({
        body: {
          objective: 'Ship it',
          repository: 'octo/repo',
          agent: 'claude',
          model: 'claude-opus-4-8',
        },
        headers: { 'Idempotency-Key': 'create-1' },
      }),
      second.res
    );
    const firstId = (first.state.body as { goal: { goalId: string } }).goal.goalId;
    const secondId = (second.state.body as { goal: { goalId: string } }).goal.goalId;
    assert.equal(firstId, secondId);
    assert.notEqual(firstId, 'create-1');
    const count = await database('goals').count({ c: '*' }).first();
    assert.equal(Number(count?.c), 1);
  });

  test('idempotent create rejects payload mismatch and is scoped to the owner', async () => {
    const routes = makeRoutes();
    const first = makeResponse();
    await routes.createGoal(makeRequest({ body: { objective: 'one', repository: 'octo/repo', agent: 'claude', model: 'claude-opus-4-8' }, headers: { 'Idempotency-Key': 'owner-key' } }), first.res);
    const mismatch = makeResponse();
    await routes.createGoal(makeRequest({ body: { objective: 'two', repository: 'octo/repo', agent: 'claude', model: 'claude-opus-4-8' }, headers: { 'Idempotency-Key': 'owner-key' } }), mismatch.res);
    assert.equal((mismatch.state.body as { code: string }).code, 'goal_idempotency_conflict');
    const otherOwner = makeResponse();
    await routes.createGoal(makeRequest({ user: { id: 'user-2' }, body: { objective: 'two', repository: 'octo/repo', agent: 'claude', model: 'claude-opus-4-8' }, headers: { 'Idempotency-Key': 'owner-key' } }), otherOwner.res);
    assert.equal(otherOwner.state.statusCode, 201);
  });

  test('all operator mutations replay their original response and reject mismatches', async () => {
    const created = await createGoalViaApi();
    const goalId = (created.body as { goal: { goalId: string } }).goal.goalId;
    const routes = makeRoutes();
    const first = makeResponse();
    await routes.pauseGoal(makeRequest({ params: { goalId }, body: { reason: 'pause' }, headers: { 'Idempotency-Key': 'pause-key' } }), first.res);
    const retry = makeResponse();
    await routes.pauseGoal(makeRequest({ params: { goalId }, body: { reason: 'pause' }, headers: { 'Idempotency-Key': 'pause-key' } }), retry.res);
    assert.deepEqual(retry.state.body, first.state.body);
    const mismatch = makeResponse();
    await routes.pauseGoal(makeRequest({ params: { goalId }, body: { reason: 'changed' }, headers: { 'Idempotency-Key': 'pause-key' } }), mismatch.res);
    assert.equal((mismatch.state.body as { code: string }).code, 'goal_idempotency_conflict');
  });

  test('rejects model changes once a goal is terminal', async () => {
    const created = await createGoalViaApi();
    const goalId = (created.body as { goal: { goalId: string } }).goal.goalId;
    await new GoalRepository(database).transitionOperatorIntent(goalId, { toState: 'cancelled', terminalReason: 'user_cancelled' });
    const response = makeResponse();
    await makeRoutes().requestModelChange(
      makeRequest({ params: { goalId }, body: { model: 'claude-sonnet-5' }, headers: { 'Idempotency-Key': 'model-terminal' } }),
      response.res
    );
    assert.equal((response.state.body as { code: string }).code, 'goal_terminal_state');
  });
});
