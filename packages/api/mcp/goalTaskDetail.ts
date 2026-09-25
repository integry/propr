import type { Knex } from 'knex';
import type { RedisClientType } from 'redis';
import { stripGoalAttachmentSection } from '../services/goalAttachmentService.js';
import { getAgentActivity } from './agentActivity.js';
import { compactText, summarizeTask } from './listSummaries.js';

/** Live narration, terminal transitions and operator inputs stay small enough to embed in a detail read. */
const ACTIVITY_LIMIT = 5;
const EVENT_LIMIT = 5;
const TRANSITION_LIMIT = 5;
const RELATED_TASK_LIMIT = 100;
const PULL_REQUEST_LIMIT = 20;
const REASON_LIMIT = 300;
const INPUT_MESSAGE_LIMIT = 1000;

export const TERMINAL_TASK_STATES = ['completed', 'failed', 'cancelled'] as const;

type JsonObject = Record<string, unknown>;
type ActivityDeps = { db: Knex; redisClient: RedisClientType };

export interface GoalDetailRow {
  goal_id: string;
  owner_id: string;
  repository: string;
  current_task_id: string | null;
  desired_state: string | null;
  result_state: string | null;
  pause_confirmed_at: string | null;
  resume_requested: number | boolean | null;
  final_pr_number: number | null;
  started_at: string | null;
  created_at: string | null;
  completed_at: string | null;
  checkpoint_interval_minutes: number | null;
  last_checkpoint_at: string | null;
  last_checkpoint_commit_sha: string | null;
  checkpoint_count: number | null;
  checkpoint_error: string | null;
}

export const GOAL_DETAIL_COLUMNS = [
  'goal_id', 'owner_id', 'repository', 'current_task_id', 'desired_state', 'result_state',
  'pause_confirmed_at', 'resume_requested', 'final_pr_number', 'started_at', 'created_at', 'completed_at',
  'checkpoint_interval_minutes', 'last_checkpoint_at', 'last_checkpoint_commit_sha', 'checkpoint_count',
  'checkpoint_error',
];

function timestampMs(value: unknown): number | null {
  if (value == null) return null;
  // Database timestamps without an offset are stored in UTC.
  const candidate = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const parsed = new Date(candidate as string | number | Date).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function elapsedSeconds(start: unknown, end: unknown, now: number): number | null {
  const startMs = timestampMs(start);
  if (startMs === null) return null;
  const endMs = timestampMs(end) ?? now;
  return Math.max(0, Math.round((endMs - startMs) / 1000));
}

/**
 * Newest narration for a goal or task, projected by the same `get_agent_activity` code path so
 * raw reasoning stays excluded and Codex reasoning summaries remain strictly opt-in there.
 * A target whose narration cannot be resolved reports no entries rather than failing the read.
 */
export async function currentActivity(
  deps: ActivityDeps,
  target: { repository: string; goalId?: string; taskId?: string },
  ownerId: string,
): Promise<JsonObject> {
  try {
    const activity = await getAgentActivity(deps, {
      repository: target.repository,
      ...(target.goalId ? { goalId: target.goalId } : { taskId: target.taskId }),
      includeReasoningSummaries: false,
      offset: 0,
      limit: ACTIVITY_LIMIT,
    }, ownerId);
    return { currentFocus: activity.currentFocus, entries: activity.activity, order: activity.order };
  } catch {
    // Narration is best-effort context; a goal without a resolvable task still reads.
    return { currentFocus: null, entries: [], order: 'newest_first' };
  }
}

/** Every task the goal ran or is running, joined to its newest history row. */
function relatedTasks(db: Knex, goal: GoalDetailRow) {
  const latestHistoryId = db('task_history').select('history_id')
    .where('task_id', db.ref('tasks.task_id')).orderBy('history_id', 'desc').limit(1);
  return db('tasks')
    .where('tasks.repository', goal.repository)
    .andWhere(builder => {
      builder.where('tasks.correlation_id', goal.goal_id);
      if (goal.current_task_id) builder.orWhere('tasks.task_id', goal.current_task_id);
    })
    .leftJoin('task_history as latest_history', 'latest_history.history_id', db.raw('(?)', [latestHistoryId]));
}

/** The bounded detail rows, newest first, with the current task always among them. */
function relatedTaskQuery(db: Knex, goal: GoalDetailRow) {
  return relatedTasks(db, goal)
    .select('tasks.task_id', 'tasks.pr_number', 'latest_history.state',
      'latest_history.timestamp as state_timestamp', 'latest_history.reason as state_reason')
    .orderByRaw('case when tasks.task_id = ? then 0 else 1 end', [goal.current_task_id ?? ''])
    .orderBy('tasks.created_at', 'desc').orderBy('tasks.task_id', 'desc').limit(RELATED_TASK_LIMIT);
}

/** Counts over every related task; only the detail arrays are bounded. */
async function taskCounts(db: Knex, goal: GoalDetailRow): Promise<Record<string, number>> {
  const rows = await relatedTasks(db, goal).select('latest_history.state')
    .count({ count: '*' }).groupBy('latest_history.state') as Array<{ state: unknown; count: unknown }>;
  const counts = { total: 0, active: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const row of rows) {
    const count = Number(row.count) || 0;
    counts.total += count;
    if (row.state === 'completed' || row.state === 'failed' || row.state === 'cancelled') counts[row.state] += count;
    else counts.active += count;
  }
  return counts;
}

function transitionOrder(left: JsonObject, right: JsonObject): number {
  return (timestampMs(right.at) ?? 0) - (timestampMs(left.at) ?? 0);
}

function taskProgress(rows: JsonObject[], counts: Record<string, number>): JsonObject {
  const transitions: JsonObject[] = [];
  for (const row of rows) {
    const state = typeof row.state === 'string' ? row.state : 'pending';
    if ((TERMINAL_TASK_STATES as readonly string[]).includes(state)) {
      transitions.push({ taskId: row.task_id, state, at: row.state_timestamp ?? null,
        reason: compactText(row.state_reason, REASON_LIMIT) });
    }
  }
  return { tasks: counts, recentTerminalTransitions: transitions.sort(transitionOrder).slice(0, TRANSITION_LIMIT) };
}

function goalCheckpoint(goal: GoalDetailRow): JsonObject | null {
  const count = Number(goal.checkpoint_count || 0);
  if (!goal.checkpoint_interval_minutes && !goal.last_checkpoint_at && !count && !goal.checkpoint_error) return null;
  return {
    intervalMinutes: goal.checkpoint_interval_minutes ?? null,
    count,
    lastAt: goal.last_checkpoint_at ?? null,
    lastCommitSha: goal.last_checkpoint_commit_sha ?? null,
    error: compactText(goal.checkpoint_error, REASON_LIMIT),
  };
}

/**
 * A confirmed pause without a queued resume is the only durable "your turn" signal. `get_goal` and
 * the activity digest both decide it here, so they cannot disagree about a goal that is resuming.
 */
export function isAwaitingOperator(goal: Pick<GoalDetailRow, 'result_state' | 'desired_state' | 'pause_confirmed_at' | 'resume_requested'>): boolean {
  return !goal.result_state && goal.desired_state === 'paused' && Boolean(goal.pause_confirmed_at) && !goal.resume_requested;
}

/** `isAwaitingOperator` as a query predicate over the `goals` table. */
export function whereAwaitingOperator(builder: Knex.QueryBuilder): Knex.QueryBuilder {
  return builder.whereNull('result_state').where('desired_state', 'paused').whereNotNull('pause_confirmed_at')
    .where(resume => resume.whereNull('resume_requested').orWhere('resume_requested', false));
}

/**
 * Whether the goal is persisted as blocked on the operator, and what it is blocked on. Queued but
 * undelivered operator corrections are reported alongside it so a second correction is not sent blindly.
 */
async function pendingInput(db: Knex, goal: GoalDetailRow): Promise<JsonObject> {
  const [undelivered] = await db('goal_inputs')
    .where({ goal_id: goal.goal_id, owner_id: goal.owner_id, kind: 'input', state: 'pending' })
    .count({ count: '*' });
  const latest = await db('goal_inputs')
    .where({ goal_id: goal.goal_id, owner_id: goal.owner_id, kind: 'input' })
    .orderBy('sequence', 'desc').first('created_at', 'delivered_at');
  const waiting = isAwaitingOperator(goal);
  return {
    waitingForOperator: waiting,
    reason: waiting ? 'paused_awaiting_resume_or_input' : null,
    undeliveredInputs: Number(undelivered?.count ?? 0),
    lastInputAt: latest?.created_at ?? null,
    lastInputDeliveredAt: latest?.delivered_at ?? null,
  };
}

function pullRequestReferences(goal: GoalDetailRow, rows: JsonObject[]): JsonObject[] {
  const references = new Map<number, JsonObject>();
  const finalNumber = Number(goal.final_pr_number);
  if (Number.isSafeInteger(finalNumber) && finalNumber > 0) {
    references.set(finalNumber, { number: finalNumber, state: null, role: 'final' });
  }
  for (const row of rows) {
    const number = Number(row.pr_number);
    if (!Number.isSafeInteger(number) || number <= 0 || references.has(number)) continue;
    references.set(number, { number, state: null, role: 'task', taskId: row.task_id });
  }
  return [...references.values()].slice(0, PULL_REQUEST_LIMIT);
}

/**
 * The live detail behind one goal: what it is doing, what its tasks have already done, whether it
 * is waiting on the operator, and which pull requests it has produced. Every field is bounded.
 */
export async function goalDetail(
  deps: ActivityDeps,
  goal: GoalDetailRow,
  markMerged: (repository: string, items: JsonObject[], fields: { number: string; state: string }) => Promise<void>,
  now = Date.now(),
): Promise<JsonObject> {
  const [rows, counts] = await Promise.all([relatedTaskQuery(deps.db, goal) as Promise<JsonObject[]>, taskCounts(deps.db, goal)]);
  const pullRequests = pullRequestReferences(goal, rows);
  await markMerged(goal.repository, pullRequests, { number: 'number', state: 'state' });
  return {
    currentActivity: await currentActivity(deps, { repository: goal.repository, goalId: goal.goal_id }, goal.owner_id),
    progress: {
      ...taskProgress(rows, counts),
      startedAt: goal.started_at ?? null,
      elapsedSeconds: elapsedSeconds(goal.started_at ?? goal.created_at, goal.completed_at, now),
      checkpoint: goalCheckpoint(goal),
    },
    pendingInput: await pendingInput(deps.db, goal),
    pullRequests,
  };
}

/** Bounded, newest-first operator corrections already persisted for a goal. */
export async function goalInputPage(
  db: Knex,
  goal: { goal_id: string; owner_id: string },
  page: { offset: number; limit: number },
): Promise<JsonObject> {
  const rows = await db('goal_inputs')
    .where({ goal_id: goal.goal_id, owner_id: goal.owner_id, kind: 'input' })
    .orderBy('sequence', 'desc')
    .offset(page.offset).limit(page.limit)
    .select('input_id', 'message', 'display_message', 'attachment_count', 'state', 'created_at', 'delivered_at');
  const inputs = rows.map((row: JsonObject) => {
    const body = typeof row.display_message === 'string'
      ? { message: row.display_message, attachmentCount: Number(row.attachment_count ?? 0) }
      : stripGoalAttachmentSection(typeof row.message === 'string' ? row.message : '');
    return {
      id: row.input_id,
      message: compactText(body.message, INPUT_MESSAGE_LIMIT),
      attachmentCount: body.attachmentCount,
      state: row.state === 'delivered' || row.state === 'undeliverable' ? row.state : 'pending',
      createdAt: row.created_at ?? null,
      deliveredAt: row.delivered_at ?? null,
    };
  });
  return { inputs, order: 'newest_first', nextOffset: rows.length === page.limit ? page.offset + page.limit : null };
}

function taskSummaryQuery(db: Knex, taskId: string) {
  const latestHistoryId = db('task_history').select('history_id')
    .where('task_id', db.ref('tasks.task_id')).orderBy('history_id', 'desc').limit(1);
  const taskStart = db('task_history').min('timestamp')
    .where('task_id', db.ref('tasks.task_id')).whereIn('state', ['processing', 'claude_execution', 'post_processing']);
  const latestPlanIssueId = db('plan_issues').select('id')
    .where('task_id', db.ref('tasks.task_id')).orderBy('id', 'desc').limit(1);
  return db('tasks').where('tasks.task_id', taskId)
    .leftJoin('task_history as latest_history', 'latest_history.history_id', db.raw('(?)', [latestHistoryId]))
    .leftJoin('plan_issues as task_plan_issue', 'task_plan_issue.id', db.raw('(?)', [latestPlanIssueId]))
    .select('tasks.task_id', 'tasks.repository', 'tasks.issue_number', 'tasks.task_type', 'tasks.created_at',
      'tasks.model_name', 'tasks.pr_number', 'tasks.initial_job_data',
      'latest_history.state', 'latest_history.timestamp as updated_at', 'latest_history.reason as state_reason',
      'latest_history.metadata as state_metadata', taskStart.as('started_at'),
      'task_plan_issue.pr_number as plan_pr_number', 'task_plan_issue.status as plan_issue_status',
      'task_plan_issue.agent_alias as plan_agent_alias', 'task_plan_issue.model_name as plan_model_name')
    .first();
}

/**
 * File-change counts only, and only when they are already persisted for this exact task. The cache
 * written by the worktree monitor is read through the caller's Redis client, exactly as the live
 * detail projection reads its own keys. Missing data reads as `null`: an unreported task must
 * never look like a task that changed nothing, and no diff content is returned here.
 */
async function changesSummary(deps: ActivityDeps, taskId: string): Promise<JsonObject | null> {
  let stored: { files?: Array<{ linesAdded?: unknown; linesRemoved?: unknown }>; lastUpdated?: unknown } | null = null;
  try {
    const cached = await deps.redisClient.get(`task:file-changes:${taskId}`);
    stored = typeof cached === 'string' ? JSON.parse(cached) : null;
  } catch {
    return null;
  }
  if (!stored || !Array.isArray(stored.files)) return null;
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const file of stored.files) {
    linesAdded += Number(file.linesAdded) || 0;
    linesRemoved += Number(file.linesRemoved) || 0;
  }
  return { fileCount: stored.files.length, linesAdded, linesRemoved, lastUpdated: stored.lastUpdated ?? null };
}

/** Live detail behind one task: recent events, narration, timing, change counts and its pull request. */
export async function taskDetail(
  deps: ActivityDeps,
  target: { repository: string; taskId: string },
  ownerId: string,
  markMerged: (repository: string, items: JsonObject[], fields: { number: string; state: string }) => Promise<void>,
): Promise<JsonObject> {
  const row = await taskSummaryQuery(deps.db, target.taskId) as JsonObject | undefined;
  const summary = row ? summarizeTask(row) : null;
  const events = await deps.db('task_history').where({ task_id: target.taskId })
    .orderBy('history_id', 'desc').limit(EVENT_LIMIT).select('state', 'reason', 'timestamp');
  const pullRequests = summary?.pr_number
    ? [{ number: summary.pr_number, state: summary.pr_state ?? null }]
    : [];
  if (pullRequests.length) await markMerged(target.repository, pullRequests, { number: 'number', state: 'state' });
  return {
    latestEvents: events.map((event: JsonObject) => ({
      state: event.state, reason: compactText(event.reason, REASON_LIMIT), timestamp: event.timestamp ?? null,
    })),
    currentActivity: await currentActivity(deps, { repository: target.repository, taskId: target.taskId }, ownerId),
    timing: {
      startedAt: summary?.started_at ?? null,
      updatedAt: summary?.updated_at ?? null,
      completedAt: summary?.completed_at ?? null,
      elapsedSeconds: typeof summary?.elapsed_ms === 'number' ? Math.round(summary.elapsed_ms / 1000) : null,
    },
    changesSummary: await changesSummary(deps, target.taskId),
    pullRequest: pullRequests[0] ?? null,
  };
}
