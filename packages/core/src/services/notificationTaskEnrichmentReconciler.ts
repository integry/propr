import type { Knex } from 'knex';
import type { TaskUpdatePayload } from '@propr/shared';
import {
    logMalformedReconciliationTimestamp,
    normalizedReconciliationTimestamp,
    parseReconciliationMetadata,
    reconciliationPublicationTimestamp
} from './notificationProjectionReconciliationValues.js';

interface TaskEnrichmentRow {
    change_id: number;
    task_id: string;
    state: string;
    transition_history_id: number | null;
    transition_at: unknown;
    changed_at: unknown;
    metadata: unknown;
}

interface ReconcileTaskEnrichmentsOptions {
    database: Knex;
    cursor: number;
    batchSize: number;
    now: () => string | number | Date;
    shouldContinue: () => boolean;
    project: (payload: TaskUpdatePayload) => Promise<'completed' | 'deferred'>;
    advanceCheckpoint: (cursor: number) => Promise<void>;
    deferProjection: (cursor: number, payload: TaskUpdatePayload) => Promise<boolean>;
}

/** Replays metadata changes without changing the original terminal transition identity. */
export async function reconcileTaskNotificationEnrichments(
    options: ReconcileTaskEnrichmentsOptions
): Promise<{ repaired: number; cursor: number }> {
    if (!await options.database.schema.hasTable('task_notification_enrichments')) {
        return { repaired: 0, cursor: options.cursor };
    }
    const rows = await options.database('task_notification_enrichments')
        .select(
            'change_id', 'task_id', 'state', 'transition_history_id',
            'transition_at', 'changed_at', 'metadata'
        )
        .where('change_id', '>', options.cursor)
        .orderBy('change_id', 'asc')
        .limit(options.batchSize) as TaskEnrichmentRow[];

    let repaired = 0;
    let cursor = options.cursor;
    for (const row of rows) {
        if (!options.shouldContinue()) break;
        let transitionAt: string;
        let changedAt: string;
        try {
            transitionAt = normalizedReconciliationTimestamp(row.transition_at);
            changedAt = normalizedReconciliationTimestamp(row.changed_at);
        } catch (error) {
            logMalformedReconciliationTimestamp(
                'task-notification-enrichments',
                row.change_id,
                `${String(row.transition_at)} / ${String(row.changed_at)}`,
                error
            );
            await options.advanceCheckpoint(row.change_id);
            cursor = row.change_id;
            continue;
        }
        const transitionSequence = Number(row.transition_history_id);
        const payload: TaskUpdatePayload = {
            eventType: 'task:update',
            taskId: row.task_id,
            state: row.state,
            timestamp: reconciliationPublicationTimestamp(options.now(), changedAt),
            metadata: {
                ...parseReconciliationMetadata(row.metadata),
                transitionAt,
                notificationReconciliation: true,
                ...(Number.isSafeInteger(transitionSequence) && transitionSequence > 0
                    ? { transitionSequence }
                    : {})
            }
        };
        const outcome = await options.project(payload);
        if (outcome === 'deferred'
            && !await options.deferProjection(row.change_id, payload)) break;
        await options.advanceCheckpoint(row.change_id);
        cursor = row.change_id;
        if (outcome === 'completed') repaired++;
    }
    return { repaired, cursor };
}
