import type { Knex } from 'knex';
import { compactText, summarizeTask } from './listSummaries.js';
import {
  DIGEST_TEXT_LIMIT, TASK_COLUMNS, TERMINAL_TASK_STATES,
  classifyTaskState, githubUrl, inboxReference, isOperatorRelevant, isoTimestamp,
  latestPlanIssue, line, numericKey, orderByNewest, parseJsonObject, positiveNumber,
  reference, whereWithinWindow, withinWindow,
  type InboxRow, type ResolvedWindow, type Row,
} from './activityDigest.js';

/**
 * Window-bounded collectors that build the `get_recent_activity` timeline, and
 * the projection of an Inbox receipt into it. Each collector reads one
 * repository-bounded slice of a table ProPR already persists; authorization and
 * tool wiring stay in `toolsActivity.ts`.
 */

/** Rows a single recent-activity source may contribute before the merge. */
export const MAX_TIMELINE_ROWS = 500;

/** A merged timeline entry; `id` only orders ties and is dropped on the way out. */
export interface TimelineEntry {
  id: string;
  occurredAt: string;
  kind: string;
  repository: string | null;
  summary: string | null;
  outcome: string;
  reference: Row;
  url?: string;
}

export interface TimelineScope {
  db: Knex;
  owner: string;
  repositories: string[];
  window: ResolvedWindow;
  budget: number;
  /** Applies the same task visibility predicate `list_tasks` uses. */
  visibility: (query: Knex.QueryBuilder) => void;
}

function terminalTaskEntry(row: Row, now: number): TimelineEntry | null {
  const occurredAt = isoTimestamp(row.updated_at);
  if (!occurredAt) return null;
  const summary = summarizeTask(row, now);
  const metadata = parseJsonObject(row.state_metadata);
  const job = parseJsonObject(row.initial_job_data);
  const commandMode = typeof metadata.commandMode === 'string' ? metadata.commandMode
    : typeof job.commandMode === 'string' ? job.commandMode : null;
  const state = classifyTaskState(row.state);
  const pullRequest = positiveNumber(summary.pr_number);
  const issueNumber = positiveNumber(summary.issue_number);
  const stopReason = typeof metadata.ultrafixStopReason === 'string' && metadata.ultrafixStopReason.trim()
    ? metadata.ultrafixStopReason.trim() : null;
  const review = row.task_type === 'review' || commandMode === 'review';
  const forPr = pullRequest ? ` for PR #${pullRequest}` : '';
  const kind = stopReason ? 'ultrafix' : review ? 'review' : 'task';
  // A completed review is "posted": the review comment is the thing an
  // operator looks for, not the task that produced it.
  const outcome = review && state === 'completed' ? 'posted' : state;
  const label = stopReason ? `Ultrafix loop finished${forPr}`
    : review ? `Review ${outcome}${forPr}` : `Task ${state}`;
  return {
    id: `task:${numericKey(row.history_id)}`, occurredAt, kind, repository: String(row.repository),
    outcome: stopReason ?? outcome,
    summary: line(label, summary.title, state === 'failed' ? summary.failure_reason : null),
    reference: reference({ taskId: summary.task_id, issueNumber, pullRequest }),
    url: githubUrl(row.repository, { pullRequest, issueNumber }),
  };
}

/**
 * Tasks that reached a terminal state inside the window. A terminal history row
 * is the event itself, so the indexed window bound does the filtering and no
 * per-task history has to be materialized.
 */
export async function collectTerminalTasks(scope: TimelineScope, now: number): Promise<TimelineEntry[]> {
  const { db, window } = scope;
  const query = db('task_history as event')
    .join('tasks', 'tasks.task_id', 'event.task_id')
    .whereIn('tasks.repository', scope.repositories)
    .whereIn('event.state', [...TERMINAL_TASK_STATES]);
  whereWithinWindow(query, 'event.timestamp', window);
  scope.visibility(query);
  query
    .leftJoin('plan_issues as task_plan_issue', 'task_plan_issue.id', db.raw('(?)', [latestPlanIssue(db)]))
    .select(...TASK_COLUMNS, 'event.history_id', 'event.state', 'event.timestamp as updated_at',
      'event.reason as state_reason', 'event.metadata as state_metadata');
  const rows = await orderByNewest(query, 'event.timestamp')
    .orderBy('event.history_id', 'desc')
    .limit(scope.budget) as Row[];
  return rows.filter(row => withinWindow(row.updated_at, window))
    .flatMap(row => terminalTaskEntry(row, now) ?? []);
}

/** Pull requests ProPR recorded as merged inside the window. */
export async function collectMergedPullRequests(scope: TimelineScope): Promise<TimelineEntry[]> {
  const { db, window } = scope;
  const query = db('notification_pull_request_state')
    .whereIn('repository', scope.repositories).whereNotNull('merged_at')
    .select('repository', 'pr_number', 'merged_at');
  whereWithinWindow(query, 'merged_at', window);
  // Ties follow the merged identifier `repository#pr`, so the repository is
  // part of the ordering here too.
  const rows = (await orderByNewest(query, 'merged_at')
    .orderBy('repository', 'desc').orderBy('pr_number', 'desc')
    .limit(scope.budget) as Row[]).filter(row => withinWindow(row.merged_at, window));
  const numbers = rows.map(row => Number(row.pr_number));
  const issues = numbers.length ? await db('plan_issues')
    .whereIn('repository', scope.repositories).whereIn('pr_number', numbers)
    .select('repository', 'pr_number', 'issue_number', 'task_id', 'draft_id')
    .orderBy('id', 'desc').limit(MAX_TIMELINE_ROWS) as Row[] : [];
  const byPullRequest = new Map(issues.map(issue =>
    [`${String(issue.repository).toLowerCase()}#${issue.pr_number}`, issue]));
  return rows.map(row => {
    const pullRequest = Number(row.pr_number);
    const issue = byPullRequest.get(`${String(row.repository).toLowerCase()}#${pullRequest}`);
    return {
      id: `pull_request:${row.repository}#${numericKey(pullRequest)}`, occurredAt: isoTimestamp(row.merged_at)!,
      kind: 'pull_request', repository: String(row.repository), outcome: 'merged',
      summary: line(`Pull request #${pullRequest} merged`),
      reference: reference({
        pullRequest, taskId: issue?.task_id, planId: issue?.draft_id,
        issueNumber: positiveNumber(issue?.issue_number),
      }),
      url: githubUrl(row.repository, { pullRequest }),
    };
  });
}

/** Goals of this owner that completed, failed or were cancelled in the window. */
export async function collectFinishedGoals(scope: TimelineScope): Promise<TimelineEntry[]> {
  const { db, window } = scope;
  const query = db('goals')
    .where({ owner_id: scope.owner }).whereIn('repository', scope.repositories).whereNotNull('result_state')
    .select('goal_id', 'repository', 'title', 'objective', 'result_state', 'current_task_id',
      'final_pr_number', 'failure_reason', 'completed_at');
  whereWithinWindow(query, 'completed_at', window);
  const rows = await orderByNewest(query, 'completed_at')
    .orderBy('goal_id', 'desc').limit(scope.budget) as Row[];
  return rows.filter(row => withinWindow(row.completed_at, window)).map(row => {
    const pullRequest = positiveNumber(row.final_pr_number);
    return {
      id: `goal:${row.goal_id}`, occurredAt: isoTimestamp(row.completed_at)!, kind: 'goal',
      repository: String(row.repository), outcome: String(row.result_state),
      summary: line(`Goal ${row.result_state}`, compactText(row.title ?? row.objective, DIGEST_TEXT_LIMIT),
        row.result_state === 'failed' ? compactText(row.failure_reason, DIGEST_TEXT_LIMIT) : null),
      reference: reference({ goalId: row.goal_id, taskId: row.current_task_id, pullRequest }),
      url: githubUrl(row.repository, { pullRequest }),
    };
  });
}

/**
 * Plans this owner published in the window. Publication is the transition into
 * `executed`; ProPR persists no later write for that status, so `updated_at` is
 * the publication time.
 */
export async function collectPublishedPlans(scope: TimelineScope): Promise<TimelineEntry[]> {
  const { db, window } = scope;
  const query = db('task_drafts')
    .where({ user_id: scope.owner, status: 'executed' }).whereIn('repository', scope.repositories)
    .select('draft_id', 'repository', 'name', 'updated_at');
  whereWithinWindow(query, 'updated_at', window);
  const rows = await orderByNewest(query, 'updated_at')
    .orderBy('draft_id', 'desc').limit(scope.budget) as Row[];
  return rows.filter(row => withinWindow(row.updated_at, window)).map(row => ({
    id: `plan:${row.draft_id}`, occurredAt: isoTimestamp(row.updated_at)!, kind: 'plan',
    repository: String(row.repository), outcome: 'published',
    summary: line('Plan published', compactText(row.name, DIGEST_TEXT_LIMIT)),
    reference: reference({ planId: row.draft_id }),
  }));
}

/** The pull request a receipt records as opened, or null when it records none. */
export function openedPullRequest(notification: InboxRow): number | null {
  return notification.kind === 'pull_request' ? positiveNumber(notification.target.prNumber) : null;
}

/**
 * Whether a receipt reaches the timeline at all. `readInbox` applies this
 * before its limit, so routine receipts cannot crowd a blocker out of the scan.
 */
export function isTimelineNotification(
  notification: InboxRow, options: { includeRoutine?: boolean },
): boolean {
  return openedPullRequest(notification) !== null || isOperatorRelevant(notification, options);
}

/**
 * Inbox receipts as timeline entries. A pull-request card is ProPR's persisted
 * record that a PR opened, so it enters the timeline as an outcome rather than
 * as Inbox chatter; everything else must clear the noise filter.
 */
export function inboxEntries(
  notifications: InboxRow[], options: { includeRoutine: boolean },
): TimelineEntry[] {
  return notifications.flatMap(notification => {
    const pullRequest = positiveNumber(notification.target.prNumber);
    const opened = openedPullRequest(notification) !== null;
    if (!isTimelineNotification(notification, options)) return [];
    return [{
      id: `notification:${notification.id}`, occurredAt: notification.occurredAt,
      kind: opened ? 'pull_request' : 'notification', repository: notification.repository,
      outcome: opened ? 'opened' : notification.severity,
      summary: line(notification.title, notification.body),
      reference: inboxReference(notification),
      url: githubUrl(notification.repository, {
        pullRequest, issueNumber: positiveNumber(notification.target.issueNumber),
      }),
    }];
  });
}
