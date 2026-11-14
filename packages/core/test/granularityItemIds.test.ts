import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enforceGranularity } from '../src/services/taskPlanning/granularity.js';

const log = { info() {}, warn() {}, error() {}, debug() {} };

test('the single-task merge keeps the first item id and drops dependencies that pointed inside the merged plan', () => {
  const plan = [
    { id: 'schema', title: 'Schema', body: 'Schema body', implementation: 'Schema steps' },
    { id: 'api', title: 'API', body: 'API body', implementation: 'API steps', dependsOn: ['schema'] },
  ];
  const merged = enforceGranularity(plan, 'single', log as never);
  assert.equal(merged.plan.length, 1);
  assert.equal(merged.plan[0].id, 'schema');
  assert.equal(merged.plan[0].dependsOn, undefined);

  const untouched = enforceGranularity(plan, 'balanced', log as never);
  assert.equal(untouched.plan, plan, 'other granularities keep ids and dependsOn as written');
  const single = enforceGranularity([plan[0]], 'single', log as never);
  assert.equal(single.plan[0], plan[0]);
});
