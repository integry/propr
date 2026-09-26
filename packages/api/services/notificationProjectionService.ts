/* eslint-disable max-lines -- lifecycle mappings stay together for auditability */
import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import {
  NotificationService,
  type CreateNotificationEventInput,
  type NotificationRecipient,
} from '@propr/core';
import {
  normalizeISO8601Timestamp,
  type DraftUpdatePayload,
  type IndexingUpdatePayload,
  type JsonObject,
  type NotificationEventAction,
  type TaskUpdatePayload,
} from '@propr/shared';

const DEFAULT_STALLED_AFTER_MS = 30 * 60 * 1000;
const MIN_STALLED_CHECK_INTERVAL_MS = 5_000;
const MAX_STALLED_CHECK_INTERVAL_MS = 60_000;
const TERMINAL_ACTIVITY_STATUSES = new Set(['completed', 'failed', 'cancelled']);
// Repository settings change rarely while lifecycle projections are frequent;
// a short TTL removes almost all reads yet applies an operator's change quickly.
const REPOSITORY_NOTIFICATION_CACHE_TTL_MS = 5_000;
// Read through the injected background connection rather than the
// @propr/core config singleton, whose blocking busy_timeout this worker avoids.
const MONITORED_REPOS_CONFIG_KEY = 'repos_to_monitor';
const SQLITE_CONTENTION_RETRY_DELAYS_MS = [
  10, 25, 50, 100, 250, 500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000,
] as const;
const SQLITE_CONTENTION_CODES = new Set([
  'SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED', 'SQLITE_LOCKED_SHAREDCACHE',
]);

type SourceActivityStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

interface ProjectionLogger {
  warn(message: string, error?: unknown): void;
}

type NotificationEventWriter = Pick<NotificationService,
  'createNotificationEvent' | 'createPullRequestNotificationEvent'
  | 'createPullRequestAttentionNotificationEvent'
  | 'createSourceActivityNotificationEvent'
  | 'reconcileSystemFailureTransition'
  | 'dismissSystemFailureNotifications'>;

export interface NotificationProjectionOptions {
  database: Knex;
  notificationService?: NotificationEventWriter;
  now?: () => Date;
  stalledAfterMs?: number;
  stalledCheckIntervalMs?: number;
  logger?: ProjectionLogger;
  contentionRetryDelaysMs?: readonly number[];
  /** Test seam; production reads the cached monitored-repository configuration. */
  repositoryNotificationsEnabled?: (repository: string) => Promise<boolean>;
}

export interface SystemHealthSnapshot {
  timestamp: string;
  [component: string]: unknown;
}

interface TaskContext {
  repository: string;
  issueNumber?: number;
  prNumber?: number;
  description?: string;
  /** The underlying PR or issue title, without workflow prefixes. */
  subjectTitle?: string;
  recap?: string;
  commandMode?: string;
  isReview: boolean;
  followupEligible: boolean;
  reviewFollowupEligible: boolean;
  pullRequestFollowupEligible: boolean;
}

interface TaskEventProjection {
  payload: TaskUpdatePayload;
  context: TaskContext;
  occurredAt: string;
  recipients: readonly NotificationRecipient[];
  pullRequestUrl?: string;
}

interface PullRequestTaskEventProjection extends TaskEventProjection {
  prNumber: number;
}

interface SourceActivityRow {
  activity_type: 'task' | 'indexing';
  activity_key: string;
  repository: string;
  branch: string | null;
  status: SourceActivityStatus;
  last_activity_at: string;
  metadata_json: string | null;
}

interface ConnectSeatLimitBlock {
  installationId: number;
  activeSeats: number;
  allowedSeats: number;
  seatsRemaining: number;
  billingCycleResetAt: string;
  blockedAt: string;
}

const CONNECT_SEAT_LIMIT_COMPONENT = 'propr-connect-seat-limit';

const SYSTEM_HEALTH_RULES: Readonly<Record<string, ReadonlySet<string>>> = {
  api: new Set(['healthy']),
  redis: new Set(['connected']),
  daemon: new Set(['running']),
  worker: new Set(['running']),
  githubAuth: new Set(['connected']),
  githubEventIntakeStatus: new Set(['connected', 'active']),
  // Claude auth is healthy both when an enabled Claude agent can authenticate
  // and when no enabled Claude agent makes that provider applicable. Treating
  // not_applicable as healthy also drives the normal reconciliation path that
  // dismisses stale Claude failure cards without creating a recovery event.
  claudeAuth: new Set(['connected', 'not_applicable']),
  indexing: new Set(['idle', 'active', 'queued']),
};

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function sqliteErrorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as Error & { code?: unknown }).code)
    : undefined;
}

function isSqliteContention(error: unknown): boolean {
  return SQLITE_CONTENTION_CODES.has(sqliteErrorCode(error) ?? '');
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const complete = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', complete);
      resolve();
    };
    const timer = setTimeout(complete, delayMs);
    signal.addEventListener('abort', complete, { once: true });
  });
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function compactDisplayText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  const characters = Array.from(normalized);
  return characters.length <= 320
    ? normalized
    : `${characters.slice(0, 319).join('')}…`;
}

function cleanTaskDescription(value: unknown): string | undefined {
  const compact = compactDisplayText(value)?.replace(/^New Issue:\s*/i, '').trim();
  if (!compact || /^(?:implementation (?:is )?complete(?:d)?|preparing (?:a )?(?:pr|pull request))\b/i.test(compact)) {
    return undefined;
  }
  return compact;
}

function taskDescription(initial: Record<string, unknown>): string | undefined {
  const issueRef = typeof initial.issueRef === 'object'
    && initial.issueRef !== null
    && !Array.isArray(initial.issueRef)
    ? initial.issueRef as Record<string, unknown>
    : {};
  return cleanTaskDescription(initial.subtitle)
    ?? cleanTaskDescription(initial.title)
    ?? cleanTaskDescription(issueRef.title);
}

const TASK_TITLE_PREFIX = /^(?:new issue:|(?:follow-up|fix|review|ultrafix|merge) pr #\d+:)\s*/i;

function subjectTitle(initial: Record<string, unknown>): string | undefined {
  const issueRef = typeof initial.issueRef === 'object'
    && initial.issueRef !== null
    && !Array.isArray(initial.issueRef)
    ? initial.issueRef as Record<string, unknown>
    : {};
  const title = compactDisplayText(initial.title ?? issueRef.title)?.replace(TASK_TITLE_PREFIX, '').trim();
  return title && !/^untitled pull request$/i.test(title) ? title : undefined;
}

function resolveCommandMode(
  historyMetadata: Record<string, unknown>,
  initial: Record<string, unknown>,
): string | undefined {
  if (typeof historyMetadata.commandMode === 'string') return historyMetadata.commandMode;
  return typeof initial.commandMode === 'string' ? initial.commandMode : undefined;
}

function notificationRecap(metadata: Record<string, unknown>): string | undefined {
  const direct = compactDisplayText(metadata.notificationRecap);
  if (direct) return direct;
  const prResult = typeof metadata.prResult === 'object'
    && metadata.prResult !== null
    && !Array.isArray(metadata.prResult)
    ? metadata.prResult as Record<string, unknown>
    : {};
  return compactDisplayText(prResult.notificationRecap);
}

function planItemCount(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? (() => {
    try { return JSON.parse(value) as unknown; } catch { return undefined; }
  })() : value;
  return Array.isArray(parsed) ? parsed.length : undefined;
}

function quotedDescription(description: string | undefined): string | undefined {
  return description ? `“${description}”` : undefined;
}

/** A task summary worth showing beneath the subject title, if it adds anything. */
function distinctDescription(context: TaskContext): string | undefined {
  const { subjectTitle, description } = context;
  if (!subjectTitle || !description) return undefined;
  const normalize = (value: string) => value.replace(TASK_TITLE_PREFIX, '').trim().toLowerCase();
  return normalize(description) === normalize(subjectTitle) ? undefined : description;
}

function completedPullRequestTitle(context: TaskContext, prNumber: number): string {
  if (context.subjectTitle) return context.subjectTitle;
  switch (context.commandMode) {
    case 'fix': return `Fix run completed for PR #${prNumber}`;
    case 'merge': return `Merge completed for PR #${prNumber}`;
    case 'switch': return `Model switch completed for PR #${prNumber}`;
    default: return context.description ?? `PR #${prNumber} ready for review`;
  }
}

function stableKey(scope: string, ...parts: unknown[]): string {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `projection:v1:${scope}:${digest}`;
}

function indexingActivityKey(repository: string, branch?: string): string {
  return `indexing:${createHash('sha256')
    .update(`${repository}\0${branch ?? ''}`)
    .digest('hex')}`;
}

function resolveStalledAfterMs(value: number | undefined): number {
  if (value !== undefined && Number.isFinite(value) && value > 0) return Math.floor(value);
  const configured = Number(process.env.NOTIFICATION_STALLED_AFTER_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_STALLED_AFTER_MS;
}

function activityStatusForTask(state: string): SourceActivityStatus | undefined {
  switch (state) {
    case 'pending': return 'queued';
    case 'processing':
    case 'claude_execution':
    case 'post_processing': return 'processing';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return undefined;
  }
}

function activityStatusForIndexing(phase: string): SourceActivityStatus | undefined {
  switch (phase) {
    case 'indexing':
    case 'files':
    case 'directories': return 'processing';
    case 'completed':
    case 'idle': return 'completed';
    case 'failed': return 'failed';
    default: return undefined;
  }
}

function isValidGithubRepository(repository: string): boolean {
  const parts = repository.split('/');
  return parts.length === 2 && parts.every(part => /^[A-Za-z0-9_.-]+$/.test(part));
}

function supportsTaskFollowup(
  task: Record<string, unknown>,
  projectedIssueNumber: number | undefined,
): boolean {
  const storedIssueNumber = positiveInteger(task.issue_number);
  return typeof task.repository === 'string'
    && isValidGithubRepository(task.repository)
    && storedIssueNumber !== undefined
    && storedIssueNumber === projectedIssueNumber;
}

/** Mirrors the pull request the task follow-up route resolves for PR commands. */
function supportsPullRequestFollowup(
  task: Record<string, unknown>,
  projectedPrNumber: number | undefined,
): boolean {
  if (typeof task.repository !== 'string' || !isValidGithubRepository(task.repository)) return false;
  const followupPrNumber = positiveInteger(task.pr_number) ?? positiveInteger(task.issue_number);
  return followupPrNumber !== undefined && followupPrNumber === projectedPrNumber;
}

function safeGithubPullRequestUrl(repository: string, prNumber: number): string | undefined {
  if (!isValidGithubRepository(repository)) return undefined;
  const parts = repository.split('/');
  return `https://github.com/${parts[0]}/${parts[1]}/pull/${prNumber}`;
}

function taskActions(options: {
  active?: boolean;
  followup?: boolean;
  hasPullRequest?: boolean;
}): NotificationEventAction[] {
  return [
    ...(options.active ? ['stop' as const] : []),
    ...(options.followup ? ['follow_up' as const] : []),
    ...(options.hasPullRequest ? ['open_pr' as const] : []),
    'dismiss',
  ];
}

function pullRequestAction(href: string | undefined) {
  return href === undefined
    ? {}
    : { action: { type: 'external_link' as const, label: 'Open pull request', href } };
}

function sourceMetadata(row: SourceActivityRow): Record<string, unknown> {
  return parseJsonObject(row.metadata_json);
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function normalizedTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return normalizeISO8601Timestamp(value);
  } catch {
    return undefined;
  }
}

function connectAccount(snapshot: SystemHealthSnapshot): Record<string, unknown> | undefined {
  return typeof snapshot.connectAccount === 'object'
    && snapshot.connectAccount !== null
    && !Array.isArray(snapshot.connectAccount)
    ? snapshot.connectAccount as Record<string, unknown>
    : undefined;
}

function connectSeatLimitBlock(account: Record<string, unknown>): ConnectSeatLimitBlock | undefined {
  const installationId = positiveInteger(account.installationId);
  const activeSeats = nonNegativeInteger(account.activeSeats);
  const allowedSeats = nonNegativeInteger(account.allowedSeats);
  const seatsRemaining = nonNegativeInteger(account.seatsRemaining);
  const billingCycleResetAt = normalizedTimestamp(account.billingCycleResetAt);
  const blockedAt = normalizedTimestamp(account.seatLimitBlockedAt);
  if (installationId === undefined
    || activeSeats === undefined
    || allowedSeats === undefined
    || seatsRemaining === undefined
    || billingCycleResetAt === undefined
    || blockedAt === undefined) return undefined;
  return {
    installationId,
    activeSeats,
    allowedSeats,
    seatsRemaining,
    billingCycleResetAt,
    blockedAt,
  };
}

/**
 * Converts the already-published lifecycle contracts into durable Inbox events.
 * Callers deliberately invoke these methods through `bestEffort`, keeping
 * notification persistence outside the success path of Redis and Socket.IO.
 */
export class NotificationProjectionService {
  private readonly database: Knex;
  private readonly notifications: NotificationEventWriter;
  private readonly now: () => Date;
  private readonly stalledAfterMs: number;
  private readonly stalledCheckIntervalMs: number;
  private readonly logger: ProjectionLogger;
  private readonly contentionRetryDelaysMs: readonly number[];
  private readonly closeController = new AbortController();
  private stalledTimer: NodeJS.Timeout | undefined;
  private readonly repositoryNotificationsEnabled?: (repository: string) => Promise<boolean>;
  private disabledRepositories: ReadonlySet<string> | null = null;
  private disabledRepositoriesLoadedAt = 0;
  private disabledRepositoriesLoad: Promise<ReadonlySet<string>> | null = null;

  constructor(options: NotificationProjectionOptions) {
    this.database = options.database;
    this.notifications = options.notificationService
      ?? new NotificationService({ database: options.database });
    this.now = options.now ?? (() => new Date());
    this.stalledAfterMs = resolveStalledAfterMs(options.stalledAfterMs);
    this.stalledCheckIntervalMs = options.stalledCheckIntervalMs ?? Math.min(
      MAX_STALLED_CHECK_INTERVAL_MS,
      Math.max(MIN_STALLED_CHECK_INTERVAL_MS, Math.floor(this.stalledAfterMs / 2)),
    );
    this.logger = options.logger ?? console;
    this.contentionRetryDelaysMs = options.contentionRetryDelaysMs
      ?? SQLITE_CONTENTION_RETRY_DELAYS_MS;
    this.repositoryNotificationsEnabled = options.repositoryNotificationsEnabled;
  }

  async bestEffort(label: string, projection: () => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      if (this.closeController.signal.aborted) return;
      try {
        await projection();
        return;
      } catch (error) {
        const retryDelay = this.contentionRetryDelaysMs[attempt];
        if (isSqliteContention(error) && retryDelay !== undefined) {
          // The API's dedicated background connection uses busy_timeout=0.
          // Yield between attempts so foreground reads continue while another
          // process owns SQLite's writer lock.
          await wait(retryDelay, this.closeController.signal);
          continue;
        }
        // Persistence errors may embed SQL bindings containing notification or
        // prompt text, so this boundary logs only the fixed projection label.
        this.logger.warn(`[NotificationProjection] Failed to project ${label}`);
        return;
      }
    }
  }

  startStalledDetector(): void {
    if (this.stalledTimer) return;
    void this.bestEffort('resolved activity cleanup', async () => {
      await this.cleanupResolvedActivities();
    });
    this.stalledTimer = setInterval(() => {
      void this.bestEffort('stalled activity', () => this.detectStalledActivities());
    }, this.stalledCheckIntervalMs);
    this.stalledTimer.unref();
  }

  close(): void {
    if (this.stalledTimer) clearInterval(this.stalledTimer);
    this.stalledTimer = undefined;
    this.closeController.abort();
  }

  async projectDraftUpdate(payload: DraftUpdatePayload): Promise<void> {
    if (!(payload.status === 'completed' && payload.draftStatus === 'review')) return;
    const draft = await this.database('task_drafts')
      .select('user_id', 'repository', 'name', 'plan_json')
      .where({ draft_id: payload.draftId })
      .first() as {
        user_id?: unknown; repository?: unknown; name?: unknown; plan_json?: unknown;
      } | undefined;
    if (typeof draft?.user_id !== 'string' || typeof draft.repository !== 'string') return;
    if (!await this.notificationsEnabledFor(draft.repository)) return;
    const occurredAt = normalizeISO8601Timestamp(payload.timestamp);
    const name = compactDisplayText(draft.name);
    const itemCount = planItemCount(draft.plan_json);
    const planName = name && name !== 'Untitled Plan' ? name : undefined;

    await this.notifications.createNotificationEvent({
      deduplicationKey: stableKey('plan-ready', payload.draftId, 'review', occurredAt),
      kind: 'plan',
      severity: 'success',
      target: { type: 'plan', repository: draft.repository, draftId: payload.draftId },
      title: planName ?? 'Plan ready for review',
      body: itemCount === undefined
        ? 'Ready for review.'
        : `Ready for review with ${itemCount} planned ${itemCount === 1 ? 'task' : 'tasks'}.`,
      actions: ['refine', 'approve_execute', 'dismiss'],
      occurredAt,
    }, [{ userId: draft.user_id, pushEnabled: true }]);
  }

  async projectTaskUpdate(payload: TaskUpdatePayload): Promise<void> {
    const status = activityStatusForTask(payload.state);
    if (!status) return;
    const context = await this.loadTaskContext(payload);
    if (!context) return;
    const occurredAt = normalizeISO8601Timestamp(payload.timestamp);
    const metadata: JsonObject = {
      ...(context.issueNumber === undefined ? {} : { issueNumber: context.issueNumber }),
      ...(context.prNumber === undefined ? {} : { prNumber: context.prNumber }),
      isReview: context.isReview,
      ...(context.description === undefined ? {} : { description: context.description }),
    };
    const accepted = await this.upsertSourceActivity({
      type: 'task',
      key: payload.taskId,
      repository: context.repository,
      status,
      occurredAt,
      metadata,
    });
    if (!accepted) return;
    // Activity bookkeeping above stays unconditional so stalled detection and
    // resolution cleanup remain correct; only the notification is filtered.
    if (!await this.notificationsEnabledFor(context.repository)) return;

    const recipients = await this.loadInstanceMemberRecipients();
    const pullRequestUrl = context.prNumber === undefined
      ? undefined
      : safeGithubPullRequestUrl(context.repository, context.prNumber);
    if (payload.state === 'failed') {
      await this.projectFailedTask({
        payload, context, occurredAt, recipients, pullRequestUrl,
      });
      return;
    }
    if (payload.state !== 'completed') return;

    if (context.isReview && context.prNumber !== undefined) {
      await this.projectCompletedReview(
        { payload, context, occurredAt, recipients, pullRequestUrl, prNumber: context.prNumber },
      );
    } else if (context.prNumber === undefined) {
      await this.projectCompletedImplementation(
        { payload, context, occurredAt, recipients, pullRequestUrl },
      );
    }

    if (!context.isReview && context.prNumber !== undefined) {
      await this.projectPullRequestAttention(
        { payload, context, occurredAt, recipients, pullRequestUrl, prNumber: context.prNumber },
      );
    }
  }

  async projectIndexingUpdate(payload: IndexingUpdatePayload): Promise<void> {
    const status = activityStatusForIndexing(payload.phase);
    if (!status) return;
    const occurredAt = normalizeISO8601Timestamp(payload.timestamp);
    const key = indexingActivityKey(payload.repository, payload.branch);
    const accepted = await this.upsertSourceActivity({
      type: 'indexing', key, repository: payload.repository, branch: payload.branch,
      status, occurredAt,
    });
    if (!accepted || payload.phase !== 'failed') return;
    if (!await this.notificationsEnabledFor(payload.repository)) return;
    const recipients = await this.loadAdministratorRecipients();

    await this.notifications.createNotificationEvent({
      deduplicationKey: stableKey(
        'indexing-failed', payload.repository, payload.branch ?? '', payload.phase, occurredAt,
      ),
      kind: 'indexing',
      severity: 'error',
      target: {
        type: 'indexing', repository: payload.repository,
        ...(payload.branch === undefined ? {} : { branch: payload.branch }),
      },
      title: 'Repository indexing failed',
      body: `Indexing ${payload.branch ? `branch ${payload.branch}` : 'the repository'} stopped before completion.`,
      actions: ['dismiss'],
      occurredAt,
    }, recipients);
  }

  async detectStalledActivities(): Promise<void> {
    await this.cleanupResolvedActivities();
    const cutoff = normalizeISO8601Timestamp(this.now().getTime() - this.stalledAfterMs);
    const rows = await this.database<SourceActivityRow>('notification_source_activity')
      .select(
        'activity_type', 'activity_key', 'repository', 'branch', 'status',
        'last_activity_at', 'metadata_json',
      )
      .whereNull('completed_at')
      .whereIn('status', ['queued', 'processing'])
      .where('last_activity_at', '<=', cutoff);

    for (const row of rows) {
      // Rows may predate the repository opting out, so re-check here.
      if (!await this.notificationsEnabledFor(row.repository)) continue;
      const metadata = sourceMetadata(row);
      if (row.activity_type === 'task') {
        const issueNumber = positiveInteger(metadata.issueNumber);
        const prNumber = positiveInteger(metadata.prNumber);
        const description = compactDisplayText(metadata.description);
        await this.notifications.createSourceActivityNotificationEvent({
          type: 'task', key: row.activity_key, repository: row.repository,
          lastActivityAt: row.last_activity_at,
        }, {
          deduplicationKey: stableKey(
            'task-stalled', row.activity_key, row.status, row.last_activity_at,
          ),
          kind: 'task',
          severity: 'warning',
          target: {
            type: 'task', repository: row.repository, taskId: row.activity_key,
            ...(issueNumber === undefined ? {} : { issueNumber }),
            ...(prNumber === undefined ? {} : { prNumber }),
          },
          title: 'Task appears stalled',
          body: description
            ? `${quotedDescription(description)} has not reported progress.`
            : `Active work for ${row.repository} has not reported progress.`,
          actions: taskActions({ active: true }),
          occurredAt: row.last_activity_at,
        }, await this.loadInstanceMemberRecipients());
      } else {
        await this.notifications.createSourceActivityNotificationEvent({
          type: 'indexing', key: row.activity_key, repository: row.repository,
          ...(row.branch === null ? {} : { branch: row.branch }),
          lastActivityAt: row.last_activity_at,
        }, {
          deduplicationKey: stableKey(
            'indexing-stalled', row.activity_key, row.status, row.last_activity_at,
          ),
          kind: 'indexing',
          severity: 'warning',
          target: {
            type: 'indexing', repository: row.repository,
            ...(row.branch === null ? {} : { branch: row.branch }),
          },
          title: 'Repository indexing appears stalled',
          body: `Indexing ${row.branch ? `branch ${row.branch}` : row.repository} has not reported progress.`,
          actions: ['dismiss'],
          occurredAt: row.last_activity_at,
        }, await this.loadAdministratorRecipients());
      }
    }
  }

  /**
   * Passively heals stale warning cards left by a missed lifecycle event or an
   * older server version. Immutable notification events remain available for
   * audit; only their active Inbox receipts are dismissed.
   */
  async cleanupResolvedActivities(): Promise<number> {
    return this.database.transaction(transaction =>
      this.dismissResolvedActivityReceipts(transaction));
  }

  async projectSystemSnapshot(
    snapshot: SystemHealthSnapshot,
    additionalAdministratorIds: readonly string[] = [],
  ): Promise<void> {
    const snapshotAt = normalizeISO8601Timestamp(snapshot.timestamp);
    const recipients = await this.loadAdministratorRecipients(additionalAdministratorIds);

    const account = connectAccount(snapshot);
    const seatLimitBlock = account && connectSeatLimitBlock(account);
    if (account && !(seatLimitBlock && seatLimitBlock.seatsRemaining === 0)) {
      // Seats are available again, so an earlier seat-limit card is stale. Most
      // health ticks have no such card; read first to keep them write-free.
      if (await this.hasActiveSystemFailureReceipt(CONNECT_SEAT_LIMIT_COMPONENT)) {
        await this.notifications.dismissSystemFailureNotifications(CONNECT_SEAT_LIMIT_COMPONENT);
      }
    } else if (seatLimitBlock && seatLimitBlock.blockedAt <= snapshotAt) {
      await this.notifications.createNotificationEvent({
        deduplicationKey: stableKey(
          'connect-seat-limit-blocked',
          seatLimitBlock.installationId,
          seatLimitBlock.blockedAt,
        ),
        kind: 'system_failure',
        severity: 'warning',
        target: { type: 'system_failure', component: CONNECT_SEAT_LIMIT_COMPONENT },
        title: 'GitHub event blocked by seat limit',
        body: `No developer seat was available when ProPR Connect received a GitHub event. Current usage is ${seatLimitBlock.activeSeats} of ${seatLimitBlock.allowedSeats}; the billing cycle resets at ${seatLimitBlock.billingCycleResetAt}.`,
        actions: ['dismiss'],
        metadata: {
          installationId: seatLimitBlock.installationId,
          activeSeats: seatLimitBlock.activeSeats,
          allowedSeats: seatLimitBlock.allowedSeats,
          seatsRemaining: seatLimitBlock.seatsRemaining,
          billingCycleResetAt: seatLimitBlock.billingCycleResetAt,
        },
        occurredAt: seatLimitBlock.blockedAt,
      }, recipients);
    }

    for (const [component, healthyValues] of Object.entries(SYSTEM_HEALTH_RULES)) {
      const rawStatus = snapshot[component];
      if (typeof rawStatus !== 'string') continue;
      const status = compactDisplayText(rawStatus) ?? 'unknown';
      const healthy = healthyValues.has(rawStatus);
      await this.notifications.reconcileSystemFailureTransition({
        component,
        status,
        healthy,
        snapshotAt,
        eventFor: (status, failureStartedAt) => ({
          deduplicationKey: stableKey(
            'system-failure', component, status, failureStartedAt,
          ),
          kind: 'system_failure',
          severity: 'error',
          target: { type: 'system_failure', component },
          title: `System component unhealthy: ${component}`,
          body: `${component} reported “${status}”; administrator attention may be required.`,
          actions: ['dismiss'],
          occurredAt: failureStartedAt,
        }),
      }, recipients);
    }
  }

  /**
   * Whether repository-scoped notifications may be produced for `repository`.
   * Fails open: a transient read failure must never hide a notification.
   */
  private async notificationsEnabledFor(repository: string): Promise<boolean> {
    if (this.repositoryNotificationsEnabled) {
      try {
        return await this.repositoryNotificationsEnabled(repository);
      } catch {
        return true;
      }
    }
    const disabled = await this.loadDisabledNotificationRepositories();
    return !disabled.has(repository.trim().toLowerCase());
  }

  private loadDisabledNotificationRepositories(): Promise<ReadonlySet<string>> {
    if (
      this.disabledRepositories !== null
      && this.now().getTime() - this.disabledRepositoriesLoadedAt < REPOSITORY_NOTIFICATION_CACHE_TTL_MS
    ) {
      return Promise.resolve(this.disabledRepositories);
    }
    // Share one in-flight read across concurrent projections.
    this.disabledRepositoriesLoad ??= this.readDisabledNotificationRepositories()
      .catch(() => {
        // Fail open, and cache the empty set for the TTL so a persistent read
        // failure cannot turn into a query storm on the hot path.
        this.logger.warn('[NotificationProjection] Failed to read repository notification settings');
        return new Set<string>() as ReadonlySet<string>;
      })
      .then(disabled => {
        this.disabledRepositories = disabled;
        this.disabledRepositoriesLoadedAt = this.now().getTime();
        return disabled;
      })
      .finally(() => { this.disabledRepositoriesLoad = null; });
    return this.disabledRepositoriesLoad;
  }

  private async readDisabledNotificationRepositories(): Promise<ReadonlySet<string>> {
    const row = await this.database('system_configs')
      .select('value')
      .where({ key: MONITORED_REPOS_CONFIG_KEY })
      .first() as { value?: unknown } | undefined;
    if (row?.value === undefined || row.value === null) return new Set<string>();
    const parsed: unknown = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    if (!Array.isArray(parsed)) return new Set<string>();

    // Mirrors resolveRepositoryNotificationsEnabled in the Web UI: a repository
    // is disabled only when every configured entry is explicitly false.
    const enabledByRepository = new Map<string, boolean>();
    for (const entry of parsed) {
      const record = typeof entry === 'object' && entry !== null
        ? entry as Record<string, unknown>
        : undefined;
      const name = typeof entry === 'string'
        ? entry
        : typeof record?.name === 'string' ? record.name : undefined;
      if (!name) continue;
      const key = name.trim().toLowerCase();
      const enabled = record?.notificationsEnabled !== false;
      enabledByRepository.set(key, (enabledByRepository.get(key) ?? false) || enabled);
    }
    return new Set([...enabledByRepository].filter(([, enabled]) => !enabled).map(([name]) => name));
  }

  private createPullRequestAwareEvent<K extends 'task' | 'review'>(
    input: CreateNotificationEventInput<K>,
    recipients: readonly NotificationRecipient[],
    repository: string,
    prNumber: number | undefined,
  ): Promise<{ id: string } | null> {
    if (prNumber === undefined) {
      return this.notifications.createNotificationEvent(input, recipients);
    }
    return this.notifications.createPullRequestNotificationEvent(
      repository,
      prNumber,
      input,
      recipients,
    );
  }

  private projectFailedTask(input: TaskEventProjection): Promise<{ id: string } | null> {
    const { payload, context, occurredAt, recipients, pullRequestUrl } = input;
    return this.createPullRequestAwareEvent({
      deduplicationKey: stableKey('task-failed', payload.taskId, payload.state, occurredAt),
      kind: 'task',
      severity: 'error',
      target: {
        type: 'task', repository: context.repository, taskId: payload.taskId,
        ...(context.issueNumber === undefined ? {} : { issueNumber: context.issueNumber }),
        ...(context.prNumber === undefined ? {} : { prNumber: context.prNumber }),
      },
      title: context.subjectTitle ?? (context.prNumber !== undefined
        ? `Task failed for PR #${context.prNumber}`
        : context.issueNumber !== undefined
          ? `Task failed for issue #${context.issueNumber}`
          : 'Task failed'),
      body: context.description
        ? `Could not complete ${quotedDescription(context.description)}.`
        : `Work for ${context.repository} did not complete.`,
      actions: taskActions({
        followup: context.followupEligible,
        hasPullRequest: pullRequestUrl !== undefined,
      }),
      ...pullRequestAction(pullRequestUrl),
      occurredAt,
    }, recipients, context.repository, context.prNumber);
  }

  private projectCompletedReview(
    input: PullRequestTaskEventProjection,
  ): Promise<{ id: string } | null> {
    const { payload, context, occurredAt, recipients, pullRequestUrl, prNumber } = input;
    return this.createPullRequestAwareEvent({
      deduplicationKey: stableKey('review-completed', payload.taskId, payload.state, occurredAt),
      kind: 'review',
      severity: 'success',
      target: {
        type: 'review', repository: context.repository,
        prNumber, taskId: payload.taskId,
      },
      title: context.subjectTitle ?? `Review completed for PR #${prNumber}`,
      body: context.recap ?? `Review of PR #${prNumber} completed; open details for the full findings.`,
      actions: taskActions({
        followup: context.reviewFollowupEligible,
        hasPullRequest: pullRequestUrl !== undefined,
      }),
      ...pullRequestAction(pullRequestUrl),
      occurredAt,
    }, recipients, context.repository, prNumber);
  }

  private projectCompletedImplementation(
    input: TaskEventProjection,
  ): Promise<{ id: string } | null> {
    const { payload, context, occurredAt, recipients, pullRequestUrl } = input;
    return this.createPullRequestAwareEvent({
      deduplicationKey: stableKey('implementation-completed', payload.taskId, payload.state, occurredAt),
      kind: 'task',
      severity: 'success',
      target: {
        type: 'task', repository: context.repository, taskId: payload.taskId,
        ...(context.issueNumber === undefined ? {} : { issueNumber: context.issueNumber }),
        ...(context.prNumber === undefined ? {} : { prNumber: context.prNumber }),
      },
      title: context.subjectTitle ?? context.description ?? (context.issueNumber === undefined
        ? 'Implementation completed'
        : `Issue #${context.issueNumber} implementation completed`),
      body: context.recap ?? distinctDescription(context) ?? (context.issueNumber === undefined
        ? 'Open task details to review the completed work.'
        : `Issue #${context.issueNumber} is complete. Open task details to review the result.`),
      actions: taskActions({
        followup: context.followupEligible,
        hasPullRequest: pullRequestUrl !== undefined,
      }),
      ...pullRequestAction(pullRequestUrl),
      occurredAt,
    }, recipients, context.repository, context.prNumber);
  }

  private projectPullRequestAttention(
    input: PullRequestTaskEventProjection,
  ): Promise<{ id: string } | null> {
    const { payload, context, occurredAt, recipients, pullRequestUrl, prNumber } = input;
    return this.notifications.createPullRequestAttentionNotificationEvent(
      context.repository,
      prNumber,
      {
        deduplicationKey: stableKey(
          'pr-attention', payload.taskId, prNumber, occurredAt,
        ),
        kind: 'pull_request',
        severity: 'info',
        target: {
          type: 'pull_request', repository: context.repository, prNumber,
        },
        title: completedPullRequestTitle(context, prNumber),
        body: context.recap ?? `PR #${prNumber} is ready for review.`,
        // Persist only the completing implementation identity, never arbitrary task metadata.
        metadata: {
          completedImplementationTaskId: payload.taskId,
          completionType: context.commandMode ?? 'implementation',
        },
        actions: [
          ...(context.pullRequestFollowupEligible ? ['follow_up' as const] : []),
          ...(pullRequestUrl === undefined ? [] : ['open_pr' as const]),
          'dismiss',
        ],
        ...pullRequestAction(pullRequestUrl),
        occurredAt,
      },
      recipients,
    );
  }

  private async loadCompletedHistoryMetadata(payload: TaskUpdatePayload): Promise<Record<string, unknown>> {
    if (payload.state !== 'completed') return {};
    const history = await this.database('task_history')
      .select('metadata')
      .where({ task_id: payload.taskId, timestamp: payload.timestamp })
      .first() as { metadata?: unknown } | undefined;
    return parseJsonObject(history?.metadata);
  }

  private async loadTaskContext(payload: TaskUpdatePayload): Promise<TaskContext | undefined> {
    const task = await this.database('tasks')
      .select('repository', 'issue_number', 'pr_number', 'task_type', 'initial_job_data')
      .where({ task_id: payload.taskId })
      .first() as Record<string, unknown> | undefined;
    if (!task) return undefined;
    const initial = parseJsonObject(task.initial_job_data);
    const historyMetadata = await this.loadCompletedHistoryMetadata(payload);
    const prResult = typeof historyMetadata.prResult === 'object' && historyMetadata.prResult !== null
      ? historyMetadata.prResult as Record<string, unknown>
      : {};
    const repository = typeof task.repository === 'string'
      ? task.repository
      : payload.repository;
    if (typeof repository !== 'string') return undefined;
    const taskType = typeof task.task_type === 'string' ? task.task_type : '';
    const isPullRequestTask = taskType === 'review'
      || taskType === 'pr-comment'
      || payload.taskId.startsWith('pr-comments-batch-')
      || positiveInteger(initial.pullRequestNumber) !== undefined;
    const prNumber = positiveInteger(task.pr_number)
      ?? positiveInteger(initial.pullRequestNumber)
      ?? positiveInteger(initial.prNumber)
      ?? positiveInteger(prResult.prNumber)
      ?? (isPullRequestTask ? positiveInteger(initial.number) : undefined);
    const isReview = taskType === 'review' || historyMetadata.commandMode === 'review';
    const commandMode = resolveCommandMode(historyMetadata, initial);
    const storedIssueNumber = positiveInteger(task.issue_number);
    const issueNumber = positiveInteger(payload.issueNumber) ?? storedIssueNumber;
    return {
      repository,
      issueNumber,
      prNumber,
      description: taskDescription(initial),
      subjectTitle: subjectTitle(initial),
      recap: notificationRecap(historyMetadata),
      commandMode,
      isReview,
      followupEligible: supportsTaskFollowup(task, issueNumber),
      reviewFollowupEligible: supportsTaskFollowup(task, prNumber),
      pullRequestFollowupEligible: supportsPullRequestFollowup(task, prNumber),
    };
  }

  private async upsertSourceActivity(input: {
    type: 'task' | 'indexing';
    key: string;
    repository: string;
    branch?: string;
    status: SourceActivityStatus;
    occurredAt: string;
    metadata?: JsonObject;
  }): Promise<boolean> {
    const completedAt = TERMINAL_ACTIVITY_STATUSES.has(input.status) ? input.occurredAt : null;
    const values = {
        activity_type: input.type,
        activity_key: input.key,
        repository: input.repository,
        branch: input.branch ?? null,
        status: input.status,
        last_activity_at: input.occurredAt,
        completed_at: completedAt,
        metadata_json: input.metadata === undefined ? null : JSON.stringify(input.metadata),
        created_at: input.occurredAt,
        updated_at: input.occurredAt,
    };
    return this.database.transaction(async transaction => {
      const existing = await transaction('notification_source_activity')
        .select('status', 'last_activity_at')
        .where({ activity_type: input.type, activity_key: input.key })
        .first() as { status?: unknown; last_activity_at?: unknown } | undefined;
      if (existing !== undefined && (
        typeof existing.last_activity_at !== 'string'
        || input.occurredAt < existing.last_activity_at
      )) return false;
      if (
        typeof existing?.status === 'string'
        && TERMINAL_ACTIVITY_STATUSES.has(existing.status)
        && !TERMINAL_ACTIVITY_STATUSES.has(input.status)
      ) {
        if (typeof existing.last_activity_at !== 'string'
          || input.occurredAt <= existing.last_activity_at) return false;
        await transaction('notification_source_activity')
          .where({
            activity_type: input.type,
            activity_key: input.key,
            last_activity_at: existing.last_activity_at,
          })
          .delete();
      }

      await transaction('notification_source_activity')
        .insert(values)
        .onConflict(['activity_type', 'activity_key'])
        .merge({
          repository: input.repository,
          branch: input.branch ?? null,
          status: input.status,
          last_activity_at: input.occurredAt,
          completed_at: completedAt,
          metadata_json: input.metadata === undefined ? null : JSON.stringify(input.metadata),
        });
      const stored = await transaction('notification_source_activity')
        .select('status', 'last_activity_at')
        .where({ activity_type: input.type, activity_key: input.key })
        .first() as { status?: unknown; last_activity_at?: unknown } | undefined;
      const accepted = stored?.status === input.status
        && stored.last_activity_at === input.occurredAt;
      if (accepted && completedAt !== null) {
        await this.dismissResolvedActivityReceipts(transaction);
      }
      return accepted;
    });
  }

  private async dismissResolvedActivityReceipts(
    transaction: Knex.Transaction,
  ): Promise<number> {
    const timestamp = normalizeISO8601Timestamp(this.now());
    // Stalled warnings resolve on any terminal transition; failures resolve
    // once the same task or indexing source later completes successfully.
    const resolvedActivity = (
      activity: Knex.QueryBuilder,
      type: 'task' | 'indexing',
    ): Knex.QueryBuilder => activity
      .select(transaction.raw('1'))
      .from('notification_source_activity as activity')
      .where({ 'activity.activity_type': type })
      .whereNotNull('activity.completed_at')
      .andWhere((resolution) => {
        resolution.where({ 'event.severity': 'warning' }).orWhere((recovery) => {
          recovery.where({ 'event.severity': 'error', 'activity.status': 'completed' })
            .whereRaw('activity.last_activity_at > event.occurred_at');
        });
      });
    const resolvedEvents = transaction('notification_events as event')
      .select('event.event_id')
      .whereIn('event.severity', ['warning', 'error'])
      .andWhere((resolvable) => {
        resolvable.where((task) => {
          task.where({ 'event.kind': 'task' }).whereExists(function resolvedTask() {
            resolvedActivity(this, 'task').whereRaw(
              "activity.activity_key = json_extract(event.target_json, '$.taskId')",
            );
          });
        }).orWhere((indexing) => {
          indexing.where({ 'event.kind': 'indexing' })
            .whereExists(function resolvedIndexing() {
              resolvedActivity(this, 'indexing')
                .whereRaw(
                  "activity.repository = json_extract(event.target_json, '$.repository')",
                )
                .whereRaw(
                  "activity.branch IS json_extract(event.target_json, '$.branch')",
                );
            });
        });
      });
    const changed = await transaction('notification_user_states')
      .where({ inbox_enabled: true })
      .whereNull('dismissed_at')
      .whereIn('event_id', resolvedEvents)
      .update({
        dismissed_at: transaction.raw(
          'CASE WHEN created_at > ? THEN created_at ELSE ? END',
          [timestamp, timestamp],
        ),
      });
    return Number(changed);
  }

  private async hasActiveSystemFailureReceipt(component: string): Promise<boolean> {
    const receipt = await this.database('notification_user_states as receipt')
      .join('notification_events as event', 'event.event_id', 'receipt.event_id')
      .where({ 'receipt.inbox_enabled': true, 'event.kind': 'system_failure' })
      .whereNull('receipt.dismissed_at')
      .whereRaw("json_extract(event.target_json, '$.component') = ?", [component])
      .first('receipt.event_id');
    return receipt !== undefined;
  }

  private async loadInstanceMemberRecipients(): Promise<NotificationRecipient[]> {
    const rows = await this.database('instance_members').distinct('github_user_id') as Array<{
      github_user_id?: unknown;
    }>;
    return rows.flatMap(row => typeof row.github_user_id === 'string'
      ? [{ userId: row.github_user_id, pushEnabled: true }]
      : []);
  }

  private async loadAdministratorRecipients(
    additionalIds: readonly string[] = [],
  ): Promise<NotificationRecipient[]> {
    const rows = await this.database('instance_members')
      .distinct('github_user_id')
      .where({ role: 'admin' }) as Array<{ github_user_id?: unknown }>;
    return [...new Set([
      ...rows.flatMap(row => typeof row.github_user_id === 'string' ? [row.github_user_id] : []),
      ...additionalIds,
    ])].map(userId => ({ userId, pushEnabled: true }));
  }
}

export { safeGithubPullRequestUrl };
