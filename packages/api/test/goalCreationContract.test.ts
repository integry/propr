import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { GOAL_CREATION_CONTRACT, validateGoalCreationOptions } from '@propr/shared';
import { createGoalSchema } from '../mcp/tools.js';

after(() => closeConnection());

const base = {
  idempotencyKey: 'contract-key-1', repository: 'acme/repo', objective: 'Ship it',
  agentId: 'agent-1', model: 'fixture-model', launchStrategy: 'direct',
};

function accepts(options: Record<string, unknown>): { api: boolean; mcp: boolean } {
  const body: Record<string, unknown> = { ...base, ...options };
  delete body.idempotencyKey;
  return {
    api: validateGoalCreationOptions(body) === null,
    mcp: createGoalSchema.safeParse({ ...base, ...options }).success,
  };
}

test('MCP create_goal and the goal API accept the same creation options', () => {
  for (const maxParallelTasks of [1, 8, 9, 32]) {
    assert.deepEqual(accepts({ maxParallelTasks }), { api: true, mcp: true }, `maxParallelTasks ${maxParallelTasks}`);
  }
  for (const maxParallelTasks of [0, 33, -1, 2.5]) {
    assert.deepEqual(accepts({ maxParallelTasks }), { api: false, mcp: false }, `maxParallelTasks ${maxParallelTasks}`);
  }
  for (const checkpointIntervalMinutes of [5, 15, 120]) {
    assert.deepEqual(accepts({ checkpointIntervalMinutes }), { api: true, mcp: true });
    assert.deepEqual(accepts({ checkpointIntervalMinutes, launchStrategy: 'orchestrate' }), { api: false, mcp: false });
  }
  for (const checkpointIntervalMinutes of [4, 121]) {
    assert.deepEqual(accepts({ checkpointIntervalMinutes }), { api: false, mcp: false });
  }
  for (const ultrafix of [true, false]) assert.deepEqual(accepts({ ultrafix }), { api: true, mcp: true });
  assert.deepEqual(accepts({ ultrafix: 'true' }), { api: false, mcp: false });
  assert.deepEqual(accepts({ launchStrategy: 'planner' }), { api: false, mcp: false });
  assert.deepEqual(accepts({ launchStrategy: 'orchestrate' }), { api: true, mcp: true });
  assert.deepEqual(accepts({ baseBranch: 'b'.repeat(255) }), { api: true, mcp: true });
  assert.deepEqual(accepts({ baseBranch: 'b'.repeat(256) }), { api: false, mcp: false });
  assert.deepEqual(accepts({ repository: 'not-a-repository' }), { api: false, mcp: false });
});

test('MCP create_goal keeps existing omitted defaults so idempotent retries stay compatible', () => {
  const parsed = createGoalSchema.parse(base);
  assert.equal(parsed.ultrafix, false);
  assert.equal(parsed.maxParallelTasks, 1);
  assert.equal(parsed.checkpointIntervalMinutes, undefined);
  assert.deepEqual(createGoalSchema.parse({ ...base, ultrafix: false }), parsed);
  assert.equal(createGoalSchema.parse({ ...base, ultrafix: true }).ultrafix, true);
});

test('the advertised creation contract describes Ultrafix without merge authority', () => {
  assert.equal(GOAL_CREATION_CONTRACT.startsWork, true);
  assert.equal(GOAL_CREATION_CONTRACT.delivery, 'draft-pull-request');
  assert.deepEqual(GOAL_CREATION_CONTRACT.ultrafix, { supported: true, default: false, grantsMerge: false });
  assert.deepEqual(GOAL_CREATION_CONTRACT.maxParallelTasks, { min: 1, max: 32 });
  assert.deepEqual(GOAL_CREATION_CONTRACT.checkpointIntervalMinutes.launchStrategies, ['direct']);
});
