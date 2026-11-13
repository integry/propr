import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assignPlanItemIds, normalizePlanItems, parseDependsOnIssues, preparePlanItemsFromModel,
  reducePlanItemDependencies, resolvePlanItemIssueDependencies, validatePlanItemGraph, withPlanIssueDependencies,
  parseUnresolvedDependsOn, serializeDependsOnIssues,
} from '../src/planItemGraph.js';

const item = (id: string | undefined, dependsOn?: unknown, title = id ? id.toUpperCase() : 'Untitled') =>
  ({ ...(id !== undefined ? { id } : {}), title, ...(dependsOn !== undefined ? { dependsOn } : {}) });

test('a plan without dependsOn anywhere is valid', () => {
  assert.deepEqual(validatePlanItemGraph([item('a'), item('b')]), { valid: true });
  assert.deepEqual(validatePlanItemGraph([item('a'), item('b', ['a']), item('c', ['a', 'b'])]), { valid: true });
});

test('validation names the item for unknown ids, self-references, cycles and duplicate ids', () => {
  const cases: Array<[unknown[], string, string]> = [
    [[item('a'), item('b', ['z'])], 'unknown_dependency', 'Task 2 "B" (id "b") depends on "z", which matches no item in this plan.'],
    [[item('a', ['a'])], 'self_dependency', 'Task 1 "A" (id "a") depends on itself.'],
    [[item('a', ['b']), item('b', ['a'])], 'dependency_cycle', 'Task 1 "A" (id "a") is part of a dependency cycle: "a" → "b" → "a".'],
    [[item('a'), item('a', undefined, 'Again')], 'duplicate_id', 'Task 2 "Again" (id "a") reuses the id "a" of task 1. Item ids must be unique.'],
    [[item('a', 'b')], 'invalid_depends_on', 'Task 1 "A" (id "a") has an invalid dependsOn: it must be a list of item ids.'],
    [[item(undefined)], 'invalid_id', 'Task 1 "Untitled" has no id.'],
  ];
  for (const [plan, code, message] of cases) {
    const result = validatePlanItemGraph(plan);
    assert.equal(result.valid, false);
    assert.equal(!result.valid && result.errors[0].code, code);
    assert.equal(!result.valid && result.message, message);
  }
  const cycle = validatePlanItemGraph([item('a', ['c']), item('b', ['a']), item('c', ['b'])]);
  assert.deepEqual(!cycle.valid && cycle.errors[0].cycle, ['a', 'c', 'b', 'a']);
  assert.equal(validatePlanItemGraph([item(undefined), item('b')], { requireIds: false }).valid, true);
});

test('id assignment fills only missing ids and never changes an existing one', () => {
  const plan = [item('keep'), item(undefined), { ...item(undefined), id: '' }, item('keep', undefined, 'Duplicate')];
  const assigned = assignPlanItemIds(plan);
  assert.equal(assigned[0], plan[0]);
  assert.equal(assigned[3], plan[3], 'a duplicate id is left for validation to reject');
  assert.match((assigned[1] as { id: string }).id, /^item-[0-9a-f]{12}$/);
  assert.notEqual((assigned[1] as { id: string }).id, (assigned[2] as { id: string }).id);
  const normalized = normalizePlanItems(plan);
  assert.equal(normalized.ok, false);

  const taken: string[][] = [];
  assignPlanItemIds([item(undefined), item('existing')], ids => { taken.push([...ids]); return 'fresh'; });
  assert.deepEqual(taken, [['existing']], 'a generated id avoids every existing id');
});

test('model-written plans are repaired: repeated ids replaced, dangling, self and cyclic references dropped', () => {
  const repaired = preparePlanItemsFromModel([
    item('a', ['a', 'missing']),
    item('b', ['a', 'a']),
    item('b', ['a'], 'Copy'),
    item('c', ['d']),
    item('d', ['c']),
  ]) as Array<{ id: string; dependsOn?: string[] }>;
  assert.deepEqual(repaired.map(entry => entry.dependsOn ?? []).slice(0, 2), [[], ['a']]);
  assert.match(repaired[2].id, /^item-/, 'the repeated id gets a fresh one');
  assert.equal(validatePlanItemGraph(repaired).valid, true);
  assert.deepEqual(repaired.slice(3).map(entry => entry.dependsOn ?? []), [['d'], []]);
});

const edgesOf = (plan: unknown[]) => (plan as Array<{ id: string; dependsOn?: string[] }>).map(entry => [entry.id, entry.dependsOn]);

test('dependsOn is reduced to direct prerequisites: a chain loses the transitive entry', () => {
  const reduced = reducePlanItemDependencies([item('a'), item('b', ['a']), item('c', ['a', 'b'])]);
  assert.deepEqual(edgesOf(reduced), [['a', undefined], ['b', ['a']], ['c', ['b']]]);
  assert.deepEqual(edgesOf(reducePlanItemDependencies([item('a'), item('b', ['a']), item('c', ['b', 'a'])]))[2], ['c', ['b']],
    'the order of the entries does not matter');
});

test('a diamond keeps both direct prerequisites', () => {
  const plan = [item('a'), item('b', ['a']), item('c', ['a']), item('d', ['b', 'c'])];
  assert.deepEqual(reducePlanItemDependencies(plan), plan);
});

test('a task listing every predecessor of a 5-step chain keeps only its immediate predecessor', () => {
  const plan = [item('s1'), item('s2', ['s1']), item('s3', ['s2']), item('s4', ['s3']), item('s5', ['s1', 's2', 's3', 's4'])];
  assert.deepEqual(edgesOf(reducePlanItemDependencies(plan)), [['s1', undefined], ['s2', ['s1']], ['s3', ['s2']], ['s4', ['s3']], ['s5', ['s4']]]);
  const allPredecessors = [item('s1'), item('s2', ['s1']), item('s3', ['s1', 's2']), item('s4', ['s1', 's2', 's3']), item('s5', ['s1', 's2', 's3', 's4'])];
  assert.deepEqual(edgesOf(reducePlanItemDependencies(allPredecessors)), [['s1', undefined], ['s2', ['s1']], ['s3', ['s2']], ['s4', ['s3']], ['s5', ['s4']]]);
});

test('an already minimal graph is returned unchanged, item for item', () => {
  const plan = [item('ui', ['api', 'docs']), item('schema'), item('api', ['schema']), item('docs'), item('free')];
  const reduced = reducePlanItemDependencies(plan);
  assert.deepEqual(reduced, plan);
  reduced.forEach((entry, index) => assert.equal(entry, plan[index]));
});

test('model-written plans are reduced to direct prerequisites, user-saved plans are stored as written', () => {
  const plan = [item('a'), item('b', ['a']), item('c', ['a', 'b'])];
  assert.deepEqual(edgesOf(preparePlanItemsFromModel(plan)), [['a', undefined], ['b', ['a']], ['c', ['b']]]);
  const normalized = normalizePlanItems(plan);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.ok && JSON.stringify(normalized.plan), JSON.stringify(plan));
});

test('dependencies resolve to issue numbers by position, including forward references', () => {
  const plan = [item('ui', ['api', 'schema']), item('schema'), item('api', ['schema']), item('docs', ['missing-issue'])];
  assert.deepEqual(resolvePlanItemIssueDependencies(plan, [11, 12, 13, undefined]), [
    { index: 0, itemId: 'ui', issueNumber: 11, dependsOnIssues: [13, 12], unresolvedDependsOn: [] },
    { index: 1, itemId: 'schema', issueNumber: 12, dependsOnIssues: [], unresolvedDependsOn: [] },
    { index: 2, itemId: 'api', issueNumber: 13, dependsOnIssues: [12], unresolvedDependsOn: [] },
    { index: 3, itemId: 'docs', issueNumber: null, dependsOnIssues: [], unresolvedDependsOn: ['missing-issue'] },
  ]);
});

test('a prerequisite whose publication failed stays recorded as unresolved', () => {
  const plan = [item('a'), item('b', ['a']), item('c', ['b', 'a'])];
  const resolved = resolvePlanItemIssueDependencies(plan, [undefined, 12, 13]);
  assert.deepEqual(resolved.map(entry => [entry.itemId, entry.dependsOnIssues, entry.unresolvedDependsOn]),
    [['a', [], []], ['b', [], ['a']], ['c', [12], ['a']]]);
  const stored = serializeDependsOnIssues(resolved[2].dependsOnIssues, resolved[2].unresolvedDependsOn);
  assert.equal(stored, '[12,{"unresolved":"a"}]');
  // Issue-number readers see only the published prerequisite; the unresolved one stays visible.
  assert.deepEqual(parseDependsOnIssues(stored), [12]);
  assert.deepEqual(parseUnresolvedDependsOn(stored), ['a']);
  assert.deepEqual(parseUnresolvedDependsOn('[12]'), []);
  assert.deepEqual(parseUnresolvedDependsOn(null), []);
  assert.deepEqual(withPlanIssueDependencies({ issue_number: 13, depends_on_issues: stored }).depends_on_issues, [12]);
});

test('stored prerequisites parse leniently; rows from before the column read as none', () => {
  assert.deepEqual(parseDependsOnIssues('[3,5]'), [3, 5]);
  assert.deepEqual(parseDependsOnIssues(null), []);
  assert.deepEqual(parseDependsOnIssues('not json'), []);
  assert.deepEqual(parseDependsOnIssues('[0,-1,"2",4]'), [4]);
  assert.deepEqual(withPlanIssueDependencies({ issue_number: 9 }), { issue_number: 9, plan_item_id: null, depends_on_issues: [] });
  assert.deepEqual(withPlanIssueDependencies({ issue_number: 9, plan_item_id: 'a', depends_on_issues: '[8]' }),
    { issue_number: 9, plan_item_id: 'a', depends_on_issues: [8] });
});
