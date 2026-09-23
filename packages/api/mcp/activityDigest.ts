import type { Knex } from 'knex';
import {
  NOTIFICATION_KINDS, NOTIFICATION_SEVERITIES,
  type NotificationKind, type NotificationSeverity,
} from '@propr/shared';
import { McpError } from './config.js';
import { compactText, summarizeTask } from './listSummaries.js';

/**
 * Bounded aggregation and filtering helpers for the operator activity digest.
 * Every collector here reads one window-bounded, repository-bounded slice of a
 * table ProPR already persists; authorization and projection stay in
 * `toolsActivity.ts`, next to the tool definitions that own them.
 */

/** Repositories one cross-repository digest call will scan. */
export const MAX_DIGEST_REPOSITORIES = 20;
/** Rows a single recent-activity source may contribute before the merge. */
export const MAX_TIMELINE_ROWS = 500;
/** Goals whose narration is resolved per call; narration costs a live read. */
export const MAX_NARRATION_LOOKUPS = 10;
/**
 * A task started longer ago than this is not "happening now". The bound keeps
 * the current-activity scan on the indexed `tasks.created_at` range instead of
 * every task ProPR has ever run.
 */
export const ACTIVE_TASK_LOOKBACK_DAYS = 30;
/** Longest window `get_recent_activity` will resolve, in minutes. */
export const MAX_WINDOW_MINUTES = 7 * 24 * 60;
/** Window used when neither sinceMinutes nor since is given. */
export const DEFAULT_WINDOW_MINUTES = 60;
/** Byte budget for every free-text field the digest emits. */
export const DIGEST_TEXT_LIMIT = 240;

/** Terminal task states, matching the vocabulary `summarizeTask` projects. */
export const TERMINAL_TASK_STATES = ['completed', 'failed', 'cancelled'] as const;
/** Accepted-but-not-yet-executing states from the shared task lifecycle. */
export const QUEUED_TASK_STATES = ['pending', 'queued'] as const;

export type TaskActivityPhase = 'queued' | 'running' | typeof TERMINAL_TASK_STATES[number];

export type Row = Record<string, unknown>;

export function parseJsonObject(value: unknown): Row {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row;
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Row : {};
  } catch {
    return {};
  }
}

/**
 * Database timestamps are written either as canonical ISO-8601 or as SQLite's
 * offset-free `YYYY-MM-DD HH:MM:SS`, which is UTC. Normalize both.
 */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const candidate = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const milliseconds = new Date(candidate).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function isoTimestamp(value: unknown): string | null {
  const milliseconds = parseTimestamp(value);
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

export function elapsedSeconds(from: unknown, to: number): number | null {
  const start = parseTimestamp(from);
  return start === null ? null : Math.max(0, Math.round((to - start) / 1000));
}

export function positiveNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * Lexical SQL bounds that cover both persisted timestamp spellings. A space
 * separator sorts before `T`, so the space form widens a lower bound and the
 * ISO form widens an upper bound. Callers re-filter exactly with
 * {@link withinWindow}, so the widening only costs a few extra rows.
 */
export function lowerBound(iso: string): string {
  return iso.replace('T', ' ');
}

export function upperBound(iso: string): string {
  return iso;
}

export function withinWindow(value: unknown, window: ResolvedWindow): boolean {
  const at = parseTimestamp(value);
  return at !== null && at >= Date.parse(window.since) && at <= Date.parse(window.until);
}

export interface WindowArguments {
  sinceMinutes?: number;
  since?: string;
  until?: string;
}

export interface ResolvedWindow {
  since: string;
  until: string;
}

/** Resolve and validate the requested window; both bounds are inclusive. */
export function resolveWindow(args: WindowArguments, now: number): ResolvedWindow {
  if (args.sinceMinutes !== undefined && args.since !== undefined) {
    throw new McpError('INVALID_INPUT', 'Provide exactly one of sinceMinutes or since.');
  }
  const untilMs = args.until === undefined ? now : parseTimestamp(args.until);
  if (untilMs === null) throw new McpError('INVALID_INPUT', 'until must be an ISO-8601 timestamp.');
  const sinceMs = args.since !== undefined
    ? parseTimestamp(args.since)
    : untilMs - (args.sinceMinutes ?? DEFAULT_WINDOW_MINUTES) * 60_000;
  if (sinceMs === null) throw new McpError('INVALID_INPUT', 'since must be an ISO-8601 timestamp.');
  if (untilMs <= sinceMs) throw new McpError('INVALID_INPUT', 'until must be later than since.');
  if (untilMs - sinceMs > MAX_WINDOW_MINUTES * 60_000) {
    throw new McpError('WINDOW_TOO_LARGE', 'Request a window of at most seven days.');
  }
  return { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() };
}

/**
 * Classify a persisted task state. Execution states are agent-specific
 * (`claude_execution`, `codex_execution`, …), so anything that is neither
 * terminal nor waiting in the queue is running work.
 */
export function classifyTaskState(state: unknown): TaskActivityPhase {
  const value = typeof state === 'string' && state.trim() ? state.trim() : 'pending';
  if ((TERMINAL_TASK_STATES as readonly string[]).includes(value)) return value as TaskActivityPhase;
  if ((QUEUED_TASK_STATES as readonly string[]).includes(value)) return 'queued';
  return 'running';
}

/** Newest-first, ties broken by identifier so repeated calls do not shuffle. */
export function compareNewestFirst(
  left: { occurredAt: string; id: string },
  right: { occurredAt: string; id: string },
): number {
  return right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id);
}

/** A factual one-liner assembled from persisted fields; never invented prose. */
export function line(...parts: unknown[]): string | null {
  return compactText(parts.filter(part => typeof part === 'string' && part.trim()).join(' — '), DIGEST_TEXT_LIMIT);
}

export function reference(values: Row): Row {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null && value !== undefined));
}

export function githubUrl(repository: unknown, target: { pullRequest?: number | null; issueNumber?: number | null }): string | undefined {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return undefined;
  if (target.pullRequest) return `https://github.com/${repository}/pull/${target.pullRequest}`;
  if (target.issueNumber) return `https://github.com/${repository}/issues/${target.issueNumber}`;
  return undefined;
}

/*
 * Noise filtering for the operator digest.
 *
 * An Inbox notification exists to tell one person that something they started
 * moved on: a plan finished generating, an implementation completed, a PR is
 * ready for review, indexing succeeded. That is exactly the chatter an operator
 * scrolls past when asking "what is blocking me?", and there is far more of it
 * than there is of anything actionable. Those notifications stay fully readable
 * through `list_notifications`; the digest keeps only what a human still has to
 * act on.
 *
 * The rule is driven by the shared NOTIFICATION_SEVERITIES / NOTIFICATION_KINDS
 * vocabulary plus an explicit table of blocker signals, and it is deliberately
 * closed: a notification kind introduced after this table was written has no
 * entry and is therefore excluded unless it arrives at error severity. A new
 * routine kind must never widen the digest on its own, while a genuine failure
 * still surfaces through its severity.
 */

/** Severities that always survive, selected from the shared vocabulary. */
const ALWAYS_RELEVANT_SEVERITIES: ReadonlySet<NotificationSeverity> = new Set(
  NOTIFICATION_SEVERITIES.filter(severity => severity === 'error'),
);

/**
 * Kinds that always survive, selected from the shared vocabulary. A system
 * failure is the operator's problem by construction: an unhealthy component or
 * a blocked platform event stops work until somebody intervenes.
 */
const ALWAYS_RELEVANT_KINDS: ReadonlySet<NotificationKind> = new Set(
  NOTIFICATION_KINDS.filter(kind => kind === 'system_failure'),
);

/** Persisted values that mean a task, goal, plan or loop stopped short. */
const FAILED_STATE_VALUES: ReadonlySet<string> = new Set([
  'failed', 'failure', 'cancelled', 'canceled', 'aborted', 'error', 'errored',
  'timed_out', 'timeout', 'blocked', 'awaiting_input', 'needs_input',
]);

/** Machine stop reasons that mean an ultrafix loop was aborted, not finished. */
const ABORTED_ULTRAFIX_REASONS: ReadonlySet<string> = new Set([
  'ultrafix_superseded', 'label_removed', 'deferred_cancelled',
  'no_active_loop', 'no_deferred_continuation',
]);

const failedState = (value: unknown): boolean =>
  typeof value === 'string' && FAILED_STATE_VALUES.has(value.trim().toLowerCase());
const isTrue = (value: unknown): boolean => value === true;
const isFalse = (value: unknown): boolean => value === false;
const presentText = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;

/**
 * Blocker signals, keyed by the producer-defined field that carries them. Only
 * these fields are consulted, so an unrelated metadata key can never promote
 * routine chatter into the digest.
 */
const BLOCKER_SIGNALS: ReadonlyArray<readonly [string, (value: unknown) => boolean, string]> = [
  // A failed or input-awaiting task, goal, plan or review.
  ['state', failedState, 'failed_state'],
  ['status', failedState, 'failed_state'],
  ['taskState', failedState, 'failed_task'],
  ['goalState', failedState, 'failed_goal'],
  ['resultState', failedState, 'failed_state'],
  ['result_state', failedState, 'failed_state'],
  ['outcome', failedState, 'failed_state'],
  ['completionStatus', failedState, 'failed_state'],
  // An agent or model provider that cannot currently run work.
  ['agentAvailable', isFalse, 'agent_unavailable'],
  ['providerAvailable', isFalse, 'provider_unavailable'],
  ['agentUnavailable', isTrue, 'agent_unavailable'],
  ['providerUnavailable', isTrue, 'provider_unavailable'],
  // A credential or authorization the operator has to supply.
  ['credentialRequired', isTrue, 'credential_required'],
  ['requiresCredential', isTrue, 'credential_required'],
  ['authorizationRequired', isTrue, 'authorization_required'],
  ['requiresAuthorization', isTrue, 'authorization_required'],
  // An exceeded quota, seat allowance or rate limit.
  ['quotaExceeded', isTrue, 'quota_exceeded'],
  ['limitExceeded', isTrue, 'limit_exceeded'],
  ['rateLimited', isTrue, 'rate_limited'],
  ['seatsRemaining', value => typeof value === 'number' && value <= 0, 'quota_exceeded'],
  // An ultrafix loop that stopped without finishing its cycles.
  ['ultrafixAborted', isTrue, 'ultrafix_aborted'],
  ['ultrafixStopReason', value =>
    typeof value === 'string' && ABORTED_ULTRAFIX_REASONS.has(value.trim().toLowerCase()), 'ultrafix_aborted'],
  // An explicit error code recorded by the producer.
  ['errorCode', presentText, 'error_reported'],
];

export interface OperatorRelevanceInput {
  kind: string;
  severity: string;
  target?: unknown;
  metadata?: unknown;
}

/** The blocker signal a notification carries, or null when it carries none. */
export function blockerSignal(notification: OperatorRelevanceInput): string | null {
  const fields = { ...parseJsonObject(notification.target), ...parseJsonObject(notification.metadata) };
  for (const [key, matches, signal] of BLOCKER_SIGNALS) {
    if (key in fields && matches(fields[key])) return signal;
  }
  return null;
}

/**
 * Whether a notification belongs in an operator digest. `includeRoutine`
 * restores the unfiltered Inbox view for an operator who asks for it.
 */
export function isOperatorRelevant(
  notification: OperatorRelevanceInput,
  options: { includeRoutine?: boolean } = {},
): boolean {
  if (options.includeRoutine) return true;
  if (ALWAYS_RELEVANT_SEVERITIES.has(notification.severity as NotificationSeverity)) return true;
  if (ALWAYS_RELEVANT_KINDS.has(notification.kind as NotificationKind)) return true;
  return blockerSignal(notification) !== null;
}

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

export interface InboxRow {
  id: string;
  kind: string;
  severity: string;
  target: Row;
  metadata: Row;
  title: string | null;
  body: string | null;
  occurredAt: string;
  repository: string | null;
}

/**
 * Active Inbox receipts for one user, restricted to the digest's repositories.
 * System notifications carry no repository and belong to the unscoped view
 * only, matching `list_notifications`.
 */
export async function readInbox(db: Knex, owner: string, options: {
  repositories: string[]; scoped: boolean; window?: ResolvedWindow; limit: number;
}): Promise<InboxRow[]> {
  const query = db('notification_user_states as receipt')
    .join('notification_events as event', 'event.event_id', 'receipt.event_id')
    .where({ 'receipt.user_id': owner, 'receipt.inbox_enabled': true })
    .whereNull('receipt.dismissed_at')
    .select('event.event_id', 'event.kind', 'event.severity', 'event.target_json',
      'event.metadata_json', 'event.title', 'event.body', 'event.occurred_at')
    .orderBy('event.occurred_at', 'desc').orderBy('event.event_id', 'desc')
    .limit(options.limit);
  if (options.window) {
    query.where('event.occurred_at', '>=', lowerBound(options.window.since))
      .where('event.occurred_at', '<=', upperBound(options.window.until));
  }
  const accessible = new Set(options.repositories.map(name => name.toLowerCase()));
  const rows = await query as Row[];
  return rows.flatMap(row => {
    const target = parseJsonObject(row.target_json);
    const repository = typeof target.repository === 'string' ? target.repository : null;
    const occurredAt = isoTimestamp(row.occurred_at);
    if (!occurredAt || (repository ? !accessible.has(repository.toLowerCase()) : options.scoped)) return [];
    if (options.window && !withinWindow(occurredAt, options.window)) return [];
    return [{
      id: String(row.event_id), kind: String(row.kind), severity: String(row.severity),
      target, metadata: parseJsonObject(row.metadata_json),
      title: compactText(row.title, DIGEST_TEXT_LIMIT), body: compactText(row.body, DIGEST_TEXT_LIMIT),
      occurredAt, repository,
    }];
  });
}

export function inboxReference(notification: InboxRow): Row {
  const { target } = notification;
  return reference({
    notificationId: notification.id,
    taskId: typeof target.taskId === 'string' ? target.taskId : undefined,
    planId: typeof target.draftId === 'string' ? target.draftId : undefined,
    issueNumber: positiveNumber(target.issueNumber),
    pullRequest: positiveNumber(target.prNumber),
  });
}

/** Newest plan relation for a task, so PR and agent context stay consistent. */
export function latestPlanIssue(db: Knex) {
  return db('plan_issues').select('id')
    .where('task_id', db.ref('tasks.task_id')).orderBy('id', 'desc').limit(1);
}

export const TASK_COLUMNS = [
  'tasks.task_id', 'tasks.repository', 'tasks.issue_number', 'tasks.task_type', 'tasks.model_name',
  'tasks.pr_number', 'tasks.initial_job_data', 'tasks.created_at',
  'task_plan_issue.pr_number as plan_pr_number', 'task_plan_issue.status as plan_issue_status',
  'task_plan_issue.agent_alias as plan_agent_alias', 'task_plan_issue.model_name as plan_model_name',
];

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
    id: `task:${row.history_id}`, occurredAt, kind, repository: String(row.repository),
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
    .whereIn('event.state', [...TERMINAL_TASK_STATES])
    .where('event.timestamp', '>=', lowerBound(window.since))
    .where('event.timestamp', '<=', upperBound(window.until));
  scope.visibility(query);
  const rows = await query
    .leftJoin('plan_issues as task_plan_issue', 'task_plan_issue.id', db.raw('(?)', [latestPlanIssue(db)]))
    .select(...TASK_COLUMNS, 'event.history_id', 'event.state', 'event.timestamp as updated_at',
      'event.reason as state_reason', 'event.metadata as state_metadata')
    .orderBy('event.timestamp', 'desc').orderBy('event.history_id', 'desc')
    .limit(scope.budget) as Row[];
  return rows.filter(row => withinWindow(row.updated_at, window))
    .flatMap(row => terminalTaskEntry(row, now) ?? []);
}

/** Pull requests ProPR recorded as merged inside the window. */
export async function collectMergedPullRequests(scope: TimelineScope): Promise<TimelineEntry[]> {
  const { db, window } = scope;
  const rows = (await db('notification_pull_request_state')
    .whereIn('repository', scope.repositories).whereNotNull('merged_at')
    .where('merged_at', '>=', lowerBound(window.since)).where('merged_at', '<=', upperBound(window.until))
    .select('repository', 'pr_number', 'merged_at')
    .orderBy('merged_at', 'desc').orderBy('pr_number', 'desc')
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
      id: `pull_request:${row.repository}#${pullRequest}`, occurredAt: isoTimestamp(row.merged_at)!,
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
  const rows = await db('goals')
    .where({ owner_id: scope.owner }).whereIn('repository', scope.repositories).whereNotNull('result_state')
    .where('completed_at', '>=', lowerBound(window.since))
    .where('completed_at', '<=', upperBound(window.until))
    .select('goal_id', 'repository', 'title', 'objective', 'result_state', 'current_task_id',
      'final_pr_number', 'failure_reason', 'completed_at')
    .orderBy('completed_at', 'desc').orderBy('goal_id', 'desc').limit(scope.budget) as Row[];
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
  const rows = await db('task_drafts')
    .where({ user_id: scope.owner, status: 'executed' }).whereIn('repository', scope.repositories)
    .where('updated_at', '>=', lowerBound(window.since))
    .where('updated_at', '<=', upperBound(window.until))
    .select('draft_id', 'repository', 'name', 'updated_at')
    .orderBy('updated_at', 'desc').orderBy('draft_id', 'desc').limit(scope.budget) as Row[];
  return rows.filter(row => withinWindow(row.updated_at, window)).map(row => ({
    id: `plan:${row.draft_id}`, occurredAt: isoTimestamp(row.updated_at)!, kind: 'plan',
    repository: String(row.repository), outcome: 'published',
    summary: line('Plan published', compactText(row.name, DIGEST_TEXT_LIMIT)),
    reference: reference({ planId: row.draft_id }),
  }));
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
    const opened = notification.kind === 'pull_request' && pullRequest !== null;
    if (!opened && !isOperatorRelevant(notification, options)) return [];
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
