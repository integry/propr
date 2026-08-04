import type { Knex } from 'knex';
import { normalizeISO8601Timestamp } from '@propr/shared';

export type NotificationProjectionCheckpointSource =
    | 'terminal-task-history'
    | 'task-notification-enrichments'
    | 'terminal-indexing-history'
    | 'terminal-indexing-current'
    | 'review-drafts';

const CHECKPOINT_TABLE = 'notification_projection_checkpoints';
const RETRY_TABLE = 'notification_projection_retries';
const RETRY_BACKOFF_BASE_MS = 1_000;
const RETRY_BACKOFF_CAP_MS = 60 * 60 * 1_000;
const NUMERIC_CHECKPOINTS = new Set<NotificationProjectionCheckpointSource>([
    'terminal-task-history',
    'task-notification-enrichments',
    'terminal-indexing-history'
]);

export interface NotificationProjectionRetry {
    source: NotificationProjectionCheckpointSource;
    transitionKey: string;
    payloadJson: string;
    attemptCount: number;
}

export class NotificationProjectionCheckpointStore {
    private readonly tableAvailability = new Map<string, Promise<boolean>>();

    constructor(
        private readonly database: Knex,
        private readonly now: () => string | number | Date
    ) {}

    async load(source: NotificationProjectionCheckpointSource): Promise<string | undefined> {
        if (!await this.hasTable(CHECKPOINT_TABLE)) return undefined;
        const row = await this.database(CHECKPOINT_TABLE)
            .select('cursor')
            .where({ source })
            .first() as { cursor?: unknown } | undefined;
        return typeof row?.cursor === 'string' ? row.cursor : undefined;
    }

    async save(source: NotificationProjectionCheckpointSource, cursor: string): Promise<void> {
        if (!await this.hasTable(CHECKPOINT_TABLE)) return;
        const numeric = NUMERIC_CHECKPOINTS.has(source);
        if (numeric && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) {
            throw new TypeError(`Invalid numeric notification projection checkpoint: ${cursor}`);
        }
        const tuple = numeric
            ? undefined
            : this.parseTuple(cursor, source === 'terminal-indexing-current' ? 3 : 2);
        const updatedAt = normalizeISO8601Timestamp(this.now());
        await this.database(CHECKPOINT_TABLE)
            .insert({ source, cursor, updated_at: updatedAt })
            .onConflict('source')
            .ignore();

        const update = this.database(CHECKPOINT_TABLE).where({ source });
        if (numeric) {
            update.whereRaw('CAST(cursor AS INTEGER) < ?', [Number(cursor)]);
        } else {
            const tupleValues = tuple!;
            const tupleLength = tupleValues.length;
            const comparisons = tupleValues.map((_value, index) => {
                const equalPrefix = tupleValues.slice(0, index)
                    .map((_prefix, prefixIndex) => `json_extract(cursor, '$[${prefixIndex}]') = ?`);
                return `(${[
                    ...equalPrefix,
                    `json_extract(cursor, '$[${index}]') < ?`
                ].join(' AND ')})`;
            });
            const bindings: Array<string | number> = [tupleLength];
            tupleValues.forEach((_value, index) => {
                bindings.push(...tupleValues.slice(0, index), tupleValues[index]);
            });
            update.whereRaw(`
                CASE
                  WHEN json_valid(cursor) = 0 THEN 1
                  WHEN json_type(cursor) != 'array' OR json_array_length(cursor) != ? THEN 1
                  ELSE ${comparisons.join(' OR ')}
                END = 1
            `, bindings);
        }
        await update.update({ cursor, updated_at: updatedAt });
    }

    async enqueueRetry(
        source: NotificationProjectionCheckpointSource,
        transitionKey: string,
        payload: unknown
    ): Promise<boolean> {
        if (!await this.hasTable(RETRY_TABLE)) return false;
        const timestamp = normalizeISO8601Timestamp(this.now());
        const payloadJson = JSON.stringify(payload);
        if (payloadJson === undefined) throw new TypeError('Notification projection retry payload is invalid');
        await this.database(RETRY_TABLE)
            .insert({
                source,
                transition_key: transitionKey,
                payload_json: payloadJson,
                attempt_count: 0,
                next_attempt_at: timestamp,
                created_at: timestamp,
                updated_at: timestamp
            })
            .onConflict(['source', 'transition_key'])
            .merge({
                attempt_count: this.database.raw(`CASE
                    WHEN ${RETRY_TABLE}.payload_json <> excluded.payload_json THEN 0
                    ELSE ${RETRY_TABLE}.attempt_count
                END`),
                next_attempt_at: this.database.raw(`CASE
                    WHEN ${RETRY_TABLE}.payload_json <> excluded.payload_json
                      THEN excluded.next_attempt_at
                    ELSE ${RETRY_TABLE}.next_attempt_at
                END`),
                payload_json: payloadJson,
                updated_at: timestamp
            });
        return true;
    }

    async loadRetries(limit: number): Promise<NotificationProjectionRetry[]> {
        if (!await this.hasTable(RETRY_TABLE)) return [];
        const timestamp = normalizeISO8601Timestamp(this.now());
        const rows = await this.database(RETRY_TABLE)
            .select('source', 'transition_key', 'payload_json', 'attempt_count')
            .whereRaw('COALESCE(next_attempt_at, updated_at) <= ?', [timestamp])
            .orderByRaw('COALESCE(next_attempt_at, updated_at) ASC')
            .orderBy('attempt_count', 'asc')
            .orderBy('updated_at', 'asc')
            .orderBy('source', 'asc')
            .orderBy('transition_key', 'asc')
            .limit(limit) as Array<{
                source: NotificationProjectionCheckpointSource;
                transition_key: string;
                payload_json: string;
                attempt_count: number;
            }>;
        return rows.map((row) => ({
            source: row.source,
            transitionKey: row.transition_key,
            payloadJson: row.payload_json,
            attemptCount: Number(row.attempt_count)
        }));
    }

    async markRetryDeferred(retry: NotificationProjectionRetry): Promise<void> {
        if (!await this.hasTable(RETRY_TABLE)) return;
        const updatedAt = normalizeISO8601Timestamp(this.now());
        const attemptCount = Math.min(Number.MAX_SAFE_INTEGER, retry.attemptCount + 1);
        const exponent = Math.min(30, Math.max(0, attemptCount - 1));
        const delayMs = Math.min(RETRY_BACKOFF_CAP_MS, RETRY_BACKOFF_BASE_MS * (2 ** exponent));
        const nextAttemptAt = normalizeISO8601Timestamp(Date.parse(updatedAt) + delayMs);
        await this.database(RETRY_TABLE)
            .where({
                source: retry.source,
                transition_key: retry.transitionKey,
                payload_json: retry.payloadJson
            })
            .update({
                attempt_count: attemptCount,
                next_attempt_at: nextAttemptAt,
                updated_at: updatedAt
            });
    }

    async deleteRetry(retry: NotificationProjectionRetry): Promise<void> {
        if (!await this.hasTable(RETRY_TABLE)) return;
        await this.database(RETRY_TABLE)
            .where({ source: retry.source, transition_key: retry.transitionKey })
            .delete();
    }

    async pruneIndexingTransitions(
        maximumTransitionId: number,
        observedBefore: string
    ): Promise<number> {
        if (!await this.hasTable(CHECKPOINT_TABLE)
            || !await this.database.schema.hasTable('repository_indexing_transitions')) return 0;
        const deleted = await this.database('repository_indexing_transitions')
            .where('transition_id', '<=', maximumTransitionId)
            .where('observed_at', '<', observedBefore)
            .delete();
        return deleted;
    }

    async pruneTaskEnrichments(maximumChangeId: number, changedBefore: string): Promise<number> {
        if (!await this.hasTable(CHECKPOINT_TABLE)
            || !await this.database.schema.hasTable('task_notification_enrichments')) return 0;
        return this.database('task_notification_enrichments')
            .where('change_id', '<=', maximumChangeId)
            .where('changed_at', '<', changedBefore)
            .delete();
    }

    async pruneTerminalIndexingActivities(
        maximumTransitionId: number,
        completedBefore: string
    ): Promise<void> {
        if (!await this.hasTable(CHECKPOINT_TABLE)
            || !await this.database.schema.hasTable('repository_indexing_transitions')
            || !await this.database.schema.hasTable('notification_source_activity')) return;
        await this.database.raw(`
            DELETE FROM notification_source_activity
            WHERE activity_type = 'indexing'
              AND status IN ('completed', 'failed', 'cancelled')
              AND COALESCE(
                json_extract(metadata_json, '$.transitionAt'),
                completed_at
              ) < ?
              AND EXISTS (
                SELECT 1
                FROM repository_indexing_transitions AS transition
                WHERE transition.transition_id <= ?
                  AND lower(transition.full_name) = lower(notification_source_activity.repository)
                  AND transition.branch = COALESCE(notification_source_activity.branch, 'HEAD')
                  AND transition.run_id = json_extract(
                    notification_source_activity.metadata_json,
                    '$.runId'
                  )
                  AND transition.status = CASE notification_source_activity.status
                    WHEN 'cancelled' THEN 'idle'
                    ELSE notification_source_activity.status
                  END
              )
        `, [completedBefore, maximumTransitionId]);
    }

    private parseTuple(cursor: string, length: number): string[] {
        let value: unknown;
        try {
            value = JSON.parse(cursor);
        } catch {
            throw new TypeError(`Invalid tuple notification projection checkpoint: ${cursor}`);
        }
        if (!Array.isArray(value) || value.length !== length
            || value.some((entry) => typeof entry !== 'string')) {
            throw new TypeError(`Invalid tuple notification projection checkpoint: ${cursor}`);
        }
        return value;
    }

    private async hasTable(table: string): Promise<boolean> {
        let availability = this.tableAvailability.get(table);
        if (!availability) {
            availability = Promise.resolve().then(() => this.database.schema.hasTable(table));
            this.tableAvailability.set(table, availability);
        }
        try {
            const available = await availability;
            if (!available) this.tableAvailability.delete(table);
            return available;
        } catch (error) {
            this.tableAvailability.delete(table);
            throw error;
        }
    }
}
