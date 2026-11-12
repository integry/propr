import { orderGraphExecution, type EpicAdvancePolicy } from '@propr/core';
import { McpError } from './config.js';

export type EpicExecutionRequest = 'sequential' | 'parallel' | 'graph';
export interface EpicDispatch {
  mode: EpicExecutionRequest;
  advanceOn: EpicAdvancePolicy;
  /** Issues the request dispatches itself: every parallel child, or the head of a chain or graph. */
  dispatchNow: number[];
  /** Issues the queue starts later, in queue order. */
  queued: number[];
  /** A graph execution's in-flight limit (null: unbounded). */
  maxParallel?: number | null;
  /** A graph execution's prerequisites per selected issue. */
  dependsOn?: Map<number, number[]>;
}

/**
 * Pure dispatch policy; schemas deliberately leave new options absent on old replays.
 * Sequential is a chain in publication order with one model; parallel fans every issue out;
 * graph starts the first ready issue (it establishes the epic branch) and lets the queue
 * start the rest as their `dependsOn` prerequisites merge, at most `maxParallel` at once.
 */
export function planEpicDispatch({ issues, planOrder, useEpic, epicExecution, epicAdvanceOn, modelCount, maxParallel, dependencies, mergedIssues }: {
  issues: number[]; planOrder: number[]; useEpic: boolean;
  epicExecution?: EpicExecutionRequest; epicAdvanceOn?: EpicAdvancePolicy; modelCount: number;
  maxParallel?: number;
  /** Each plan issue's recorded prerequisites (from the plan's dependsOn). */
  dependencies?: ReadonlyMap<number, readonly number[]>;
  /** Plan issues that are already merged; they satisfy prerequisites outside the selection. */
  mergedIssues?: ReadonlySet<number>;
}): EpicDispatch {
  if (epicExecution === 'graph' && !useEpic) throw new McpError('INVALID_INPUT', 'epicExecution: "graph" requires useEpic: true; downstream issues branch from the epic branch that holds their prerequisites\' merged work.');
  if (maxParallel !== undefined && epicExecution !== 'graph') throw new McpError('INVALID_INPUT', 'maxParallel applies only to epicExecution: "graph". A sequential epic always runs one issue at a time, and a parallel one starts every issue.');
  const mode = useEpic ? epicExecution ?? 'sequential' : 'parallel';
  const advanceOn = epicAdvanceOn ?? 'merged';
  if (mode === 'parallel') return { mode, advanceOn, dispatchNow: [...issues], queued: [] };
  if (modelCount > 1) throw new McpError('INVALID_INPUT', `${mode === 'graph' ? 'Graph' : 'Sequential'} epics require one model per issue: comparing models would create multiple PRs into the same epic branch. Use epicExecution: "parallel" for model comparisons.`);
  const selected = new Set(issues);
  const ordered = planOrder.filter(number => selected.has(number));
  if (ordered.length !== issues.length) throw new McpError('INVALID_INPUT', 'Selected issues must appear once in plan publication order.');
  if (mode === 'sequential') return { mode, advanceOn, dispatchNow: ordered.slice(0, 1), queued: ordered.slice(1) };
  if (advanceOn !== 'merged') throw new McpError('INVALID_INPUT', 'epicExecution: "graph" advances only on merge (an issue is ready once its prerequisites are merged into the epic branch); omit epicAdvanceOn or use "merged".');
  const dependsOn = new Map(ordered.map(number => [number, [...(dependencies?.get(number) ?? [])]]));
  const graph = orderGraphExecution({ issues: ordered, dependsOn, mergedOutside: mergedIssues ?? new Set() });
  if (graph.order === null) {
    const waits = [...graph.waiting].map(([issue, prerequisites]) => `#${issue} waits for ${prerequisites.map(number => `#${number}`).join(', ')}`);
    throw new McpError('PRECONDITION_FAILED', `No selected issue is ready to start: ${waits.join('; ')}. A prerequisite outside the selection must already be merged.`, 409);
  }
  return { mode, advanceOn, dispatchNow: [graph.head], queued: graph.order.slice(1), maxParallel: maxParallel ?? null, dependsOn };
}
