import type { Knex } from 'knex';
import {
    DRAFT_UPDATE,
    INDEXING_UPDATE,
    TASK_UPDATE,
    normalizeISO8601Timestamp,
    type DraftUpdatePayload,
    type EventPayload,
    type IndexingUpdatePayload,
    type TaskUpdatePayload
} from '@propr/shared';
import { db } from '../db/connection.js';
import logger from '../utils/logger.js';
import { NotificationService } from './notificationService.js';
import {
    NotificationProjectionStore,
    buildProjectionDeduplicationKey,
    type SourceActivityRow,
    type TaskProjectionContext
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

export interface NotificationProjectionServiceOptions {
    database?: Knex;
    notificationService?: NotificationService;
    now?: () => TimestampInput;
}

export class NotificationProjectionService {
    private readonly database: Knex;
    private readonly notifications: NotificationService;
    private readonly store: NotificationProjectionStore;
    private readonly now: () => TimestampInput;

    constructor(options: NotificationProjectionServiceOptions = {}) {
        this.database = options.database ?? db;
        this.now = options.now ?? (() => new Date());
        this.notifications = options.notificationService ?? new NotificationService({
            database: this.database,
            now: this.now
        });
        this.store = new NotificationProjectionStore(this.database);
    }

    async projectUpdate(payload: EventPayload): Promise<void> {
        switch (payload.eventType) {
            case DRAFT_UPDATE:
                await this.projectDraftUpdate(payload);
                return;
            case TASK_UPDATE:
                await this.projectTaskUpdate(payload);
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
        const timestamp = normalizeISO8601Timestamp(payload.timestamp);
        const context = await this.store.getDraftContext(payload.draftId);
        if (!context) return;
        await this.notifications.createNotificationEvent({
            deduplicationKey: buildProjectionDeduplicationKey(
                'draft',
                context.draftId,
                'review',
                timestamp
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
            recipients: [context.userId]
        });
    }

    async projectTaskUpdate(payload: TaskUpdatePayload): Promise<void> {
        const timestamp = normalizeISO8601Timestamp(payload.timestamp);
        const context = await this.store.getTaskContext(payload.taskId, payload);
        if (!context) return;
        const activityStatus = taskActivityStatus(payload.state);
        const safeMetadata = safeTaskMetadata(context, activityStatus, timestamp);
        await this.store.upsertTaskActivity({
            context,
            status: activityStatus,
            timestamp,
            metadata: safeMetadata
        });
        const recipients = await this.store.getTaskRecipients(context);

        if (activityStatus === 'failed') {
            await this.createTaskFailure(context, timestamp, recipients);
        } else if (activityStatus === 'completed' && context.commandMode === 'review') {
            await this.createReviewCompletion(context, timestamp, recipients);
        } else if (activityStatus === 'completed') {
            await this.createImplementationCompletion(context, timestamp, recipients);
            await this.createPullRequestAttention(context, timestamp, recipients);
        }
    }

    async projectIndexingUpdate(payload: IndexingUpdatePayload): Promise<void> {
        const timestamp = normalizeISO8601Timestamp(payload.timestamp);
        const status = indexingActivityStatus(payload.phase);
        await this.store.upsertIndexingActivity({
            repository: payload.repository,
            ...(payload.branch === undefined ? {} : { branch: payload.branch }),
            status,
            timestamp
        });
        if (status !== 'failed') return;
        const recipients = await this.store.getRepositoryRecipients(payload.repository);
        await this.notifications.createNotificationEvent({
            deduplicationKey: buildProjectionDeduplicationKey(
                'indexing',
                `${payload.repository}\0${payload.branch ?? ''}`,
                'failed',
                timestamp
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
            metadata: { transitionState: 'failed', transitionAt: timestamp },
            occurredAt: timestamp,
            recipients
        });
    }

    async detectStalledActivities(stalledAfterMs: number, now: TimestampInput = this.now()): Promise<number> {
        if (!Number.isSafeInteger(stalledAfterMs) || stalledAfterMs <= 0) {
            throw new TypeError('stalledAfterMs must be a positive safe integer');
        }
        const currentTimestamp = normalizeISO8601Timestamp(now);
        const cutoff = normalizeISO8601Timestamp(Date.parse(currentTimestamp) - stalledAfterMs);
        const stalled = await this.store.getStalledActivities(cutoff);
        for (const activity of stalled) {
            await this.createStalledNotification(activity, currentTimestamp);
        }
        return stalled.length;
    }

    private async createTaskFailure(
        context: TaskProjectionContext,
        timestamp: ReturnType<typeof normalizeISO8601Timestamp>,
        recipients: string[]
    ): Promise<void> {
        await this.notifications.createNotificationEvent({
            deduplicationKey: buildProjectionDeduplicationKey('task', context.taskId, 'failed', timestamp),
            kind: 'task',
            severity: 'error',
            target: taskTarget(context),
            title: 'Task failed',
            body: `${taskBodySubject(context)} in ${context.repository} failed and needs attention.`,
            action: taskAction(context.taskId),
            metadata: safeTaskMetadata(context, 'failed', timestamp),
            occurredAt: timestamp,
            recipients
        });
    }

    private async createImplementationCompletion(
        context: TaskProjectionContext,
        timestamp: ReturnType<typeof normalizeISO8601Timestamp>,
        recipients: string[]
    ): Promise<void> {
        await this.notifications.createNotificationEvent({
            deduplicationKey: buildProjectionDeduplicationKey('task', context.taskId, 'completed', timestamp),
            kind: 'task',
            severity: 'success',
            target: taskTarget(context),
            title: 'Implementation completed',
            body: `${taskBodySubject(context)} in ${context.repository} completed.`,
            action: taskAction(context.taskId),
            metadata: safeTaskMetadata(context, 'completed', timestamp),
            occurredAt: timestamp,
            recipients
        });
    }

    private async createReviewCompletion(
        context: TaskProjectionContext,
        timestamp: ReturnType<typeof normalizeISO8601Timestamp>,
        recipients: string[]
    ): Promise<void> {
        if (context.prNumber === undefined) return;
        await this.notifications.createNotificationEvent({
            deduplicationKey: buildProjectionDeduplicationKey('review', context.taskId, 'completed', timestamp),
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
            metadata: safeTaskMetadata(context, 'completed', timestamp),
            occurredAt: timestamp,
            recipients
        });
    }

    private async createPullRequestAttention(
        context: TaskProjectionContext,
        timestamp: ReturnType<typeof normalizeISO8601Timestamp>,
        recipients: string[]
    ): Promise<void> {
        const prUrl = safePullRequestUrl(context);
        if (context.prNumber === undefined || prUrl === undefined) return;
        await this.notifications.createNotificationEvent({
            deduplicationKey: buildProjectionDeduplicationKey(
                'pull-request',
                `${context.repository}#${context.prNumber}`,
                'attention',
                timestamp
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
            metadata: { prNumber: context.prNumber, transitionState: 'attention', transitionAt: timestamp },
            occurredAt: timestamp,
            recipients
        });
    }

    private async createStalledNotification(
        activity: SourceActivityRow,
        detectedAt: ReturnType<typeof normalizeISO8601Timestamp>
    ): Promise<void> {
        const timestamp = normalizeISO8601Timestamp(activity.last_activity_at);
        const metadata = parseActivityMetadata(activity);
        const recipients = activity.activity_type === 'task'
            ? await this.store.getTaskRecipients({
                taskId: activity.activity_key,
                repository: activity.repository,
                issueNumber: typeof metadata.issueNumber === 'number' ? metadata.issueNumber : undefined,
                prNumber: typeof metadata.prNumber === 'number' ? metadata.prNumber : undefined
            })
            : await this.store.getRepositoryRecipients(activity.repository);
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
            await this.notifications.createNotificationEvent({
                ...common,
                kind: 'task',
                target: {
                    type: 'task',
                    repository: activity.repository,
                    taskId: activity.activity_key,
                    ...(typeof metadata.issueNumber === 'number'
                        ? { issueNumber: metadata.issueNumber }
                        : {})
                },
                title: 'Task appears stalled',
                body: `A task in ${activity.repository} has had no activity since ${timestamp}.`
            });
            return;
        }
        await this.notifications.createNotificationEvent({
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
