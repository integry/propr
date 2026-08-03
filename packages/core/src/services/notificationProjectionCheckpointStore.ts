import type { Knex } from 'knex';
import { normalizeISO8601Timestamp } from '@propr/shared';

export type NotificationProjectionCheckpointSource =
    | 'terminal-task-history'
    | 'task-notification-enrichments'
    | 'terminal-indexing-history'
    | 'terminal-indexing-current'
    | 'review-drafts';

const CHECKPOINT_TABLE = 'notification_projection_checkpoints';

export class NotificationProjectionCheckpointStore {
    private tableAvailability?: Promise<boolean>;

    constructor(
        private readonly database: Knex,
        private readonly now: () => string | number | Date
    ) {}

    async load(source: NotificationProjectionCheckpointSource): Promise<string | undefined> {
        if (!await this.hasTable()) return undefined;
        const row = await this.database(CHECKPOINT_TABLE)
            .select('cursor')
            .where({ source })
            .first() as { cursor?: unknown } | undefined;
        return typeof row?.cursor === 'string' ? row.cursor : undefined;
    }

    async save(source: NotificationProjectionCheckpointSource, cursor: string): Promise<void> {
        if (!await this.hasTable()) return;
        const updatedAt = normalizeISO8601Timestamp(this.now());
        await this.database(CHECKPOINT_TABLE)
            .insert({ source, cursor, updated_at: updatedAt })
            .onConflict('source')
            .merge({ cursor, updated_at: updatedAt });
    }

    async pruneIndexingTransitions(
        maximumTransitionId: number,
        observedBefore: string
    ): Promise<number> {
        if (!await this.hasTable()
            || !await this.database.schema.hasTable('repository_indexing_transitions')) return 0;
        const deleted = await this.database('repository_indexing_transitions')
            .where('transition_id', '<=', maximumTransitionId)
            .where('observed_at', '<', observedBefore)
            .delete();
        return deleted;
    }

    async pruneTerminalIndexingActivities(
        maximumTransitionId: number,
        completedBefore: string
    ): Promise<void> {
        if (!await this.hasTable()
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

    private async hasTable(): Promise<boolean> {
        this.tableAvailability ??= Promise.resolve()
            .then(() => this.database.schema.hasTable(CHECKPOINT_TABLE));
        try {
            const available = await this.tableAvailability;
            if (!available) this.tableAvailability = undefined;
            return available;
        } catch (error) {
            this.tableAvailability = undefined;
            throw error;
        }
    }
}
