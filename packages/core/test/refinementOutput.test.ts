import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeRefinedPlan } from '../src/services/taskPlanning/refinementOutput.js';
import { preparePlanItemsFromModel } from '@propr/shared';

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

  test('keeps item ids through edit operations and restores ids a complete plan dropped', () => {
    const withIds = [
      { id: 'schema', title: 'Schema', body: 'Schema body', implementation: 'Schema steps' },
      { id: 'api', title: 'API', body: 'API body', implementation: 'API steps', dependsOn: ['schema'] },
    ];
    const edited = normalizeRefinedPlan(withIds, [
      { action: 'update', index: 1, id: 'renamed', body: 'New API body' },
      { action: 'retain', index: 0 },
    ]);
    assert.equal(edited.ok, true);
    if (!edited.ok) return;
    assert.deepEqual(edited.plan.map(item => [item.id, item.dependsOn ?? []]), [['schema', []], ['api', ['schema']]]);

    const complete = normalizeRefinedPlan(withIds, [
      { title: 'Schema', body: 'Schema body', implementation: 'Schema steps' },
      { title: 'API', body: 'Rewritten', implementation: 'API steps', dependsOn: ['schema'] },
      { title: 'Docs', body: 'Docs body', implementation: 'Docs steps' },
    ]);
    assert.equal(complete.ok, true);
    if (!complete.ok) return;
    assert.deepEqual(complete.plan.map(item => item.id), ['schema', 'api', undefined]);
  });

  test('keeps the dependencies of matched tasks when a complete body-only refinement omits dependsOn', () => {
    const withIds = [
      { id: 'schema', title: 'Schema', body: 'Schema body', implementation: 'Schema steps' },
      { id: 'api', title: 'API', body: 'API body', implementation: 'API steps', dependsOn: ['schema'] },
      { id: 'ui', title: 'UI', body: 'UI body', implementation: 'UI steps', dependsOn: ['api', 'schema'] },
    ];
    const omitted = normalizeRefinedPlan(withIds, [
      { id: 'schema', title: 'Schema', body: 'Clearer schema body', implementation: 'Schema steps' },
      // The id is dropped too: the title match restores both.
      { title: 'API', body: 'Clearer API body', implementation: 'API steps' },
      { id: 'ui', title: 'UI', body: 'Clearer UI body', implementation: 'UI steps', dependsOn: [] },
      { title: 'Docs', body: 'Docs body', implementation: 'Docs steps' },
    ]);
    assert.equal(omitted.ok, true);
    if (!omitted.ok) return;
    // An explicit empty list still removes every prerequisite.
    assert.deepEqual(omitted.plan.map(item => [item.id, item.dependsOn]),
      [['schema', undefined], ['api', ['schema']], ['ui', []], [undefined, undefined]]);
    assert.equal(omitted.plan[1].body, 'Clearer API body');
  });

  test('restored dependencies on a task the refinement removed are pruned when stored', () => {
    const withIds = [
      { id: 'schema', title: 'Schema', body: 'Schema body', implementation: 'Schema steps' },
      { id: 'api', title: 'API', body: 'API body', implementation: 'API steps', dependsOn: ['schema'] },
    ];
    const result = normalizeRefinedPlan(withIds, [{ id: 'api', title: 'API', body: 'Only API', implementation: 'API steps' }]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.plan[0].dependsOn, ['schema']);
    assert.deepEqual(preparePlanItemsFromModel(result.plan).map(item => [item.id, item.dependsOn]), [['api', undefined]]);
  });
});
