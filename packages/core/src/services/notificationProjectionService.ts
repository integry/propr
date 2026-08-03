/* eslint-disable max-lines -- projection dispatch and notification creation share one orchestration boundary */
import type { Knex } from 'knex';
import {
    DRAFT_UPDATE,
    INDEXING_UPDATE,
    TASK_LIVE_UPDATE,
    TASK_UPDATE,
    normalizeISO8601Timestamp,
    type DraftUpdatePayload,
    type EventPayload,
    type IndexingUpdatePayload,
    type TaskLiveUpdatePayload,
    type TaskUpdatePayload
} from '@propr/shared';
import { db } from '../db/connection.js';
import logger from '../utils/logger.js';
import { NotificationService } from './notificationService.js';
import { NotificationProjectionReconciler } from './notificationProjectionReconciler.js';
import {
    NotificationProjectionStore,
    buildProjectionDeduplicationKey,
    isTerminalActivity,
    type IndexingTransitionIdentity,
    type SourceActivityRow,
    type TaskProjectionContext,
    type TaskTransitionIdentity
} from './notificationProjectionStore.js';
import {
    indexingActivityStatus,
    parseActivityMetadata,
    safePullRequestUrl,
    safeTaskMetadata,
    taskAction,
    taskActivityStatus,
    taskBodySubject,
    taskTarget
} from './notificationProjectionFormatting.js';

type TimestampInput = string | number | Date;

function stablePayloadTransitionTimestamp(
    value: unknown,
    publishedAt: ReturnType<typeof normalizeISO8601Timestamp>
): ReturnType<typeof normalizeISO8601Timestamp> | undefined {
    if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
        return undefined;
    }
    try {
        const timestamp = normalizeISO8601Timestamp(value);
        return timestamp <= publishedAt ? timestamp : undefined;
    } catch {
        return undefined;
    }
}

function positiveSequence(value: unknown): number | undefined {
    const numeric = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    return typeof numeric === 'number' && Number.isSafeInteger(numeric) && numeric > 0
        ? numeric
        : undefined;
}

function nonBlankString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export interface NotificationProjectionServiceOptions {
    database?: Knex;
    notificationService?: NotificationService;
    now?: () => TimestampInput;
}

export class NotificationProjectionService {
    private readonly database: Knex;
    private readonly notifications: NotificationService;
    private readonly store: NotificationProjectionStore;
    private readonly reconciler: NotificationProjectionReconciler;
    private readonly now: () => TimestampInput;

    constructor(options: NotificationProjectionServiceOptions = {}) {
        this.database = options.database ?? db;
        this.now = options.now ?? (() => new Date());
        this.notifications = options.notificationService ?? new NotificationService({
            database: this.database,
            now: this.now
        });
        this.store = new NotificationProjectionStore(this.database, this.now);
        this.reconciler = new NotificationProjectionReconciler({
            database: this.database,
            now: this.now,
            projectTaskUpdate: (payload) => this.projectTaskUpdate(payload),
            projectIndexingUpdate: (payload) => this.projectIndexingUpdate(payload),
            projectDraftUpdate: (payload) => this.projectDraftUpdate(payload)
        });
    }

    async projectUpdate(payload: EventPayload): Promise<void> {
        switch (payload.eventType) {
            case DRAFT_UPDATE:
                await this.projectDraftUpdate(payload);
                return;
            case TASK_UPDATE:
                await this.projectTaskUpdate(payload);
                return;
            case TASK_LIVE_UPDATE:
                await this.projectTaskHeartbeat(payload);
                return;
            case INDEXING_UPDATE:
                await this.projectIndexingUpdate(payload);
                return;
            default:
                return;
        }
    }

    async projectDraftUpdate(payload: DraftUpdatePayload): Promise<void> {
        if (payload.draftStatus !== 'review' || payload.status !== 'completed') return;
        const publishedAt = normalizeISO8601Timestamp(payload.timestamp);
        const context = await this.store.getDraftContext(payload.draftId);
        if (!context || (context.status !== undefined && context.status !== 'review')) return;
        const timestamp = context.reviewTransitionAt && context.reviewTransitionAt <= publishedAt
            ? context.reviewTransitionAt
            : publishedAt;
        await this.database.transaction(async (transaction) => {
            const recipients = await this.store.filterCurrentlyEntitled(
                context.repository,
                [context.userId],
                transaction
            );
            if (recipients.length === 0) return;
            await this.notifications.createNotificationEventInTransaction(transaction, {
                deduplicationKey: buildProjectionDeduplicationKey(
                    'draft', context.draftId, 'review', timestamp
                ),
                kind: 'plan',
                severity: 'success',
                target: {
                    type: 'plan',
                    repository: context.repository,
                    draftId: context.draftId
                },
                title: 'Plan ready for review',
                body: `A plan for ${context.repository} is ready for review.`,
                action: {
                    type: 'navigate',
                    label: 'Review plan',
                    href: `/plans/${encodeURIComponent(context.draftId)}`
                },
                metadata: { transitionState: 'review', transitionAt: timestamp },
                occurredAt: timestamp,
                recipients
            });
        });
    }

    async projectTaskUpdate(payload: TaskUpdatePayload): Promise<void> {
        const publishedAt = normalizeISO8601Timestamp(payload.timestamp);
        const preferredTimestamp = stablePayloadTransitionTimestamp(
            payload.metadata?.transitionAt,
            publishedAt
        );
        const transition = await this.store.resolveTaskTransition(
            payload.taskId,
            payload.state,
            publishedAt,
            preferredTimestamp,
            positiveSequence(payload.metadata?.transitionSequence)
        );
        const context = await this.store.getTaskContext(payload.taskId, payload);
        if (!context) return;
        const activityStatus = taskActivityStatus(payload.state);
        const safeMetadata = safeTaskMetadata(context, activityStatus, transition.timestamp);

        // Heartbeats and non-terminal transitions do not perform recipient scans.
        if (!isTerminalActivity(activityStatus)) {
            await this.database.transaction((transaction) => this.store.upsertTaskActivity({
                context,
                status: activityStatus,
                transition,
                metadata: safeMetadata
            }, transaction));
            return;
        }

        // Cancellation is terminal for checkpointing and stale-event isolation,
        // but it is not a successful implementation or review completion.
        if (activityStatus === 'cancelled') {
            await this.database.transaction((transaction) => this.store.upsertTaskActivity({
                context,
                status: activityStatus,
                transition,
                metadata: safeMetadata
            }, transaction));
            return;
        }

        const recipients = await this.store.getTaskRecipients(context);
        await this.database.transaction(async (transaction) => {
            const decision = await this.store.upsertTaskActivity({
                context,
                status: activityStatus,
                transition,
                metadata: safeMetadata
            }, transaction);
            if (decision === 'stale') return;
            const entitledRecipients = await this.store.filterCurrentlyEntitled(
                context.repository,
                recipients,
                transaction
            );
            if (entitledRecipients.length === 0) return;

            // Re-run every expected idempotent delivery for a current transition.
            // This repairs equal-timestamp enrichment and any prior failed attempt.
            if (activityStatus === 'failed') {
                await this.createTaskFailure(context, transition, entitledRecipients, transaction);
            } else if (context.commandMode === 'review') {
                await this.createReviewCompletion(context, transition, entitledRecipients, transaction);
            } else {
                await this.createImplementationCompletion(context, transition, entitledRecipients, transaction);
                await this.createPullRequestAttention(context, transition, entitledRecipients, transaction);
            }
        });
    }

    async projectTaskHeartbeat(payload: TaskLiveUpdatePayload): Promise<void> {
        await this.store.touchTaskActivity(
            payload.taskId,
            normalizeISO8601Timestamp(payload.timestamp),
            payload.activityKind ?? 'progress'
        );
    }

    async projectIndexingUpdate(payload: IndexingUpdatePayload): Promise<void> {
        const publishedAt = normalizeISO8601Timestamp(payload.timestamp);
        const runId = nonBlankString(payload.runId);
        if (runId === undefined) return;
        const status = indexingActivityStatus(payload.phase);
        const transition = await this.store.resolveIndexingTransition(
            payload.repository,
            payload.branch,
            status,
            publishedAt,
            stablePayloadTransitionTimestamp(payload.transitionAt, publishedAt),
            runId
        );
        const input = {
            repository: payload.repository,
            ...(payload.branch === undefined ? {} : { branch: payload.branch }),
            status,
            observedAt: publishedAt,
            transition
        };

        if (status !== 'failed') {
            await this.database.transaction((transaction) =>
                this.store.upsertIndexingActivity(input, transaction)
            );
            return;
        }

        const recipients = await this.store.getRepositoryRecipients(payload.repository);
        await this.database.transaction(async (transaction) => {
            const decision = await this.store.upsertIndexingActivity(input, transaction);
            if (decision === 'stale') return;
            const entitledRecipients = await this.store.filterCurrentlyEntitled(
                payload.repository,
                recipients,
                transaction
            );
            if (entitledRecipients.length === 0) return;
            await this.createIndexingFailure(payload, transition, entitledRecipients, transaction);
        });
    }

    async reconcileTerminalTransitions(
        shouldContinue: () => boolean = () => true
    ): Promise<number> {
        return this.reconciler.reconcile(shouldContinue);
    }

    async detectStalledActivities(
        stalledAfterMs: number,
        now: TimestampInput = this.now(),
        shouldContinue: () => boolean = () => true
    ): Promise<number> {
        if (!Number.isSafeInteger(stalledAfterMs) || stalledAfterMs <= 0) {
            throw new TypeError('stalledAfterMs must be a positive safe integer');
        }
        const currentTimestamp = normalizeISO8601Timestamp(now);
        const cutoff = normalizeISO8601Timestamp(Date.parse(currentTimestamp) - stalledAfterMs);
        const stalled = await this.store.getStalledActivities(cutoff);
        let claimed = 0;
        for (const activity of stalled) {
            if (!shouldContinue()) break;
            const { taskContext, recipients } = await this.getStalledRecipients(activity);
            if (!shouldContinue()) break;
            const created = await this.database.transaction(async (transaction) => {
                if (!shouldContinue()) return false;
                const entitledRecipients = await this.store.filterCurrentlyEntitled(
                    activity.repository,
                    recipients,
                    transaction
                );
                if (!shouldContinue()) {
                    throw new Error('Notification stalled-activity projection lease was lost');
                }
                // Do not consume the durable stall claim until there is somebody
                // authorized to receive it. A later entitlement refresh can then
                // reconsider the same unchanged activity.
                if (entitledRecipients.length === 0) return false;
                if (!await this.store.claimStalledActivity(activity, currentTimestamp, transaction)) return false;
                await this.createStalledNotification({
                    activity,
                    detectedAt: currentTimestamp,
                    taskContext,
                    recipients: entitledRecipients,
                    transaction
                });
                if (!shouldContinue()) {
                    throw new Error('Notification stalled-activity projection lease was lost');
                }
                return true;
            });
            if (created) claimed++;
        }
        return claimed;
    }

    private async createTaskFailure(
        context: TaskProjectionContext,
        transition: TaskTransitionIdentity,
        recipients: string[],
        transaction: Knex.Transaction
    ): Promise<void> {
        await this.notifications.createNotificationEventInTransaction(transaction, {
            deduplicationKey: buildProjectionDeduplicationKey(
                'task', context.taskId, 'failed', transition.timestamp, transition.sequence
            ),
            kind: 'task',
            severity: 'error',
            target: taskTarget(context),
            title: 'Task failed',
            body: `${taskBodySubject(context)} in ${context.repository} failed and needs attention.`,
            action: taskAction(context.taskId),
            metadata: safeTaskMetadata(context, 'failed', transition.timestamp),
            occurredAt: transition.timestamp,
            recipients
        });
    }

    private async createImplementationCompletion(
        context: TaskProjectionContext,
        transition: TaskTransitionIdentity,
        recipients: string[],
        transaction: Knex.Transaction
    ): Promise<void> {
        await this.notifications.createNotificationEventInTransaction(transaction, {
            deduplicationKey: buildProjectionDeduplicationKey(
                'task', context.taskId, 'completed', transition.timestamp, transition.sequence
            ),
            kind: 'task',
            severity: 'success',
            target: taskTarget(context),
            title: 'Implementation completed',
            body: `${taskBodySubject(context)} in ${context.repository} completed.`,
            action: taskAction(context.taskId),
            metadata: safeTaskMetadata(context, 'completed', transition.timestamp),
            occurredAt: transition.timestamp,
            recipients
        });
    }

    private async createReviewCompletion(
        context: TaskProjectionContext,
        transition: TaskTransitionIdentity,
        recipients: string[],
        transaction: Knex.Transaction
    ): Promise<void> {
        if (context.prNumber === undefined) return;
        await this.notifications.createNotificationEventInTransaction(transaction, {
            deduplicationKey: buildProjectionDeduplicationKey(
                'review', context.taskId, 'completed', transition.timestamp, transition.sequence
            ),
            kind: 'review',
            severity: 'success',
            target: {
                type: 'review',
                repository: context.repository,
                prNumber: context.prNumber,
                taskId: context.taskId
            },
            title: 'Review completed',
            body: `Review work for pull request #${context.prNumber} in ${context.repository} completed.`,
            action: taskAction(context.taskId),
            metadata: safeTaskMetadata(context, 'completed', transition.timestamp),
            occurredAt: transition.timestamp,
            recipients
        });
    }

    private async createPullRequestAttention(
        context: TaskProjectionContext,
        transition: TaskTransitionIdentity,
        recipients: string[],
        transaction: Knex.Transaction
    ): Promise<void> {
        const prUrl = safePullRequestUrl(context);
        if (context.prNumber === undefined || prUrl === undefined) return;
        await this.notifications.createNotificationEventInTransaction(transaction, {
            deduplicationKey: buildProjectionDeduplicationKey(
                'pull-request',
                `${context.repository}#${context.prNumber}`,
                'attention',
                transition.timestamp,
                transition.sequence
            ),
            kind: 'pull_request',
            severity: 'success',
            target: {
                type: 'pull_request',
                repository: context.repository,
                prNumber: context.prNumber
            },
            title: 'Pull request ready for attention',
            body: `Pull request #${context.prNumber} in ${context.repository} is ready: ${prUrl}`,
            action: { type: 'external_link', label: 'Open pull request', href: prUrl },
            metadata: {
                prNumber: context.prNumber,
                transitionState: 'attention',
                transitionAt: transition.timestamp
            },
            occurredAt: transition.timestamp,
            recipients
        });
    }

    private async createIndexingFailure(
        payload: IndexingUpdatePayload,
        transition: IndexingTransitionIdentity,
        recipients: string[],
        transaction: Knex.Transaction
    ): Promise<void> {
        await this.notifications.createNotificationEventInTransaction(transaction, {
            deduplicationKey: buildProjectionDeduplicationKey(
                'indexing',
                `${payload.repository}\0${payload.branch ?? ''}`,
                'failed',
                transition.timestamp,
                transition.runId
            ),
            kind: 'indexing',
            severity: 'error',
            target: {
                type: 'indexing',
                repository: payload.repository,
                ...(payload.branch === undefined ? {} : { branch: payload.branch })
            },
            title: 'Repository indexing failed',
            body: `Indexing for ${payload.repository}${payload.branch ? ` (${payload.branch})` : ''} failed.`,
            metadata: { transitionState: 'failed', transitionAt: transition.timestamp },
            occurredAt: transition.timestamp,
            recipients
        });
    }

    private async getStalledRecipients(activity: SourceActivityRow): Promise<{
        taskContext: TaskProjectionContext;
        recipients: string[];
    }> {
        const metadata = parseActivityMetadata(activity);
        const fallbackContext: TaskProjectionContext = {
            taskId: activity.activity_key,
            repository: activity.repository,
            issueNumber: typeof metadata.issueNumber === 'number' ? metadata.issueNumber : undefined,
            prNumber: typeof metadata.prNumber === 'number' ? metadata.prNumber : undefined
        };
        const durableContext = activity.activity_type === 'task'
            ? await this.store.getTaskContext(activity.activity_key, {
                repository: activity.repository,
                issueNumber: fallbackContext.issueNumber
            })
            : null;
        const taskContext = durableContext ?? fallbackContext;
        const recipients = activity.activity_type === 'task'
            ? await this.store.getTaskRecipients(taskContext)
            : await this.store.getRepositoryRecipients(activity.repository);
        return { taskContext, recipients };
    }

    private async createStalledNotification(input: {
        activity: SourceActivityRow;
        detectedAt: ReturnType<typeof normalizeISO8601Timestamp>;
        taskContext: TaskProjectionContext;
        recipients: string[];
        transaction: Knex.Transaction;
    }): Promise<void> {
        const { activity, detectedAt, taskContext, recipients, transaction } = input;
        const timestamp = normalizeISO8601Timestamp(activity.last_activity_at);
        const branchSuffix = activity.branch ? ` (${activity.branch})` : '';
        const entity = activity.activity_type === 'task'
            ? activity.activity_key
            : `${activity.repository}\0${activity.branch ?? ''}\0${activity.activity_key}`;
        const common = {
            deduplicationKey: buildProjectionDeduplicationKey(
                activity.activity_type,
                entity,
                `stalled-${activity.status}`,
                timestamp
            ),
            severity: 'warning' as const,
            metadata: {
                transitionState: 'stalled',
                sourceState: activity.status,
                transitionAt: timestamp,
                detectedAt
            },
            occurredAt: detectedAt,
            recipients
        };
        if (activity.activity_type === 'task') {
            await this.notifications.createNotificationEventInTransaction(transaction, {
                ...common,
                kind: 'task',
                target: taskTarget(taskContext),
                action: taskAction(activity.activity_key),
                title: 'Task appears stalled',
                body: `A task in ${activity.repository} has had no activity since ${timestamp}.`
            });
            return;
        }
        await this.notifications.createNotificationEventInTransaction(transaction, {
            ...common,
            kind: 'indexing',
            target: {
                type: 'indexing',
                repository: activity.repository,
                ...(activity.branch === null ? {} : { branch: activity.branch })
            },
            title: 'Indexing appears stalled',
            body: `Indexing for ${activity.repository}${branchSuffix} has had no activity since ${timestamp}.`
        });
    }
}

export const notificationProjectionService = new NotificationProjectionService();

export async function projectNotificationUpdateBestEffort(payload: EventPayload): Promise<void> {
    try {
        await notificationProjectionService.projectUpdate(payload);
    } catch (error) {
        logger.warn({
            eventType: payload.eventType,
            error: error instanceof Error ? error.message : String(error)
        }, 'Failed to project notification update');
    }
}
