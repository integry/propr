import assert from 'node:assert/strict';
import { test } from 'node:test';
import { epicScheduleState, executionEdges, executionLimit, orderGraphExecution, scheduleEpicIssues,
  type EpicScheduleIssue, type EpicScheduleIssueState } from '../src/services/taskPlanning/epicQueueSchedule.js';

/** Issues in queue order; `[number, state, dependsOn, inFlight]`. */
function issues(...rows: Array<[number, EpicScheduleIssueState, number[]?, boolean?]>): EpicScheduleIssue[] {
  return rows.map(([issueNumber, state, dependsOn = [], inFlight = state === 'dispatched'], position) =>
    ({ issueNumber, position, state, dependsOn, inFlight }));
}

// Diamond: A(1) -> B(2), C(3) -> D(4).
const diamond = (states: EpicScheduleIssueState[]) => issues([1, states[0]], [2, states[1], [1]], [3, states[2], [1]], [4, states[3], [2, 3]]);

test('a diamond starts A alone, then B and C together, then D once both merged', () => {
  assert.deepEqual(scheduleEpicIssues({ issues: diamond(['pending', 'pending', 'pending', 'pending']), limit: 2 }).start, [1]);
  const afterA = scheduleEpicIssues({ issues: diamond(['done', 'pending', 'pending', 'pending']), limit: 2 });
  assert.deepEqual(afterA.start, [2, 3]);
  assert.deepEqual([...afterA.waiting], [[4, [2, 3]]]);
  const afterB = scheduleEpicIssues({ issues: diamond(['done', 'done', 'dispatched', 'pending']), limit: 2 });
  assert.deepEqual(afterB.start, [], 'D still waits for C');
  assert.deepEqual([...afterB.waiting], [[4, [3]]]);
  assert.deepEqual(scheduleEpicIssues({ issues: diamond(['done', 'done', 'done', 'pending']), limit: 2 }).start, [4]);
});

test('a limit lower than the ready issues starts the first ones in publication order and replenishes as slots free', () => {
  const independent = (states: EpicScheduleIssueState[]) => issues(...states.map((state, index) => [index + 10, state] as [number, EpicScheduleIssueState]));
  const first = scheduleEpicIssues({ issues: independent(['pending', 'pending', 'pending', 'pending']), limit: 2 });
  assert.deepEqual([first.start, first.ready, first.freeSlots], [[10, 11], [10, 11, 12, 13], 0]);
  // Two in flight hold both slots.
  assert.deepEqual(scheduleEpicIssues({ issues: independent(['dispatched', 'dispatched', 'pending', 'pending']), limit: 2 }).start, []);
  // One merged: exactly one replacement, the earliest ready issue.
  assert.deepEqual(scheduleEpicIssues({ issues: independent(['done', 'dispatched', 'pending', 'pending']), limit: 2 }).start, [12]);
  // No limit: everything ready starts.
  assert.deepEqual(scheduleEpicIssues({ issues: independent(['pending', 'pending', 'pending', 'pending']) }).start, [10, 11, 12, 13]);
});

test('a blocked prerequisite keeps its dependents waiting on it while an independent branch runs', () => {
  const graph = issues([1, 'blocked', [], true], [2, 'pending', [1]], [3, 'pending']);
  const schedule = scheduleEpicIssues({ issues: graph, limit: 2 });
  assert.deepEqual(schedule.start, [3]);
  assert.deepEqual([...schedule.waiting], [[2, [1]]]);
  assert.equal(epicScheduleState(graph[1], schedule), 'waiting');
  assert.equal(epicScheduleState(graph[0], schedule), 'blocked');
  assert.equal(epicScheduleState(graph[2], schedule), 'ready');
});

test('a prerequisite outside the execution is satisfied only once merged; out-of-band runs hold a slot', () => {
  const graph = issues([2, 'pending', [99]], [3, 'pending', [], true]);
  assert.deepEqual(scheduleEpicIssues({ issues: graph, limit: 2 }).start, []);
  assert.deepEqual([...scheduleEpicIssues({ issues: graph, limit: 2 }).waiting], [[2, [99]]]);
  assert.deepEqual(scheduleEpicIssues({ issues: graph, limit: 2, mergedOutside: [99] }).start, [2]);
  assert.deepEqual(scheduleEpicIssues({ issues: graph, limit: 1, mergedOutside: new Set([99]) }).start, []);
});

test('sequential is a chain with a limit of one and parallel is a graph without edges', () => {
  const items = [{ issueNumber: 10 }, { issueNumber: 30 }, { issueNumber: 40 }];
  assert.deepEqual(executionEdges('sequential', items), [[], [10], [30]]);
  assert.deepEqual(executionEdges('parallel', items), [[], [], []]);
  assert.deepEqual(executionEdges('graph', [{ issueNumber: 1 }, { issueNumber: 2, dependsOn: [1] }]), [[], [1]]);
  assert.deepEqual([executionLimit('sequential', 5), executionLimit('parallel', 5), executionLimit('graph', 3), executionLimit('graph', null)],
    [1, null, 3, null]);
  const chain = (states: EpicScheduleIssueState[]) => {
    const edges = executionEdges('sequential', items);
    return scheduleEpicIssues({ issues: items.map((item, position) => ({ ...item, position, state: states[position],
      dependsOn: edges[position], inFlight: states[position] === 'dispatched' })), limit: 1 });
  };
  // The chain starts its first unsettled issue, exactly the sequential head, and never a second one.
  assert.deepEqual(chain(['pending', 'pending', 'pending']).start, [10]);
  assert.deepEqual(chain(['dispatched', 'pending', 'pending']).start, []);
  assert.deepEqual(chain(['done', 'pending', 'pending']).start, [30]);
  assert.deepEqual(chain(['skipped', 'done', 'pending']).start, [40]);
});

test('a graph execution is headed by its first ready issue, keeping publication order otherwise', () => {
  const dependsOn = new Map([[10, [99]], [20, []], [30, [10]]]);
  assert.deepEqual(orderGraphExecution({ issues: [10, 20, 30], dependsOn, mergedOutside: new Set() }), { order: [20, 10, 30], head: 20 });
  assert.deepEqual(orderGraphExecution({ issues: [10, 20, 30], dependsOn, mergedOutside: new Set([99]) }), { order: [10, 20, 30], head: 10 });
  const none = orderGraphExecution({ issues: [10, 30], dependsOn, mergedOutside: new Set() });
  assert.equal(none.order, null);
  assert.deepEqual(none.order === null ? [...none.waiting] : [], [[10, [99]], [30, [10]]]);
});

/** The reported states of a schedule: `[issue, schedule state, waitingOn]` per issue. */
function report(rows: EpicScheduleIssue[], options: { limit?: number | null; inOrder?: boolean } = {}) {
  const schedule = scheduleEpicIssues({ issues: rows, ...options });
  return { schedule, states: rows.map(row => [row.issueNumber, epicScheduleState(row, schedule), schedule.waiting.get(row.issueNumber) ?? []]) };
}

test('sequential: an issue behind a skipped predecessor waits on the unfinished issue further up the chain', () => {
  const items = [{ issueNumber: 3557 }, { issueNumber: 3558 }, { issueNumber: 3559 }, { issueNumber: 3560 }];
  const edges = executionEdges('sequential', items);
  const chain = (states: EpicScheduleIssueState[], inFlight: boolean[]) => items.map((item, position) => ({ ...item, position,
    state: states[position], dependsOn: edges[position], inFlight: inFlight[position], satisfiesDependents: true }));
  // The head is in flight: 3558 waits on it, and 3560 (behind the skipped 3559) waits on 3558, not ready.
  const running = report(chain(['dispatched', 'pending', 'skipped', 'pending'], [true, false, false, false]), { limit: 1, inOrder: true });
  assert.deepEqual(running.states, [[3557, 'in_flight', []], [3558, 'waiting', [3557]], [3559, 'skipped', []], [3560, 'waiting', [3558]]]);
  assert.deepEqual(running.schedule.ready, []);
  // The head becomes blocked without settling: its slot frees, yet 3560 still never starts before 3558.
  for (const options of [{ limit: 1, inOrder: true }, { limit: 1 }, { limit: null }]) {
    const blocked = report(chain(['blocked', 'pending', 'skipped', 'pending'], [false, false, false, false]), options);
    assert.deepEqual(blocked.schedule.start, [], JSON.stringify(options));
    assert.deepEqual(blocked.states, [[3557, 'blocked', []], [3558, 'waiting', [3557]], [3559, 'skipped', []], [3560, 'waiting', [3558]]]);
  }
  // Once 3558 is done, 3560 is next.
  assert.deepEqual(report(chain(['done', 'done', 'skipped', 'pending'], [false, false, false, false]), { limit: 1, inOrder: true }).schedule.start, [3560]);
  // Consecutive skips are followed all the way up.
  const skips = report(chain(['blocked', 'skipped', 'skipped', 'pending'], [false, false, false, false]), { limit: 1, inOrder: true });
  assert.deepEqual(skips.states[3], [3560, 'waiting', [3557]]);
});

test('sequential: an issue done out of order does not let a later issue overtake an unfinished earlier one', () => {
  const items = [{ issueNumber: 1 }, { issueNumber: 2 }, { issueNumber: 3 }];
  const edges = executionEdges('sequential', items);
  const rows = items.map((item, position) => ({ ...item, position, state: (['blocked', 'done', 'pending'] as const)[position],
    dependsOn: edges[position], inFlight: false, satisfiesDependents: true }));
  const { schedule, states } = report(rows, { limit: 1, inOrder: true });
  assert.deepEqual(schedule.start, []);
  assert.deepEqual(states[2], [3, 'waiting', [1]]);
  // Without the in-order guard (a graph), a done prerequisite is enough.
  assert.deepEqual(report(rows, { limit: 1 }).schedule.start, [3]);
});

test('graph: a prerequisite skipped as satisfying stands in for its own unfinished prerequisites, transitively', () => {
  // 1 -> 2 (skipped, satisfies) -> 3 (skipped, satisfies) -> 4; 5 independent.
  const graph = (head: EpicScheduleIssueState, inFlight: boolean): EpicScheduleIssue[] => [
    { issueNumber: 1, position: 0, state: head, dependsOn: [], inFlight },
    { issueNumber: 2, position: 1, state: 'skipped', dependsOn: [1], inFlight: false, satisfiesDependents: true },
    { issueNumber: 3, position: 2, state: 'skipped', dependsOn: [2], inFlight: false, satisfiesDependents: true },
    { issueNumber: 4, position: 3, state: 'pending', dependsOn: [3], inFlight: false },
    { issueNumber: 5, position: 4, state: 'pending', dependsOn: [], inFlight: false },
  ];
  const running = report(graph('dispatched', true), { limit: 2 });
  assert.deepEqual(running.schedule.start, [5]);
  assert.deepEqual(running.states[3], [4, 'waiting', [1]]);
  // The head becomes blocked: 4 still waits on it, and only the independent issue starts.
  const blocked = report(graph('blocked', false), { limit: 2 });
  assert.deepEqual(blocked.schedule.start, [5]);
  assert.deepEqual(blocked.states[3], [4, 'waiting', [1]]);
  assert.deepEqual(report(graph('done', false), { limit: 2 }).schedule.start, [4, 5]);
  // An unmerged prerequisite outside the execution behind a satisfying skip is named too.
  const outside: EpicScheduleIssue[] = [
    { issueNumber: 2, position: 0, state: 'skipped', dependsOn: [99], inFlight: false, satisfiesDependents: true },
    { issueNumber: 4, position: 1, state: 'pending', dependsOn: [2], inFlight: false },
  ];
  assert.deepEqual([...scheduleEpicIssues({ issues: outside }).waiting], [[4, [99]]]);
  assert.deepEqual(scheduleEpicIssues({ issues: outside, mergedOutside: [99] }).start, [4]);
  // A skip that does not satisfy its dependents is still the one named.
  const unsatisfied = graph('pending', false).map(issue => issue.issueNumber === 3 ? { ...issue, satisfiesDependents: false } : issue);
  assert.deepEqual(scheduleEpicIssues({ issues: unsatisfied }).waiting.get(4), [3]);
});

test('a dependency cycle through satisfying skips terminates', () => {
  const cycle: EpicScheduleIssue[] = [
    { issueNumber: 1, position: 0, state: 'skipped', dependsOn: [2], inFlight: false, satisfiesDependents: true },
    { issueNumber: 2, position: 1, state: 'skipped', dependsOn: [1], inFlight: false, satisfiesDependents: true },
    { issueNumber: 3, position: 2, state: 'pending', dependsOn: [1], inFlight: false },
  ];
  assert.deepEqual(scheduleEpicIssues({ issues: cycle }).start, [3]);
});
