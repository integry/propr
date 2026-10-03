import type { Knex } from 'knex';
import type { RedisClientType } from 'redis';
import { goalDetail, type GoalDetailRow } from '../mcp/goalTaskDetail.js';
import { markMergedPullRequests } from './pullRequestMergeState.js';

/**
 * Lifecycle filters shared by the REST goal list (used by the CLI) and MCP `list_goals`.
 * `active` is every goal without a terminal result; `running` and `paused` narrow it by the
 * requested lifecycle, and the terminal values match the persisted `result_state`.
 */
export const GOAL_LIST_STATES = ['active', 'running', 'paused', 'completed', 'failed', 'cancelled', 'all'] as const;
export type GoalListState = typeof GOAL_LIST_STATES[number];

export function isGoalListState(value: unknown): value is GoalListState {
  return typeof value === 'string' && (GOAL_LIST_STATES as readonly string[]).includes(value);
}

export function applyGoalLifecycleFilter(query: Knex.QueryBuilder, state: GoalListState | undefined): Knex.QueryBuilder {
  if (state === 'active') query.whereNull('result_state');
  else if (state === 'running' || state === 'paused') query.whereNull('result_state').where('desired_state', state);
  else if (state === 'completed' || state === 'failed' || state === 'cancelled') query.where('result_state', state);
  return query;
}

/**
 * Narration, task progress, checkpoint, pending-input and pull request detail for one owned goal.
 * The REST inspect endpoint and MCP `get_goal` both read it here so CLI and MCP status agree.
 */
export function inspectGoalDetail(
  deps: { db: Knex; redisClient: RedisClientType },
  row: GoalDetailRow,
): Promise<Record<string, unknown>> {
  return goalDetail(deps, row, (repository, items, fields) => markMergedPullRequests(deps.db, repository, items, fields));
}
