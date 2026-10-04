import type { Knex } from 'knex';
import {
  boundGoalBlockerText,
  projectGoalAttention,
  type GoalAttention,
  type GoalBlockerGoalState,
  type GoalBlockerRow,
} from '@propr/shared';

/**
 * The one read path behind every goal attention surface: the goal console,
 * `get_goal`, the attention listing, activity digests and the dashboard. Each
 * loads the goal row and its open `goal_blockers` rows here and projects them
 * with `projectGoalAttention`, so no two surfaces can disagree about whether a
 * goal is waiting on its operator.
 */

/** The `goals` columns `projectGoalAttention` reads. */
export const GOAL_ATTENTION_COLUMNS = [
  'goal_id', 'repository', 'current_task_id', 'agent_type', 'desired_state', 'result_state',
  'pause_confirmed_at', 'resume_requested', 'run_generation', 'run_claim', 'session_id',
] as const;

const BLOCKER_COLUMNS = [
  'blocker_id', 'goal_id', 'repository', 'task_id', 'run_generation', 'run_claim', 'session_id', 'turn_id',
  'provider', 'category', 'source', 'summary', 'questions', 'response_actions', 'status',
  'first_observed_at', 'last_observed_at',
];

const ID_CHUNK = 200;

/** A confirmed pause with no queued resume, as a query predicate over `goals`. */
export function whereGoalPausedAwaitingOperator(builder: Knex.QueryBuilder, table = 'goals'): Knex.QueryBuilder {
  return builder.whereNull(`${table}.result_state`).where(`${table}.desired_state`, 'paused')
    .whereNotNull(`${table}.pause_confirmed_at`)
    .where(resume => resume.whereNull(`${table}.resume_requested`).orWhere(`${table}.resume_requested`, false));
}

/**
 * Goals with at least one open blocker, as a query predicate over `goals`. It is
 * the candidate filter for bounded listings; `projectGoalAttention` still makes
 * the final call (for example a session the goal has since replaced).
 */
export function whereGoalNeedsAttention(db: Knex, builder: Knex.QueryBuilder, table = 'goals'): Knex.QueryBuilder {
  return builder.whereNull(`${table}.result_state`).where(attention => attention
    .where(paused => whereGoalPausedAwaitingOperator(paused, table))
    .orWhere(provider => provider.where(`${table}.desired_state`, 'running').whereExists(
      db('goal_blockers').select(db.raw('1'))
        .whereRaw(`goal_blockers.goal_id = ${table}.goal_id`)
        .where('goal_blockers.status', 'open')
        .whereRaw(`goal_blockers.run_claim = ${table}.run_claim`)
        .whereRaw(`goal_blockers.run_generation = ${table}.run_generation`),
    )));
}

/** Open blocker rows for these goals, scoped to their owner. */
async function openBlockerRows(db: Knex, ownerId: string, goalIds: string[]): Promise<Map<string, GoalBlockerRow[]>> {
  const byGoal = new Map<string, GoalBlockerRow[]>();
  for (let index = 0; index < goalIds.length; index += ID_CHUNK) {
    const rows = await db('goal_blockers')
      .where({ owner_id: ownerId, status: 'open' })
      .whereIn('goal_id', goalIds.slice(index, index + ID_CHUNK))
      .orderBy('first_observed_at', 'asc').orderBy('blocker_id', 'asc')
      .select(BLOCKER_COLUMNS) as GoalBlockerRow[];
    for (const row of rows) byGoal.set(row.goal_id, [...byGoal.get(row.goal_id) ?? [], row]);
  }
  return byGoal;
}

/** Project attention for owned goal rows that were already loaded. */
export async function loadGoalAttention(
  db: Knex,
  ownerId: string,
  goals: readonly GoalBlockerGoalState[],
): Promise<Map<string, GoalAttention>> {
  const ids = [...new Set(goals.map(goal => goal.goal_id))];
  const rows = ids.length ? await openBlockerRows(db, ownerId, ids) : new Map<string, GoalBlockerRow[]>();
  return new Map(goals.map(goal => [goal.goal_id, projectGoalAttention(goal, rows.get(goal.goal_id) ?? [])]));
}

/** Attention for one owned goal row. */
export async function goalAttention(db: Knex, ownerId: string, goal: GoalBlockerGoalState): Promise<GoalAttention> {
  return (await loadGoalAttention(db, ownerId, [goal])).get(goal.goal_id)!;
}

export interface GoalAttentionListRow extends GoalBlockerGoalState {
  title: string | null;
  objective: string | null;
  updated_at: unknown;
}

export interface GoalAttentionEntry {
  goal: GoalAttentionListRow;
  attention: GoalAttention;
}

/**
 * Owned goals waiting on their operator, newest goal first and bounded. Ordered
 * by creation rather than `updated_at`, which every heartbeat moves, so pages stay stable. `repositories`
 * is the caller's authorized scope; `null` means every repository the owner has.
 * `hasMore` reports whether another page exists.
 */
export async function listGoalsNeedingAttention(
  db: Knex,
  options: { ownerId: string; repositories: string[] | null; offset: number; limit: number },
): Promise<{ entries: GoalAttentionEntry[]; hasMore: boolean }> {
  if (options.repositories && options.repositories.length === 0) return { entries: [], hasMore: false };
  const query = db('goals').where('goals.owner_id', options.ownerId);
  if (options.repositories) query.whereIn('goals.repository', options.repositories);
  whereGoalNeedsAttention(db, query);
  const rows = await query
    .select([...GOAL_ATTENTION_COLUMNS.map(column => `goals.${column}`), 'goals.title', 'goals.objective', 'goals.updated_at'])
    .orderBy('goals.created_at', 'desc').orderBy('goals.goal_id', 'desc')
    .offset(options.offset).limit(options.limit + 1) as GoalAttentionListRow[];
  const page = rows.slice(0, options.limit);
  const attention = await loadGoalAttention(db, options.ownerId, page);
  const entries = page.flatMap(goal => {
    const projected = attention.get(goal.goal_id)!;
    return projected.waitingForOperator ? [{ goal, attention: projected }] : [];
  });
  return { entries, hasMore: rows.length > options.limit };
}

/** One attention listing entry, shared by REST, MCP and the CLI. Goal text is untrusted data. */
export function goalAttentionSummary({ goal, attention }: GoalAttentionEntry) {
  return {
    goalId: goal.goal_id,
    repository: goal.repository,
    title: goal.title || boundGoalBlockerText(goal.objective, 120) || null,
    taskId: goal.current_task_id ?? null,
    desiredState: goal.desired_state,
    waitingForOperator: attention.waitingForOperator,
    reason: attention.reason,
    blockers: attention.blockers,
  };
}
