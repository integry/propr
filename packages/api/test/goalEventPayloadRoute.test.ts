import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import {
  GoalRepository,
  closeConnection,
  type AgentConfig,
  type RepoToMonitor,
} from '@propr/core';
import { up } from '../../core/src/db/migrations/20260831000000_create_goal_control_plane.js';
import { configureDemoMode, resetConfiguredDemoMode } from '../demoMode.js';
import { createGoalRoutes } from '../routes/goalRoutes.js';

type BetterSqliteConnection = {
  pragma: (arg: string, options?: { simple?: boolean }) => unknown;
};

interface FakeResponseState {
  statusCode: number;
  body: unknown;
}

let database: Knex;

const agents: AgentConfig[] = [{
  id: 'a1',
  type: 'claude',
  alias: 'claude',
  enabled: true,
  dockerImage: 'img',
  configPath: '~/.claude',
  supportedModels: ['claude-opus-4-8'],
  goalCapable: true,
  defaultModel: 'claude-opus-4-8',
}];
const repositories: RepoToMonitor[] = [
  { name: 'octo/repo', enabled: true } as RepoToMonitor,
];

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
        done(null, connection);
      },
    },
  });
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

function makeRequest(goalId: string): Request {
  return {
    user: { id: 'user-1' },
    body: {},
    params: { goalId },
    query: { afterSequence: '0' },
    header() {
      return undefined;
    },
  } as unknown as Request;
}

before(async () => {
  database = createDatabase();
  await up(database);
  resetConfiguredDemoMode();
  configureDemoMode(false);
});

after(async () => {
  resetConfiguredDemoMode();
  await database.destroy();
  await closeConnection();
});

test('event route projects poisoned nested payloads without mutating persistence', async () => {
  const repo = new GoalRepository(database);
  const goal = await repo.createGoal({
    ownerUserId: 'user-1',
    repository: 'octo/repo',
    objective: 'Ship safely',
    agent: 'claude',
    requestedModel: 'claude-opus-4-8',
  });
  const lease = await repo.claimLease(goal.goalId, 'api-test-controller', 60_000);
  const githubToken = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn';
  const poisonedPayload = {
    status: 'working',
    progress: { current: 2, total: 5, note: `safe context ${githubToken}` },
    safeArray: ['alpha', { message: 'beta', count: 3 }, `array context ${githubToken}`],
    controller: { ownerUserId: 'user-1', leaseEpoch: 47 },
    sessionId: 'provider-session-private',
    nested: [{
      name: 'safe nested item',
      idempotencyKey: 'private-write-key',
      claimToken: 'private-claim-token',
      request: { headers: { authorization: `Bearer ${'a'.repeat(32)}` } },
      response: { body: 'private-controller-response' },
      runtime: { path: '/var/run/docker.sock', containerId: 'private-container' },
      worktreePath: '/tmp/worktrees/private-goal',
      configPath: '/home/propr/.config/private/config.json',
      credentialPath: '/run/secrets/github-token',
      env: { GITHUB_TOKEN: githubToken, SAFE_SETTING: 'not-public-either' },
      mounts: [{ source: '/home/propr/.ssh', target: '/root/.ssh' }],
    }],
    auditTrail: Array.from({ length: 120 }, (_, index) => ({ index, label: `safe-${index}` })),
  };
  const originalPayload = JSON.stringify(poisonedPayload);
  await repo.appendEvent(goal.goalId, {
    kind: 'output',
    eventType: 'poisoned-log',
    payload: poisonedPayload,
    idempotencyKey: 'poisoned-event',
    leaseOwner: 'api-test-controller',
    leaseEpoch: lease.epoch,
  });
  const persistedBefore = await database('goal_events')
    .where({ goal_id: goal.goalId, idempotency_key: 'poisoned-event' })
    .first<{ payload_json: string }>('payload_json');
  const routes = createGoalRoutes({
    db: database,
    services: {
      loadAgents: async () => agents,
      loadRepositories: async () => repositories,
    },
  });
  const { res, state } = makeResponse();
  await routes.readEvents(makeRequest(goal.goalId), res);

  assert.equal(state.statusCode, 200);
  const events = (state.body as { events: Array<{ payload: Record<string, unknown> }> }).events;
  assert.equal(events.length, 1);
  const payload = events[0].payload;
  const serialized = JSON.stringify(payload);
  assert.equal(payload.status, 'working');
  assert.deepEqual((payload.safeArray as unknown[]).slice(0, 2), [
    'alpha',
    { message: 'beta', count: 3 },
  ]);
  assert.match((payload.safeArray as string[])[2], /\[REDACTED_GITHUB_TOKEN\]/);
  assert.equal((payload.nested as Array<{ name: string }>)[0].name, 'safe nested item');
  assert.equal((payload.auditTrail as unknown[]).length, 100);
  assert.match((payload.progress as { note: string }).note, /\[REDACTED_GITHUB_TOKEN\]/);
  for (const forbiddenKey of [
    'controller', 'ownerUserId', 'leaseEpoch', 'sessionId', 'idempotencyKey',
    'claimToken', 'request', 'response', 'runtime', 'containerId', 'worktreePath',
    'configPath', 'credentialPath', 'env', 'GITHUB_TOKEN', 'SAFE_SETTING', 'mounts',
  ]) {
    assert.equal(serialized.includes(`"${forbiddenKey}"`), false, forbiddenKey);
  }
  for (const forbiddenLiteral of [
    githubToken, 'provider-session-private', 'private-write-key', 'private-claim-token',
    'private-controller-response', 'private-container', 'not-public-either',
    '/var/run/docker.sock', '/tmp/worktrees/private-goal',
    '/home/propr/.config/private/config.json', '/run/secrets/github-token',
    '/home/propr/.ssh', '/root/.ssh',
  ]) {
    assert.equal(serialized.includes(forbiddenLiteral), false, forbiddenLiteral);
  }
  assert.doesNotThrow(() => JSON.stringify(payload));
  assert.equal(JSON.stringify(poisonedPayload), originalPayload);
  const persistedAfter = await database('goal_events')
    .where({ goal_id: goal.goalId, idempotency_key: 'poisoned-event' })
    .first<{ payload_json: string }>('payload_json');
  assert.equal(persistedAfter?.payload_json, persistedBefore?.payload_json);
  assert.deepEqual(JSON.parse(persistedAfter!.payload_json), poisonedPayload);
});
