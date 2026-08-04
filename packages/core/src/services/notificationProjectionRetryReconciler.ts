import type {
    DraftUpdatePayload,
    IndexingUpdatePayload,
    TaskUpdatePayload
} from '@propr/shared';
import logger from '../utils/logger.js';
import {
    NotificationProjectionCheckpointStore,
    type NotificationProjectionRetry
} from './notificationProjectionCheckpointStore.js';

type ProjectionRetryPayload = TaskUpdatePayload | IndexingUpdatePayload | DraftUpdatePayload;
type ProjectionOutcome = 'completed' | 'deferred';

interface RetryReconcilerOptions {
    checkpoints: NotificationProjectionCheckpointStore;
    batchSize: number;
    shouldContinue: () => boolean;
    projectTaskUpdate: (payload: TaskUpdatePayload) => Promise<ProjectionOutcome>;
    projectIndexingUpdate: (payload: IndexingUpdatePayload) => Promise<ProjectionOutcome>;
    projectDraftUpdate: (payload: DraftUpdatePayload) => Promise<ProjectionOutcome>;
}

function parseRetryPayload(retry: NotificationProjectionRetry): ProjectionRetryPayload | undefined {
    try {
        const payload = JSON.parse(retry.payloadJson) as { eventType?: unknown };
        const expectedEventType = retry.source === 'terminal-task-history'
            || retry.source === 'task-notification-enrichments'
            ? 'task:update'
            : retry.source === 'review-drafts'
                ? 'draft:update'
                : 'indexing:update';
        return payload?.eventType === expectedEventType
            ? payload as ProjectionRetryPayload
            : undefined;
    } catch {
        return undefined;
    }
}

function projectRetryPayload(
    options: RetryReconcilerOptions,
    payload: ProjectionRetryPayload
): Promise<ProjectionOutcome> {
    switch (payload.eventType) {
        case 'task:update': return options.projectTaskUpdate(payload);
        case 'indexing:update': return options.projectIndexingUpdate(payload);
        case 'draft:update': return options.projectDraftUpdate(payload);
    }
}

/** Retry deferred transitions independently so one user cannot block a source cursor. */
export async function reconcileNotificationProjectionRetries(
    options: RetryReconcilerOptions
): Promise<number> {
    const retries = await options.checkpoints.loadRetries(options.batchSize);
    let repaired = 0;
    for (const retry of retries) {
        if (!options.shouldContinue()) break;
        const payload = parseRetryPayload(retry);
        if (!payload) {
            logger.warn({ source: retry.source, transitionKey: retry.transitionKey },
                'Discarding malformed durable notification projection retry');
            await options.checkpoints.deleteRetry(retry);
            continue;
        }
        const outcome = await projectRetryPayload(options, payload);
        if (outcome === 'deferred') {
            await options.checkpoints.markRetryDeferred(retry);
            continue;
        }
        await options.checkpoints.deleteRetry(retry);
        repaired++;
    }
    return repaired;
}
