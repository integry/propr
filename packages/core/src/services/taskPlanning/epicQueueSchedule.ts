/**
 * The epic scheduler: which issues of an execution are ready, and which of them
 * to start now. Pure, so the same function decides readiness for the queue's
 * guarded dispatch, for recovery and for every status report.
 *
 * Every execution mode is one graph and one limit:
 * - sequential: a chain in queue order (each issue waits for the one before it), limit 1;
 * - parallel: no edges, no limit;
 * - graph: the plan's `dependsOn` edges, with an optional `max_parallel` limit.
 */
export type EpicExecutionMode = 'sequential' | 'parallel' | 'graph';
export type EpicScheduleIssueState = 'pending' | 'dispatched' | 'done' | 'blocked' | 'skipped';
/** How an issue stands in the schedule, as reported to callers. */
export type EpicScheduleState = 'waiting' | 'ready' | 'in_flight' | 'done' | 'skipped' | 'blocked';

export interface EpicScheduleIssue {
  issueNumber: number;
  position: number;
  state: EpicScheduleIssueState;
  /** Prerequisite issue numbers; the ones outside the execution are satisfied only by `mergedOutside`. */
  dependsOn: readonly number[];
  /** Holds a slot: the queue claimed it (or it is running) and it has not settled. */
  inFlight: boolean;
  /**
   * A skipped issue satisfies its dependents only when the skip said so (a chain always moves on);
   * otherwise its dependents keep waiting on it. Ignored for every other state.
   */
  satisfiesDependents?: boolean;
}

export interface EpicScheduleInput {
  issues: readonly EpicScheduleIssue[];
  /** Prerequisites outside the execution that are merged. */
  mergedOutside?: ReadonlySet<number> | readonly number[];
  /** Most issues in flight at once; null or undefined is unbounded. */
  limit?: number | null;
}

export interface EpicSchedule {
  /** Issues to start now, in queue (publication) order, never more than the free slots. */
  start: number[];
  /** Every ready issue that is not in flight, in queue order (`start` is a prefix). */
  ready: number[];
  /** Issues that hold a slot. */
  inFlight: number[];
  /** Unstarted issues and the prerequisites each still waits for. */
  waiting: Map<number, number[]>;
  /** Slots left after `start` (Infinity when unbounded). */
  freeSlots: number;
}

const settled = (state: EpicScheduleIssueState) => state === 'done' || state === 'skipped';

/** Whether a prerequisite in the execution lets its dependents start: done, or skipped as satisfied. */
export function satisfiesPrerequisite(issue: Pick<EpicScheduleIssue, 'state' | 'satisfiesDependents'>): boolean {
  return issue.state === 'done' || (issue.state === 'skipped' && issue.satisfiesDependents !== false);
}

/** Prerequisites the issue still waits for: an unsatisfied one in the execution, or an unmerged one outside it. */
export function unmetPrerequisites(issue: EpicScheduleIssue, issues: readonly EpicScheduleIssue[],
  mergedOutside: ReadonlySet<number>): number[] {
  return issue.dependsOn.filter(prerequisite => {
    const inExecution = issues.find(candidate => candidate.issueNumber === prerequisite);
    return inExecution ? !satisfiesPrerequisite(inExecution) : !mergedOutside.has(prerequisite);
  });
}

/** The prerequisites an issue waits for that were skipped without satisfying their dependents. */
export function skippedPrerequisites(waitingOn: readonly number[], issues: readonly EpicScheduleIssue[]): number[] {
  return waitingOn.filter(prerequisite => issues.some(candidate => candidate.issueNumber === prerequisite && candidate.state === 'skipped'));
}

export function scheduleEpicIssues({ issues, mergedOutside = [], limit = null }: EpicScheduleInput): EpicSchedule {
  const merged = mergedOutside instanceof Set ? mergedOutside : new Set(mergedOutside as readonly number[]);
  const ordered = [...issues].sort((left, right) => left.position - right.position);
  const inFlight = ordered.filter(issue => issue.inFlight && !settled(issue.state)).map(issue => issue.issueNumber);
  const waiting = new Map<number, number[]>();
  const ready: number[] = [];
  for (const issue of ordered) {
    if (issue.inFlight || issue.state !== 'pending') continue;
    const unmet = unmetPrerequisites(issue, ordered, merged);
    if (unmet.length) waiting.set(issue.issueNumber, unmet);
    else ready.push(issue.issueNumber);
  }
  const slots = limit === null || limit === undefined ? Infinity : Math.max(0, limit - inFlight.length);
  const start = ready.slice(0, slots === Infinity ? ready.length : slots);
  return { start, ready, inFlight, waiting, freeSlots: slots - start.length };
}

/** Each issue's prerequisites in an execution of the given mode; `recorded` holds the graph's own edges. */
export function executionEdges(mode: EpicExecutionMode, issues: ReadonlyArray<{ issueNumber: number; dependsOn?: readonly number[] }>): number[][] {
  if (mode === 'sequential') return issues.map((_, index) => index === 0 ? [] : [issues[index - 1].issueNumber]);
  if (mode === 'parallel') return issues.map(() => []);
  return issues.map(issue => [...(issue.dependsOn ?? [])]);
}

/** The in-flight limit of an execution: one for a chain, none for a parallel fan-out, the stored one for a graph. */
export function executionLimit(mode: EpicExecutionMode, maxParallel: number | null): number | null {
  if (mode === 'sequential') return 1;
  if (mode === 'parallel') return null;
  return maxParallel;
}

/** The reported schedule state of one issue. */
export function epicScheduleState(issue: EpicScheduleIssue, schedule: Pick<EpicSchedule, 'waiting'>): EpicScheduleState {
  if (issue.state === 'done' || issue.state === 'skipped' || issue.state === 'blocked') return issue.state;
  if (issue.inFlight || issue.state === 'dispatched') return 'in_flight';
  return schedule.waiting.has(issue.issueNumber) ? 'waiting' : 'ready';
}

/**
 * Orders a graph execution for its first dispatch: the first ready issue in publication
 * order heads the execution (it establishes the epic branch); the others keep their order.
 * Returns null when no issue is ready, with the prerequisites every issue waits for.
 */
export function orderGraphExecution(input: { issues: readonly number[]; dependsOn: ReadonlyMap<number, readonly number[]>;
  mergedOutside: ReadonlySet<number> }): { order: number[]; head: number } | { order: null; waiting: Map<number, number[]> } {
  const schedule = scheduleEpicIssues({
    issues: input.issues.map((issueNumber, position) => ({ issueNumber, position, state: 'pending', inFlight: false,
      dependsOn: input.dependsOn.get(issueNumber) ?? [] })),
    mergedOutside: input.mergedOutside, limit: 1,
  });
  const [head] = schedule.start;
  if (head === undefined) return { order: null, waiting: schedule.waiting };
  return { order: [head, ...input.issues.filter(issue => issue !== head)], head };
}
