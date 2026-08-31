import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import { closeConnection, GoalRepository } from '@propr/core';
import { up } from '../../core/src/db/migrations/20260831000000_create_goal_control_plane.js';
import { configureDemoMode, resetConfiguredDemoMode } from '../demoMode.js';
import { createGoalRoutes } from '../routes/goalRoutes.js';

type SqliteConnection = { pragma: (value: string) => unknown };
interface ResponseState { statusCode: number; body: unknown }

let database: Knex;

function createDatabase(): Knex {
  return knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: {
      afterCreate(
        connection: SqliteConnection,
        done: (error: Error | null, value: SqliteConnection) => void
      ) {
        connection.pragma('foreign_keys = ON');
        connection.pragma('recursive_triggers = ON');
        done(null, connection);
      },
    },
  });
}

function response(): { res: Response; state: ResponseState } {
  const state: ResponseState = { statusCode: 200, body: undefined };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(body: unknown) { state.body = body; return this; },
  } as unknown as Response;
  return { res, state };
}

function request(options: {
  userId?: string;
  body?: unknown;
  params?: Record<string, string>;
  headers?: Record<string, string>;
} = {}): Request {
  const headers = options.headers ?? {};
  return {
    user: { id: options.userId ?? 'user-1' },
    body: options.body ?? {},
    params: options.params ?? {},
    query: {},
    header(name: string) { return headers[name] ?? headers[name.toLowerCase()]; },
  } as unknown as Request;
}

async function seedGoal(ownerUserId: string, objective: string) {
  return new GoalRepository(database).createGoal({
    ownerUserId,
    repository: 'octo/repo',
    objective,
    agent: 'claude',
    requestedModel: 'claude-opus-4-8',
  });
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
  await closeConnection();
});

describe('goal route review blockers', () => {
  test('validates body and If-Match independently and rejects disagreement', async () => {
    const goal = await seedGoal('user-1', 'version contract');
    const routes = createGoalRoutes({ db: database });
    await routes.resumeGoal(request({
      params: { goalId: goal.goalId },
      headers: { 'Idempotency-Key': 'version-running' },
    }), response().res);
    const malformed = [
      { body: { expectedVersion: 2 }, ifMatch: 'W/"2"' },
      { body: { expectedVersion: '2' }, ifMatch: '"2"' },
      { body: { expectedVersion: 2.5 }, ifMatch: undefined },
      { body: { expectedVersion: 2 }, ifMatch: '1, 2' },
    ];
    for (const [index, candidate] of malformed.entries()) {
      const result = response();
      await routes.pauseGoal(request({
        params: { goalId: goal.goalId },
        body: candidate.body,
        headers: {
          'Idempotency-Key': `malformed-version-${index}`,
          ...(candidate.ifMatch === undefined ? {} : { 'If-Match': candidate.ifMatch }),
        },
      }), result.res);
      assert.equal(result.state.statusCode, 400);
      assert.equal((result.state.body as { code: string }).code, 'goal_validation_error');
    }

    const disagreement = response();
    await routes.pauseGoal(request({
      params: { goalId: goal.goalId },
      body: { expectedVersion: 2 },
      headers: { 'Idempotency-Key': 'version-disagreement', 'If-Match': '"1"' },
    }), disagreement.res);
    assert.equal(disagreement.state.statusCode, 400);
    const unchanged = await new GoalRepository(database).requireGoal(goal.goalId);
    assert.deepEqual({ state: unchanged.state, version: unchanged.version }, { state: 'running', version: 2 });

    const matching = response();
    await routes.pauseGoal(request({
      params: { goalId: goal.goalId },
      body: { expectedVersion: 2 },
      headers: { 'Idempotency-Key': 'version-matching', 'If-Match': '"2"' },
    }), matching.res);
    assert.equal(matching.state.statusCode, 200);
  });

  test('demo list and detail share all owners while normal mode stays isolated', async () => {
    const ownGoal = await seedGoal('user-1', 'owned');
    const otherGoal = await seedGoal('someone-else', 'shared');
    const routes = createGoalRoutes({ db: database });

    configureDemoMode(true);
    const demoList = response();
    await routes.listGoals(request({ userId: 'propr-demo' }), demoList.res);
    assert.deepEqual(
      new Set((demoList.state.body as { goals: Array<{ goalId: string }> }).goals.map(goal => goal.goalId)),
      new Set([ownGoal.goalId, otherGoal.goalId])
    );
    const demoDetail = response();
    await routes.getGoal(request({
      userId: 'propr-demo', params: { goalId: otherGoal.goalId },
    }), demoDetail.res);
    assert.equal(demoDetail.state.statusCode, 200);

    configureDemoMode(false);
    const normalList = response();
    await routes.listGoals(request(), normalList.res);
    assert.deepEqual(
      (normalList.state.body as { goals: Array<{ goalId: string }> }).goals.map(goal => goal.goalId),
      [ownGoal.goalId]
    );
    const normalDetail = response();
    await routes.getGoal(request({ params: { goalId: otherGoal.goalId } }), normalDetail.res);
    assert.equal(normalDetail.state.statusCode, 404);
  });
});
