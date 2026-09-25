import type { Knex } from 'knex';
import {
  NOTIFICATION_KINDS, NOTIFICATION_SEVERITIES,
  type NotificationKind, type NotificationSeverity,
} from '@propr/shared';
import { McpError } from './config.js';
import { compactText } from './listSummaries.js';

/**
 * Bounded aggregation and filtering helpers for the operator activity digest.
 * Every collector here reads one window-bounded, repository-bounded slice of a
 * table ProPR already persists; authorization and projection stay in
 * `toolsActivity.ts`, next to the tool definitions that own them.
 */

/** Repositories one cross-repository digest call will scan. */
export const MAX_DIGEST_REPOSITORIES = 20;
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
 * Slack the lexical bounds below carry. A persisted timestamp may spell its
 * instant in a UTC offset up to fourteen hours from the instant itself, which
 * moves the text of an in-window value by up to a calendar day.
 */
const BOUND_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * Lexical SQL bounds that keep a window query on the column's index. They are
 * deliberately loose — the space separator sorts before `T`, fractional
 * seconds and the `Z` suffix are optional, and an offset moves the text of an
 * instant — so they are a superset of the window, never a filter.
 * {@link whereWithinWindow} adds the exact bounds on top.
 */
export function lowerBound(iso: string): string {
  return new Date(Date.parse(iso) - BOUND_SLACK_MS).toISOString().slice(0, 19).replace('T', ' ');
}

export function upperBound(iso: string): string {
  return new Date(Date.parse(iso) + BOUND_SLACK_MS).toISOString();
}

/**
 * SQL that rewrites either persisted spelling — canonical ISO-8601 or SQLite's
 * offset-free `YYYY-MM-DD HH:MM:SS` — into the canonical form `toISOString`
 * produces, the same expression the schema's own timestamp checks use. SQLite
 * reads both, resolves any offset to UTC, and yields NULL for a value it
 * cannot read, which then fails every bound.
 *
 * Ordering and filtering on it rather than on the raw column is what lets both
 * happen *before* a LIMIT: raw text interleaves the two spellings, so a query
 * ordered by the column can spend its whole budget on rows the exact filter
 * then discards.
 */
export function normalizedTimestamp(expression: string): string {
  return `strftime('%Y-%m-%dT%H:%M:%fZ', ${expression})`;
}

const NORMALIZED_COLUMN = normalizedTimestamp('??');

/** Exact, inclusive window bounds across both spellings, applied before LIMIT. */
export function whereWithinWindow(
  query: Knex.QueryBuilder, column: string, window: ResolvedWindow,
): Knex.QueryBuilder {
  return query
    .where(column, '>=', lowerBound(window.since))
    .where(column, '<=', upperBound(window.until))
    .whereRaw(`${NORMALIZED_COLUMN} >= ?`, [column, window.since])
    .whereRaw(`${NORMALIZED_COLUMN} <= ?`, [column, window.until]);
}

/** Newest first across both spellings, ordered before LIMIT. */
export function orderByNewest(query: Knex.QueryBuilder, column: string): Knex.QueryBuilder {
  return query.orderByRaw(`${NORMALIZED_COLUMN} desc`, [column]);
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

/**
 * Byte-by-byte comparison, the collation SQLite orders text with. The merge
 * comparator has to agree with the `ORDER BY` that decided which rows a source
 * contributed: under `localeCompare` a tie would merge in a different order
 * than it was selected in, and a later page would repeat or skip it.
 */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Width that keeps a padded integer identifier below any realistic successor. */
const NUMERIC_KEY_WIDTH = 20;

/**
 * Tie-break key for an identifier stored as an integer. Zero padding makes the
 * lexical comparison above agree with the numeric `ORDER BY` its source query
 * uses, so `9` keeps sorting below `11` after the merge. Only integer columns
 * may use it: a text column sorts its digits lexically in SQL too.
 */
export function numericKey(value: unknown): string {
  const text = String(value ?? '');
  return /^\d+$/.test(text) ? text.padStart(NUMERIC_KEY_WIDTH, '0') : text;
}

/** Newest-first, ties broken by identifier so repeated calls do not shuffle. */
export function compareNewestFirst(
  left: { occurredAt: string; id: string },
  right: { occurredAt: string; id: string },
): number {
  return compareText(right.occurredAt, left.occurredAt) || compareText(right.id, left.id);
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

/**
 * Kinds whose producers were read for the signal table below. A kind added to
 * the shared vocabulary after this table was written has no entry here, so its
 * metadata cannot promote it into the digest: error severity, `system_failure`
 * and `includeRoutine` stay the only ways in until somebody reviews what the
 * new producer writes. `system_failure` is absent because it is always
 * relevant already.
 */
const SIGNAL_BEARING_KIND_NAMES: readonly string[] = ['plan', 'task', 'review', 'pull_request', 'indexing'];

const SIGNAL_BEARING_KINDS: ReadonlySet<NotificationKind> = new Set(
  NOTIFICATION_KINDS.filter(kind => SIGNAL_BEARING_KIND_NAMES.includes(kind)),
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
 * these fields, on {@link SIGNAL_BEARING_KINDS}, are consulted, so neither an
 * unrelated metadata key nor an unreviewed kind can promote routine chatter
 * into the digest.
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
  if (!SIGNAL_BEARING_KINDS.has(notification.kind as NotificationKind)) return false;
  return blockerSignal(notification) !== null;
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

/** Receipts one Inbox page reads. */
export const INBOX_PAGE_ROWS = 200;
/** Receipts one Inbox scan reads before it reports itself truncated. */
export const MAX_INBOX_SCAN_ROWS = 2000;

/**
 * The repository a receipt targets, as SQL. Scoping in the query rather than
 * after it is what stops a page of receipts from another repository from
 * hiding a blocker in this one; `accept` below does the same for routine
 * receipts, which are far more numerous than actionable ones.
 */
const RECEIPT_REPOSITORY = `case when json_valid(event.target_json)
  and json_type(event.target_json, '$.repository') = 'text'
  then lower(json_extract(event.target_json, '$.repository')) end`;

const INBOX_COLUMNS = ['event.event_id', 'event.kind', 'event.severity', 'event.target_json',
  'event.metadata_json', 'event.title', 'event.body', 'event.occurred_at'];

export interface InboxScan {
  notifications: InboxRow[];
  /** The scan budget ran out with receipts still unread. */
  truncated: boolean;
}

export interface InboxOptions {
  repositories: string[];
  scoped: boolean;
  window?: ResolvedWindow;
  /** Matching receipts to return; ask for one more than you will show. */
  limit: number;
  /** Everything the caller will actually use, applied before the limit. */
  accept?: (notification: InboxRow) => boolean;
  /**
   * Read dismissed receipts too. Dismissal clears a card from the Inbox; it does
   * not undo the event, so a historical timeline keeps it. Current blockers do not.
   */
  includeDismissed?: boolean;
}

function inboxRow(row: Row, accessible: Set<string>, options: InboxOptions): InboxRow | null {
  const target = parseJsonObject(row.target_json);
  const repository = typeof target.repository === 'string' ? target.repository : null;
  const occurredAt = isoTimestamp(row.occurred_at);
  if (!occurredAt || (repository ? !accessible.has(repository.toLowerCase()) : options.scoped)) return null;
  if (options.window && !withinWindow(occurredAt, options.window)) return null;
  return {
    id: String(row.event_id), kind: String(row.kind), severity: String(row.severity),
    target, metadata: parseJsonObject(row.metadata_json),
    title: compactText(row.title, DIGEST_TEXT_LIMIT), body: compactText(row.body, DIGEST_TEXT_LIMIT),
    occurredAt, repository,
  };
}

/** One page of the scan: the repositories it may match and where it reads. */
interface InboxPage {
  accessible: string[];
  limit: number;
  offset: number;
}

function inboxPage(
  db: Knex, owner: string, options: InboxOptions, page: InboxPage,
): Promise<Row[]> {
  const { accessible } = page;
  const query = db('notification_user_states as receipt')
    .join('notification_events as event', 'event.event_id', 'receipt.event_id')
    .where({ 'receipt.user_id': owner, 'receipt.inbox_enabled': true })
    .where(builder => { if (!options.includeDismissed) builder.whereNull('receipt.dismissed_at'); })
    .where(builder => {
      if (accessible.length) {
        builder.whereRaw(`(${RECEIPT_REPOSITORY}) in (${accessible.map(() => '?').join(', ')})`, accessible);
      }
      // A system notification carries no repository and belongs to the
      // unscoped view only, matching `list_notifications`.
      if (!options.scoped) builder.orWhereRaw(`(${RECEIPT_REPOSITORY}) is null`);
    })
    .select(...INBOX_COLUMNS);
  if (options.window) whereWithinWindow(query, 'event.occurred_at', options.window);
  return orderByNewest(query, 'event.occurred_at')
    .orderBy('event.event_id', 'desc').limit(page.limit).offset(page.offset) as Promise<Row[]>;
}

/**
 * Inbox receipts for one user (active ones unless `includeDismissed`), restricted to the digest's repositories
 * and to what the caller will use. The Inbox is shared by every repository and
 * dominated by routine chatter, so the scan pages through it until it has
 * `limit` matching receipts or its budget runs out, and reports that budget
 * running out rather than presenting a partial scan as the whole truth.
 */
export async function readInbox(db: Knex, owner: string, options: InboxOptions): Promise<InboxScan> {
  const accessible = options.repositories.map(name => name.toLowerCase());
  // Scoped to nothing: only the unscoped view can still match system receipts.
  if (!accessible.length && options.scoped) return { notifications: [], truncated: false };
  const lookup = new Set(accessible);
  const accept = options.accept ?? (() => true);
  const notifications: InboxRow[] = [];
  let scanned = 0;
  while (notifications.length < options.limit && scanned < MAX_INBOX_SCAN_ROWS) {
    const size = Math.min(INBOX_PAGE_ROWS, MAX_INBOX_SCAN_ROWS - scanned);
    const rows = await inboxPage(db, owner, options, { accessible, limit: size, offset: scanned });
    scanned += rows.length;
    for (const row of rows) {
      const notification = inboxRow(row, lookup, options);
      if (notification && accept(notification)) notifications.push(notification);
      if (notifications.length === options.limit) break;
    }
    if (rows.length < size) return { notifications, truncated: false };
  }
  return { notifications, truncated: notifications.length < options.limit };
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
