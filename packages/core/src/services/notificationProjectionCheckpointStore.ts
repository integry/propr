import type { Knex } from 'knex';
import { normalizeISO8601Timestamp } from '@propr/shared';

export type NotificationProjectionCheckpointSource =
    | 'terminal-task-history'
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
