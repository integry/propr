import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeRefinedPlan } from '../src/services/taskPlanning/refinementOutput.js';

const currentPlan = [
  { title: 'First', body: 'First body', implementation: 'First implementation' },
  { title: 'Second', body: 'Second body', implementation: 'Second implementation', notes: 'Existing note' },
];

describe('normalizeRefinedPlan', () => {
  test('merges retain, extend, and add operations without dropping untouched tasks', () => {
    const result = normalizeRefinedPlan(currentPlan, [
      { action: 'retain', index: 0 },
      { action: 'extend', index: 1, body: 'More', notes: 'Another note' },
      { action: 'add', title: 'Third', body: 'Third body', implementation: 'Third implementation' },
    ]);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.merged, true);
    assert.equal(result.operations, 3);
    assert.equal(result.plan.length, 3);
    assert.deepEqual(result.plan[0], currentPlan[0]);
    assert.equal(result.plan[1].body, 'Second body\n\nMore');
    assert.equal((result.plan[1] as unknown as { notes: string }).notes, 'Existing note\n\nAnother note');
    assert.deepEqual(result.plan[2], {
      title: 'Third', body: 'Third body', implementation: 'Third implementation',
    });
  });

  test('rejects an edit with an unknown target', () => {
    const result = normalizeRefinedPlan(currentPlan, [{ action: 'extend', index: 7, body: 'More' }]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'REFINEMENT_OUTPUT_INVALID');
    assert.equal(result.details.reason, 'unknown_target');
  });

  test('reports missing fields and their zero-based task index', () => {
    const result = normalizeRefinedPlan(currentPlan, [
      currentPlan[0],
      { title: 'Incomplete', body: 'Missing its implementation' },
    ]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.details.reason, 'incomplete_tasks');
    assert.deepEqual(result.details.incomplete, [{ index: 1, missing: ['implementation'] }]);
  });

  test('reports an incomplete added task at its merged-plan index', () => {
    const result = normalizeRefinedPlan(currentPlan, [
      { action: 'add', title: 'Incomplete addition', body: 'Missing implementation' },
    ]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.details.reason, 'incomplete_tasks');
    assert.deepEqual(result.details.incomplete, [{ index: 2, missing: ['implementation'] }]);
  });

  test('inserts additions after an original index and retains unmentioned tasks', () => {
    const result = normalizeRefinedPlan(currentPlan, [
      { op: 'add', afterIndex: 0, title: 'Inserted', body: 'Inserted body', implementation: 'Inserted implementation' },
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.plan.map(task => task.title), ['First', 'Inserted', 'Second']);
  });

  test('rejects mixed plans and edit lists', () => {
    const result = normalizeRefinedPlan(currentPlan, [
      currentPlan[0],
      { action: 'remove', index: 1 },
    ]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.details.reason, 'mixed_shape');
  });

  test('distinguishes unrecognised and empty output shapes', () => {
    const unrecognised = normalizeRefinedPlan(currentPlan, { plan: currentPlan });
    const empty = normalizeRefinedPlan(currentPlan, []);
    assert.equal(unrecognised.ok, false);
    assert.equal(empty.ok, false);
    if (!unrecognised.ok) assert.equal(unrecognised.details.reason, 'mixed_shape');
    if (!empty.ok) assert.equal(empty.details.reason, 'empty_plan');
  });

  test('rejects duplicate targets', () => {
    const result = normalizeRefinedPlan(currentPlan, [
      { action: 'retain', title: 'First' },
      { action: 'extend', index: 0, body: 'More' },
    ]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.details.reason, 'unknown_target');
  });
});
