import type { Knex } from 'knex';
import { summarizeTask } from './listSummaries.js';
import { TERMINAL_TASK_STATES } from './goalTaskDetail.js';
import { applyAssigneeSelection, type AssigneeSelection } from '../routes/taskAssignees.js';

type TaskSummary = Record<string, unknown>;

export type TaskListingState = 'active' | 'completed' | 'failed' | 'recent' | 'all';

export interface TaskSummaryQuery {
  repositories: string[];
  state: TaskListingState;
  principalUserId: string;
  offset: number;
  limit: number;
  /** Only terminal tasks at or after this instant are included for recent/all. */
  since?: Date | number | string;
  /** `created` preserves list_tasks; `activity` powers the work overview. */
  order?: 'created' | 'activity';
  /** Only tasks this assignee selection lists, read from the stored projection as the task list API does. */
  assignee?: AssigneeSelection | null;
}

const TASK_COLUMNS = ['task_id', 'repository', 'issue_number', 'task_type', 'created_at'] as const;

/**
 * Hide other users' private goal tasks. A goal's current task is visible only
 * to that goal's owner, and a goal-typed task with no owning goal is visible to
 * nobody. Shared by every tool that lists tasks so one predicate governs them.
 */
export function applyTaskVisibility(db: Knex, query: Knex.QueryBuilder, userId: string): Knex.QueryBuilder {
  query.whereNotIn('tasks.task_id', db('goals').select('current_task_id').whereNot('owner_id', userId).whereNotNull('current_task_id'));
  query.andWhere(builder => builder.whereNot('tasks.task_type', 'goal').orWhereIn('tasks.task_id', db('goals').select('current_task_id').where({ owner_id: userId })));
  return query;
}

function databaseTimestamp(value: Date | number | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function applyStateFilter(
  db: Knex,
  query: Knex.QueryBuilder,
  state: TaskListingState,
  since?: Date | number | string,
): void {
  const latestState = db('task_history').select('state')
    .where('task_id', db.ref('tasks.task_id')).orderBy('history_id', 'desc').limit(1);
  const latestTimestamp = db('task_history').select('timestamp')
    .where('task_id', db.ref('tasks.task_id')).orderBy('history_id', 'desc').limit(1);
  const terminalPlaceholders = TERMINAL_TASK_STATES.map(() => '?').join(', ');
  if (state === 'active') {
    query.whereRaw(`coalesce((?), 'pending') not in (${terminalPlaceholders})`, [latestState, ...TERMINAL_TASK_STATES]);
  } else if (state === 'completed' || state === 'failed') {
    query.whereRaw('(?) = ?', [latestState, state]);
  } else if (state === 'recent') {
    query.whereRaw(`(?) in (${terminalPlaceholders})`, [latestState, ...TERMINAL_TASK_STATES]);
    if (since !== undefined) query.whereRaw('julianday((?)) >= julianday(?)', [latestTimestamp, databaseTimestamp(since)]);
  } else if (state === 'all' && since !== undefined) {
    query.andWhere(builder => builder
      .whereRaw(`coalesce((?), 'pending') not in (${terminalPlaceholders})`, [latestState, ...TERMINAL_TASK_STATES])
      .orWhere(inner => inner
        .whereRaw(`(?) in (${terminalPlaceholders})`, [latestState, ...TERMINAL_TASK_STATES])
        .whereRaw('julianday((?)) >= julianday(?)', [latestTimestamp, databaseTimestamp(since)])));
  }
}

async function markMergedTaskSummaries(db: Knex, tasks: TaskSummary[]): Promise<void> {
  const byRepository = new Map<string, TaskSummary[]>();
  for (const task of tasks) {
    if (typeof task.repository !== 'string' || !Number.isSafeInteger(Number(task.pr_number))) continue;
    const group = byRepository.get(task.repository) ?? [];
    group.push(task);
    byRepository.set(task.repository, group);
  }
  for (const [repository, group] of byRepository) {
    const numbers = [...new Set(group.map(task => Number(task.pr_number)).filter(number => number > 0))];
    if (!numbers.length) continue;
    const rows = await db('notification_pull_request_state').where({ repository })
      .whereIn('pr_number', numbers).whereNotNull('merged_at').select('pr_number');
    const merged = new Set(rows.map(row => Number(row.pr_number)));
    for (const task of group) if (merged.has(Number(task.pr_number))) task.pr_state = 'merged';
  }
}

/**
 * Query the compact summaries used by list_tasks and task-centric joined views.
 * Repository scoping, lifecycle selection and private-goal visibility live here
 * so consumers cannot accidentally expose a different task set.
 */
export async function queryTaskSummaries(db: Knex, options: TaskSummaryQuery): Promise<TaskSummary[]> {
  // Correlated indexed lookups avoid materializing history for unrelated tasks.
  const latestHistoryId = db('task_history').select('history_id')
    .where('task_id', db.ref('tasks.task_id')).orderBy('history_id', 'desc').limit(1);
  const taskStart = db('task_history').min('timestamp')
    .where('task_id', db.ref('tasks.task_id')).whereIn('state', ['processing', 'claude_execution', 'post_processing']);
  // Keep PR state and agent/model fields from the same latest relation row.
  const latestPlanIssueId = db('plan_issues').select('id')
    .where('task_id', db.ref('tasks.task_id')).orderBy('id', 'desc').limit(1);
  const query = db('tasks').whereIn('tasks.repository', options.repositories);
  applyTaskVisibility(db, query, options.principalUserId);
  applyStateFilter(db, query, options.state, options.since);
  if (options.assignee) applyAssigneeSelection(db, query, options.assignee, 'tasks.task_id');

  const selected = query.select(...TASK_COLUMNS, 'model_name', 'pr_number', 'initial_job_data');
  // list_tasks historically pages before relation lookups and orders by creation.
  // Keep that SQL shape to preserve its response exactly.
  if ((options.order ?? 'created') === 'created') {
    selected.orderBy('tasks.created_at', 'desc').orderBy('tasks.task_id', 'desc')
      .offset(options.offset).limit(options.limit);
  }
  const taskPage = selected.as('tasks');
  const rowsQuery = db.from(taskPage)
    .leftJoin('task_history as latest_history', 'latest_history.history_id', db.raw('(?)', [latestHistoryId]))
    .leftJoin('plan_issues as task_plan_issue', 'task_plan_issue.id', db.raw('(?)', [latestPlanIssueId]))
    .select('tasks.*', 'latest_history.state', 'latest_history.timestamp as updated_at', 'latest_history.reason as state_reason',
      'latest_history.metadata as state_metadata', taskStart.as('started_at'),
      'task_plan_issue.pr_number as plan_pr_number', 'task_plan_issue.status as plan_issue_status',
      'task_plan_issue.agent_alias as plan_agent_alias', 'task_plan_issue.model_name as plan_model_name');
  if ((options.order ?? 'created') === 'created') {
    rowsQuery.orderBy('tasks.created_at', 'desc').orderBy('tasks.task_id', 'desc');
  } else {
    rowsQuery.orderByRaw('julianday(coalesce(latest_history.timestamp, tasks.created_at)) desc')
      .orderBy('tasks.task_id', 'desc').offset(options.offset).limit(options.limit);
  }
  const rows = await rowsQuery;
  const summaries = rows.map(row => summarizeTask(row));
  await markMergedTaskSummaries(db, summaries);
  return summaries;
}
