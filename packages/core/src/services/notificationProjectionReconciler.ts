import type { Knex } from 'knex';
import {
    normalizeISO8601Timestamp,
    type DraftUpdatePayload,
    type IndexingUpdatePayload,
    type TaskUpdatePayload
} from '@propr/shared';

const DEFAULT_RECONCILIATION_BATCH_SIZE = 100;
const TERMINAL_TASK_STATES = [
    'completed', 'complete', 'succeeded', 'failed', 'error', 'cancelled', 'canceled'
] as const;

interface ReconcilerOptions {
    database: Knex;
    projectTaskUpdate: (payload: TaskUpdatePayload) => Promise<void>;
    projectIndexingUpdate: (payload: IndexingUpdatePayload) => Promise<void>;
    projectDraftUpdate: (payload: DraftUpdatePayload) => Promise<void>;
    now?: () => string | number | Date;
    batchSize?: number;
}

interface RepositoryCursor {
    fullName: string;
    branch: string;
}

type ReconciledRepositoryStatus = 'completed' | 'failed' | 'idle';

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
        throw new TypeError('durable notification transition timestamp is invalid');
    }
    return normalizeISO8601Timestamp(value);
}

/** Rotating, bounded scans repair missed terminal projections from durable sources. */
export class NotificationProjectionReconciler {
    private readonly database: Knex;
    private readonly projectTaskUpdate: ReconcilerOptions['projectTaskUpdate'];
    private readonly projectIndexingUpdate: ReconcilerOptions['projectIndexingUpdate'];
    private readonly projectDraftUpdate: ReconcilerOptions['projectDraftUpdate'];
    private readonly now: () => string | number | Date;
    private readonly batchSize: number;
    private taskCursor = 0;
    private repositoryTransitionCursor = 0;
    private repositoryCursor?: RepositoryCursor;
    private draftCursor = '';

    constructor(options: ReconcilerOptions) {
        this.database = options.database;
        this.projectTaskUpdate = options.projectTaskUpdate;
        this.projectIndexingUpdate = options.projectIndexingUpdate;
        this.projectDraftUpdate = options.projectDraftUpdate;
        this.now = options.now ?? (() => new Date());
        this.batchSize = options.batchSize ?? DEFAULT_RECONCILIATION_BATCH_SIZE;
        if (!Number.isSafeInteger(this.batchSize) || this.batchSize <= 0) {
            throw new TypeError('notification reconciliation batchSize must be a positive safe integer');
        }
    }

    async reconcile(shouldContinue: () => boolean = () => true): Promise<number> {
        let repaired = await this.reconcileTasks(shouldContinue);
        if (shouldContinue()) repaired += await this.reconcileRepositories(shouldContinue);
        if (shouldContinue()) repaired += await this.reconcileDrafts(shouldContinue);
        return repaired;
    }

    private async reconcileTasks(shouldContinue: () => boolean): Promise<number> {
        if (!await this.database.schema.hasTable('task_history')) return 0;
        const placeholders = TERMINAL_TASK_STATES.map(() => '?').join(', ');
        const rows = await this.database('task_history')
            .select('history_id', 'task_id', 'state', 'timestamp', 'metadata')
            .where('history_id', '>', this.taskCursor)
            .whereRaw(`lower(state) in (${placeholders})`, [...TERMINAL_TASK_STATES])
            .orderBy('history_id', 'asc')
            .limit(this.batchSize) as Array<{
                history_id: number;
                task_id: string;
                state: string;
                timestamp: unknown;
                metadata: unknown;
            }>;
        if (rows.length === 0) {
            this.taskCursor = 0;
            return 0;
        }

        let repaired = 0;
        for (const row of rows) {
            if (!shouldContinue()) break;
            const transitionAt = normalizedTimestamp(row.timestamp);
            const publishedAt = this.publicationTimestamp(transitionAt);
            await this.projectTaskUpdate({
                eventType: 'task:update',
                taskId: row.task_id,
                state: row.state,
                timestamp: publishedAt,
                metadata: {
                    ...parseMetadata(row.metadata),
                    transitionAt,
                    transitionSequence: row.history_id
                }
            });
            this.taskCursor = row.history_id;
            repaired++;
        }
        return repaired;
    }

    private async reconcileRepositories(shouldContinue: () => boolean): Promise<number> {
        if (await this.database.schema.hasTable('repository_indexing_transitions')) {
            return this.reconcileRepositoryTransitionHistory(shouldContinue);
        }
        return this.reconcileCurrentRepositories(shouldContinue);
    }

    private async reconcileRepositoryTransitionHistory(
        shouldContinue: () => boolean
    ): Promise<number> {
        const rows = await this.database('repository_indexing_transitions')
            .select('transition_id', 'full_name', 'branch', 'status', 'transition_at', 'run_id')
            .where('transition_id', '>', this.repositoryTransitionCursor)
            .whereIn('status', ['completed', 'failed', 'idle'])
            .orderBy('transition_id', 'asc')
            .limit(this.batchSize) as Array<{
                transition_id: number;
                full_name: string;
                branch: string;
                status: ReconciledRepositoryStatus;
                transition_at: unknown;
                run_id: string;
            }>;
        if (rows.length === 0) {
            this.repositoryTransitionCursor = 0;
            return 0;
        }

        let repaired = 0;
        for (const row of rows) {
            if (!shouldContinue()) break;
            const transitionAt = normalizedTimestamp(row.transition_at);
            await this.projectIndexingUpdate({
                eventType: 'indexing:update',
                repository: row.full_name,
                branch: row.branch,
                phase: row.status,
                transitionAt,
                runId: row.run_id,
                timestamp: this.publicationTimestamp(transitionAt)
            });
            this.repositoryTransitionCursor = row.transition_id;
            repaired++;
        }
        return repaired;
    }

    private async reconcileCurrentRepositories(shouldContinue: () => boolean): Promise<number> {
        if (!await this.database.schema.hasTable('repositories')
            || !await this.database.schema.hasColumn('repositories', 'indexing_run_id')) return 0;
        const query = this.database('repositories')
            .select('full_name', 'branch', 'indexing_status', 'indexing_transition_at', 'indexing_run_id')
            .whereIn('indexing_status', ['completed', 'failed', 'idle'])
            .whereNotNull('indexing_transition_at')
            .whereNotNull('indexing_run_id');
        if (this.repositoryCursor) {
            const cursor = this.repositoryCursor;
            query.andWhere((builder) => builder
                .where('full_name', '>', cursor.fullName)
                .orWhere((sameRepository) => sameRepository
                    .where({ full_name: cursor.fullName })
                    .where('branch', '>', cursor.branch)));
        }
        const rows = await query
            .orderBy('full_name', 'asc')
            .orderBy('branch', 'asc')
            .limit(this.batchSize) as Array<{
                full_name: string;
                branch: string;
                indexing_status: ReconciledRepositoryStatus;
                indexing_transition_at: unknown;
                indexing_run_id: string;
            }>;
        if (rows.length === 0) {
            this.repositoryCursor = undefined;
            return 0;
        }

        let repaired = 0;
        for (const row of rows) {
            if (!shouldContinue()) break;
            const transitionAt = normalizedTimestamp(row.indexing_transition_at);
            await this.projectIndexingUpdate({
                eventType: 'indexing:update',
                repository: row.full_name,
                branch: row.branch,
                phase: row.indexing_status,
                transitionAt,
                runId: row.indexing_run_id,
                timestamp: this.publicationTimestamp(transitionAt)
            });
            this.repositoryCursor = { fullName: row.full_name, branch: row.branch };
            repaired++;
        }
        return repaired;
    }

    private async reconcileDrafts(shouldContinue: () => boolean): Promise<number> {
        if (!await this.database.schema.hasTable('task_drafts')
            || !await this.database.schema.hasColumn('task_drafts', 'review_transition_at')) return 0;
        const rows = await this.database('task_drafts')
            .select('draft_id', 'review_transition_at', 'updated_at')
            .where({ status: 'review' })
            .where('draft_id', '>', this.draftCursor)
            .orderBy('draft_id', 'asc')
            .limit(this.batchSize) as Array<{
                draft_id: string;
                review_transition_at: unknown;
                updated_at: unknown;
            }>;
        if (rows.length === 0) {
            this.draftCursor = '';
            return 0;
        }

        let repaired = 0;
        for (const row of rows) {
            if (!shouldContinue()) break;
            const transitionAt = normalizedTimestamp(
                row.review_transition_at ?? row.updated_at
            );
            await this.projectDraftUpdate({
                eventType: 'draft:update',
                draftId: row.draft_id,
                step: 'notification-reconciliation',
                status: 'completed',
                draftStatus: 'review',
                timestamp: this.publicationTimestamp(transitionAt)
            });
            this.draftCursor = row.draft_id;
            repaired++;
        }
        return repaired;
    }

    private publicationTimestamp(transitionAt: string): string {
        const current = normalizeISO8601Timestamp(this.now());
        return current >= transitionAt ? current : transitionAt;
    }
}
