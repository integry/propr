import type { Knex } from 'knex';
import { normalizeISO8601Timestamp, type TaskUpdatePayload } from '@propr/shared';
import logger from '../utils/logger.js';

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
}

function parseMetadata(value: unknown): Record<string, unknown> {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
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

function normalizedTimestamp(value: unknown): string {
    if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
        throw new TypeError('durable task-enrichment timestamp is invalid');
    }
    return normalizeISO8601Timestamp(value);
}

function publicationTimestamp(now: string | number | Date, changedAt: string): string {
    const current = normalizeISO8601Timestamp(now);
    return current >= changedAt ? current : changedAt;
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
            transitionAt = normalizedTimestamp(row.transition_at);
            changedAt = normalizedTimestamp(row.changed_at);
        } catch (error) {
            logger.warn({
                source: 'task-notification-enrichments',
                identity: row.change_id,
                value: `${String(row.transition_at)} / ${String(row.changed_at)}`.slice(0, 128),
                error: error instanceof Error ? error.message : String(error)
            }, 'Skipping malformed durable notification transition and advancing its checkpoint');
            await options.advanceCheckpoint(row.change_id);
            cursor = row.change_id;
            continue;
        }
        const transitionSequence = Number(row.transition_history_id);
        const outcome = await options.project({
            eventType: 'task:update',
            taskId: row.task_id,
            state: row.state,
            timestamp: publicationTimestamp(options.now(), changedAt),
            metadata: {
                ...parseMetadata(row.metadata),
                transitionAt,
                ...(Number.isSafeInteger(transitionSequence) && transitionSequence > 0
                    ? { transitionSequence }
                    : {})
            }
        });
        if (outcome === 'deferred') break;
        await options.advanceCheckpoint(row.change_id);
        cursor = row.change_id;
        repaired++;
    }
    return { repaired, cursor };
}
