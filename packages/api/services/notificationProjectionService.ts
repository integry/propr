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

type SourceActivityStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

interface ProjectionLogger {
  warn(message: string, error?: unknown): void;
}

type NotificationEventWriter = Pick<NotificationService,
  'createNotificationEvent' | 'createPullRequestNotificationEvent'
  | 'createPullRequestAttentionNotificationEvent'
  | 'reconcileSystemFailureTransition'>;

export interface NotificationProjectionOptions {
  database: Knex;
  notificationService?: NotificationEventWriter;
  now?: () => Date;
  stalledAfterMs?: number;
  stalledCheckIntervalMs?: number;
  logger?: ProjectionLogger;
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
  isReview: boolean;
  followupEligible: boolean;
  reviewFollowupEligible: boolean;
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

const SYSTEM_HEALTH_RULES: Readonly<Record<string, ReadonlySet<string>>> = {
  api: new Set(['healthy']),
  redis: new Set(['connected']),
  daemon: new Set(['running']),
  worker: new Set(['running']),
  githubAuth: new Set(['connected']),
  githubEventIntakeStatus: new Set(['connected', 'active']),
  claudeAuth: new Set(['connected']),
  indexing: new Set(['idle', 'active', 'queued']),
};

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
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

function taskDescription(initial: Record<string, unknown>): string | undefined {
  const issueRef = typeof initial.issueRef === 'object'
    && initial.issueRef !== null
    && !Array.isArray(initial.issueRef)
    ? initial.issueRef as Record<string, unknown>
    : {};
  return compactDisplayText(initial.subtitle)
    ?? compactDisplayText(initial.title)
    ?? compactDisplayText(issueRef.title);
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
  private stalledTimer: NodeJS.Timeout | undefined;

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
  }

  async bestEffort(label: string, projection: () => Promise<void>): Promise<void> {
    try {
      await projection();
    } catch {
      // Persistence errors may embed SQL bindings containing notification or
      // prompt text, so this boundary logs only the fixed projection label.
      this.logger.warn(`[NotificationProjection] Failed to project ${label}`);
    }
  }

  startStalledDetector(): void {
    if (this.stalledTimer) return;
    this.stalledTimer = setInterval(() => {
      void this.bestEffort('stalled activity', () => this.detectStalledActivities());
    }, this.stalledCheckIntervalMs);
    this.stalledTimer.unref();
  }

  close(): void {
    if (this.stalledTimer) clearInterval(this.stalledTimer);
    this.stalledTimer = undefined;
  }

  async projectDraftUpdate(payload: DraftUpdatePayload): Promise<void> {
    if (!(payload.status === 'completed' && payload.draftStatus === 'review')) return;
    const draft = await this.database('task_drafts')
      .select('user_id', 'repository')
      .where({ draft_id: payload.draftId })
      .first() as { user_id?: unknown; repository?: unknown } | undefined;
    if (typeof draft?.user_id !== 'string' || typeof draft.repository !== 'string') return;
    const occurredAt = normalizeISO8601Timestamp(payload.timestamp);

    await this.notifications.createNotificationEvent({
      deduplicationKey: stableKey('plan-ready', payload.draftId, 'review', occurredAt),
      kind: 'plan',
      severity: 'success',
      target: { type: 'plan', repository: draft.repository, draftId: payload.draftId },
      title: 'Plan ready for review',
      body: `A plan for ${draft.repository} is ready for review.`,
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

    const recipients = await this.loadInstanceMemberRecipients();
    const pullRequestUrl = context.prNumber === undefined
      ? undefined
      : safeGithubPullRequestUrl(context.repository, context.prNumber);
    if (payload.state === 'failed') {
      await this.createPullRequestAwareEvent({
        deduplicationKey: stableKey('task-failed', payload.taskId, payload.state, occurredAt),
        kind: 'task',
        severity: 'error',
        target: {
          type: 'task', repository: context.repository, taskId: payload.taskId,
          ...(context.issueNumber === undefined ? {} : { issueNumber: context.issueNumber }),
          ...(context.prNumber === undefined ? {} : { prNumber: context.prNumber }),
        },
        title: context.prNumber !== undefined
          ? `Task failed for PR #${context.prNumber}`
          : context.issueNumber !== undefined
            ? `Task failed for issue #${context.issueNumber}`
            : 'Task failed',
        body: context.description ?? `Work for ${context.repository} did not complete.`,
        actions: taskActions({
          followup: context.followupEligible,
          hasPullRequest: pullRequestUrl !== undefined,
        }),
        ...pullRequestAction(pullRequestUrl),
        occurredAt,
      }, recipients, context.repository, context.prNumber);
      return;
    }
    if (payload.state !== 'completed') return;

    if (context.isReview && context.prNumber !== undefined) {
      await this.createPullRequestAwareEvent({
        deduplicationKey: stableKey('review-completed', payload.taskId, payload.state, occurredAt),
        kind: 'review',
        severity: 'success',
        target: {
          type: 'review', repository: context.repository,
          prNumber: context.prNumber, taskId: payload.taskId,
        },
        title: `Review completed for PR #${context.prNumber}`,
        body: context.description ?? `Review of PR #${context.prNumber} is complete.`,
        actions: taskActions({
          followup: context.reviewFollowupEligible,
          hasPullRequest: pullRequestUrl !== undefined,
        }),
        ...pullRequestAction(pullRequestUrl),
        occurredAt,
      }, recipients, context.repository, context.prNumber);
    } else if (context.prNumber === undefined) {
      await this.createPullRequestAwareEvent({
        deduplicationKey: stableKey('implementation-completed', payload.taskId, payload.state, occurredAt),
        kind: 'task',
        severity: 'success',
        target: {
          type: 'task', repository: context.repository, taskId: payload.taskId,
          ...(context.issueNumber === undefined ? {} : { issueNumber: context.issueNumber }),
          ...(context.prNumber === undefined ? {} : { prNumber: context.prNumber }),
        },
        title: context.issueNumber === undefined
          ? 'Implementation completed'
          : `Implementation completed for issue #${context.issueNumber}`,
        body: context.description
          ?? `Implementation work for ${context.repository} is complete.`,
        actions: taskActions({
          followup: context.followupEligible,
          hasPullRequest: pullRequestUrl !== undefined,
        }),
        ...pullRequestAction(pullRequestUrl),
        occurredAt,
      }, recipients, context.repository, context.prNumber);
    }

    if (!context.isReview && context.prNumber !== undefined) {
      await this.notifications.createPullRequestAttentionNotificationEvent(
        context.repository,
        context.prNumber,
        {
          deduplicationKey: stableKey(
            'pr-attention', payload.taskId, context.prNumber, occurredAt,
          ),
          kind: 'pull_request',
          severity: 'info',
          target: {
            type: 'pull_request', repository: context.repository, prNumber: context.prNumber,
          },
          title: `PR #${context.prNumber} ready for review`,
          body: context.description
            ?? `Implementation is complete; review the changes in ${context.repository}.`,
          actions: [
            ...(pullRequestUrl === undefined ? [] : ['open_pr' as const]),
            'dismiss',
          ],
          ...pullRequestAction(pullRequestUrl),
          occurredAt,
        },
        recipients,
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
      body: `Indexing did not complete for ${payload.repository}.`,
      actions: ['dismiss'],
      occurredAt,
    }, recipients);
  }

  async detectStalledActivities(): Promise<void> {
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
      const metadata = sourceMetadata(row);
      if (row.activity_type === 'task') {
        const issueNumber = positiveInteger(metadata.issueNumber);
        const prNumber = positiveInteger(metadata.prNumber);
        await this.createPullRequestAwareEvent({
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
          body: `Active work for ${row.repository} has not reported progress.`,
          actions: taskActions({ active: true }),
          occurredAt: row.last_activity_at,
        }, await this.loadInstanceMemberRecipients(), row.repository, prNumber);
      } else {
        await this.notifications.createNotificationEvent({
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
          body: `Indexing for ${row.repository} has not reported progress.`,
          actions: ['dismiss'],
          occurredAt: row.last_activity_at,
        }, await this.loadAdministratorRecipients());
      }
    }
  }

  async projectSystemSnapshot(
    snapshot: SystemHealthSnapshot,
    additionalAdministratorIds: readonly string[] = [],
  ): Promise<void> {
    const snapshotAt = normalizeISO8601Timestamp(snapshot.timestamp);
    const recipients = await this.loadAdministratorRecipients(additionalAdministratorIds);

    for (const [component, healthyValues] of Object.entries(SYSTEM_HEALTH_RULES)) {
      const rawStatus = snapshot[component];
      if (typeof rawStatus !== 'string') continue;
      const healthy = healthyValues.has(rawStatus);
      await this.notifications.reconcileSystemFailureTransition({
        component,
        status: rawStatus,
        healthy,
        snapshotAt,
        eventFor: (status, failureStartedAt) => ({
          deduplicationKey: stableKey(
            'system-failure', component, status, failureStartedAt,
          ),
          kind: 'system_failure',
          severity: 'error',
          target: { type: 'system_failure', component },
          title: 'System component unhealthy',
          body: `${component} is not reporting a healthy status.`,
          actions: ['dismiss'],
          occurredAt: failureStartedAt,
        }),
      }, recipients);
    }
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

  private async loadTaskContext(payload: TaskUpdatePayload): Promise<TaskContext | undefined> {
    const task = await this.database('tasks')
      .select('repository', 'issue_number', 'pr_number', 'task_type', 'initial_job_data')
      .where({ task_id: payload.taskId })
      .first() as Record<string, unknown> | undefined;
    if (!task) return undefined;
    const initial = parseJsonObject(task.initial_job_data);
    const history = payload.state === 'completed'
      ? await this.database('task_history')
        .select('metadata')
        .where({ task_id: payload.taskId, timestamp: payload.timestamp })
        .first() as { metadata?: unknown } | undefined
      : undefined;
    const historyMetadata = parseJsonObject(history?.metadata);
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
    const storedIssueNumber = positiveInteger(task.issue_number);
    const issueNumber = positiveInteger(payload.issueNumber) ?? storedIssueNumber;
    return {
      repository,
      issueNumber,
      prNumber,
      description: taskDescription(initial),
      isReview,
      followupEligible: supportsTaskFollowup(task, issueNumber),
      reviewFollowupEligible: supportsTaskFollowup(task, prNumber),
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
      return stored?.status === input.status && stored.last_activity_at === input.occurredAt;
    });
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
