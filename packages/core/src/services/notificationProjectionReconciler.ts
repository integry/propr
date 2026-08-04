/* eslint-disable max-lines -- bounded reconciliation sources share checkpoint and retention state */
import type { Knex } from 'knex';
import {
    normalizeISO8601Timestamp,
    type DraftUpdatePayload,
    type IndexingUpdatePayload,
    type TaskUpdatePayload
} from '@propr/shared';
import {
    NotificationProjectionCheckpointStore,
    type NotificationProjectionCheckpointSource
} from './notificationProjectionCheckpointStore.js';
import { reconcileTaskNotificationEnrichments } from './notificationTaskEnrichmentReconciler.js';
import { reconcileNotificationProjectionRetries } from './notificationProjectionRetryReconciler.js';
import {
    checkpointTuple,
    getNotificationIndexingTransitionRetentionMs,
    logMalformedReconciliationTimestamp,
    nonNegativeCheckpoint,
    normalizedReconciliationTimestamp,
    parseReconciliationMetadata,
    reconciliationPublicationTimestamp
} from './notificationProjectionReconciliationValues.js';

const DEFAULT_RECONCILIATION_BATCH_SIZE = 100;
const RETENTION_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const TERMINAL_TASK_STATES = ['completed', 'complete', 'succeeded', 'failed', 'error', 'cancelled', 'canceled'] as const;

const TASK_CHECKPOINT = 'terminal-task-history';
const TASK_ENRICHMENT_CHECKPOINT = 'task-notification-enrichments';
const INDEXING_HISTORY_CHECKPOINT = 'terminal-indexing-history';
const INDEXING_CURRENT_CHECKPOINT = 'terminal-indexing-current';
const DRAFT_CHECKPOINT = 'review-drafts';

interface ReconcilerOptions {
    database: Knex;
    projectTaskUpdate: (payload: TaskUpdatePayload) => Promise<'completed' | 'deferred'>;
    projectIndexingUpdate: (payload: IndexingUpdatePayload) => Promise<'completed' | 'deferred'>;
    projectDraftUpdate: (payload: DraftUpdatePayload) => Promise<'completed' | 'deferred'>;
    now?: () => string | number | Date;
    batchSize?: number;
    transitionRetentionMs?: number;
}

interface RepositoryCursor {
    updatedAt: string;
    fullName: string;
    branch: string;
}

interface DraftCursor {
    updatedAt: string;
    draftId: string;
}

type ReconciledRepositoryStatus = 'indexing' | 'completed' | 'failed' | 'idle';

/**
 * Bounded, at-least-once scans repair missed terminal projections. Projection
 * commits before its monotonic cursor, so a crash can replay an idempotent event.
 */
export class NotificationProjectionReconciler {
    private readonly database: Knex;
    private readonly projectTaskUpdate: ReconcilerOptions['projectTaskUpdate'];
    private readonly projectIndexingUpdate: ReconcilerOptions['projectIndexingUpdate'];
    private readonly projectDraftUpdate: ReconcilerOptions['projectDraftUpdate'];
    private readonly now: () => string | number | Date;
    private readonly batchSize: number;
    private readonly transitionRetentionMs: number;
    private readonly checkpoints: NotificationProjectionCheckpointStore;
    private cursorLoad?: Promise<void>;
    private taskCursor = 0;
    private taskEnrichmentCursor = 0;
    private repositoryTransitionCursor = 0;
    private repositoryCursor?: RepositoryCursor;
    private draftCursor?: DraftCursor;
    private lastRetentionPruneAt = 0;

    constructor(options: ReconcilerOptions) {
        this.database = options.database;
        this.projectTaskUpdate = options.projectTaskUpdate;
        this.projectIndexingUpdate = options.projectIndexingUpdate;
        this.projectDraftUpdate = options.projectDraftUpdate;
        this.now = options.now ?? (() => new Date());
        this.batchSize = options.batchSize ?? DEFAULT_RECONCILIATION_BATCH_SIZE;
        this.transitionRetentionMs = options.transitionRetentionMs
            ?? getNotificationIndexingTransitionRetentionMs();
        for (const [name, value] of [
            ['batchSize', this.batchSize],
            ['transitionRetentionMs', this.transitionRetentionMs]
        ] as const) {
            if (!Number.isSafeInteger(value) || value <= 0) {
                throw new TypeError(`notification reconciliation ${name} must be a positive safe integer`);
            }
        }
        this.checkpoints = new NotificationProjectionCheckpointStore(this.database, this.now);
    }

    async reconcile(shouldContinue: () => boolean = () => true): Promise<number> {
        await this.ensureCursorsLoaded();
        let repaired = await reconcileNotificationProjectionRetries({
            checkpoints: this.checkpoints,
            batchSize: this.batchSize,
            shouldContinue,
            projectTaskUpdate: this.projectTaskUpdate,
            projectIndexingUpdate: this.projectIndexingUpdate,
            projectDraftUpdate: this.projectDraftUpdate
        });
        if (shouldContinue()) repaired += await this.reconcileTasks(shouldContinue);
        if (shouldContinue()) repaired += await this.reconcileTaskEnrichments(shouldContinue);
        if (shouldContinue()) repaired += await this.reconcileRepositories(shouldContinue);
        if (shouldContinue()) repaired += await this.reconcileDrafts(shouldContinue);
        if (shouldContinue()) await this.pruneDurableHistory();
        return repaired;
    }

    private async ensureCursorsLoaded(): Promise<void> {
        const load = this.cursorLoad ?? this.loadCursors();
        this.cursorLoad = load;
        try {
            await load;
        } finally {
            if (this.cursorLoad === load) this.cursorLoad = undefined;
        }
    }

    private async loadCursors(): Promise<void> {
        const [task, taskEnrichment, indexingHistory, indexingCurrent, draft] = await Promise.all([
            this.checkpoints.load(TASK_CHECKPOINT),
            this.checkpoints.load(TASK_ENRICHMENT_CHECKPOINT),
            this.checkpoints.load(INDEXING_HISTORY_CHECKPOINT),
            this.checkpoints.load(INDEXING_CURRENT_CHECKPOINT),
            this.checkpoints.load(DRAFT_CHECKPOINT)
        ]);
        this.taskCursor = nonNegativeCheckpoint(task) ?? 0;
        this.taskEnrichmentCursor = nonNegativeCheckpoint(taskEnrichment) ?? 0;
        this.repositoryTransitionCursor = nonNegativeCheckpoint(indexingHistory) ?? 0;
        const repositoryTuple = checkpointTuple(indexingCurrent, 3);
        this.repositoryCursor = repositoryTuple
            ? {
                updatedAt: repositoryTuple[0],
                fullName: repositoryTuple[1],
                branch: repositoryTuple[2]
            }
            : undefined;
        const draftTuple = checkpointTuple(draft, 2);
        this.draftCursor = draftTuple
            ? { updatedAt: draftTuple[0], draftId: draftTuple[1] }
            : undefined;
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
                history_id: number; task_id: string; state: string; timestamp: unknown; metadata: unknown;
            }>;

        let repaired = 0;
        for (const row of rows) {
            if (!shouldContinue()) break;
            let transitionAt: string;
            try {
                transitionAt = normalizedReconciliationTimestamp(row.timestamp);
            } catch (error) {
                logMalformedReconciliationTimestamp(
                    TASK_CHECKPOINT, row.history_id, row.timestamp, error
                );
                await this.advanceNumericCheckpoint(TASK_CHECKPOINT, row.history_id);
                this.taskCursor = row.history_id;
                continue;
            }
            const payload: TaskUpdatePayload = {
                eventType: 'task:update',
                taskId: row.task_id,
                state: row.state,
                timestamp: reconciliationPublicationTimestamp(this.now(), transitionAt),
                metadata: {
                    ...parseReconciliationMetadata(row.metadata),
                    transitionAt,
                    transitionSequence: row.history_id,
                    notificationReconciliation: true
                }
            };
            const outcome = await this.projectTaskUpdate(payload);
            if (outcome === 'deferred'
                && !await this.checkpoints.enqueueRetry(
                    TASK_CHECKPOINT, String(row.history_id), payload
                )) break;
            await this.advanceNumericCheckpoint(TASK_CHECKPOINT, row.history_id);
            this.taskCursor = row.history_id;
            if (outcome === 'completed') repaired++;
        }
        return repaired;
    }

    private async reconcileTaskEnrichments(shouldContinue: () => boolean): Promise<number> {
        const result = await reconcileTaskNotificationEnrichments({
            database: this.database,
            cursor: this.taskEnrichmentCursor,
            batchSize: this.batchSize,
            now: this.now,
            shouldContinue,
            project: this.projectTaskUpdate,
            advanceCheckpoint: (cursor) => this.advanceNumericCheckpoint(
                TASK_ENRICHMENT_CHECKPOINT, cursor
            ),
            deferProjection: (cursor, payload) => this.checkpoints.enqueueRetry(
                TASK_ENRICHMENT_CHECKPOINT, String(cursor), payload
            )
        });
        this.taskEnrichmentCursor = result.cursor;
        return result.repaired;
    }

    private async reconcileRepositories(shouldContinue: () => boolean): Promise<number> {
        const hasHistory = await this.database.schema.hasTable('repository_indexing_transitions');
        const repaired = hasHistory
            ? await this.reconcileRepositoryTransitionHistory(shouldContinue)
            : await this.reconcileCurrentRepositories(shouldContinue);
        return repaired;
    }

    private async reconcileRepositoryTransitionHistory(
        shouldContinue: () => boolean
    ): Promise<number> {
        const rows = await this.database('repository_indexing_transitions')
            .select('transition_id', 'full_name', 'branch', 'status', 'transition_at', 'run_id')
            .where('transition_id', '>', this.repositoryTransitionCursor)
            .whereIn('status', ['indexing', 'completed', 'failed', 'idle'])
            .orderBy('transition_id', 'asc')
            .limit(this.batchSize) as Array<{
                transition_id: number; full_name: string; branch: string;
                status: ReconciledRepositoryStatus; transition_at: unknown; run_id: string;
            }>;

        let repaired = 0;
        for (const row of rows) {
            if (!shouldContinue()) break;
            let transitionAt: string;
            try {
                transitionAt = normalizedReconciliationTimestamp(row.transition_at);
            } catch (error) {
                logMalformedReconciliationTimestamp(
                    INDEXING_HISTORY_CHECKPOINT, row.transition_id, row.transition_at, error
                );
                await this.advanceNumericCheckpoint(INDEXING_HISTORY_CHECKPOINT, row.transition_id);
                this.repositoryTransitionCursor = row.transition_id;
                continue;
            }
            const payload: IndexingUpdatePayload = {
                eventType: 'indexing:update',
                repository: row.full_name,
                branch: row.branch,
                phase: row.status,
                transitionAt,
                runId: row.run_id,
                timestamp: reconciliationPublicationTimestamp(this.now(), transitionAt)
            };
            const outcome = await this.projectIndexingUpdate(payload);
            if (outcome === 'deferred'
                && !await this.checkpoints.enqueueRetry(
                    INDEXING_HISTORY_CHECKPOINT, String(row.transition_id), payload
                )) break;
            await this.advanceNumericCheckpoint(INDEXING_HISTORY_CHECKPOINT, row.transition_id);
            this.repositoryTransitionCursor = row.transition_id;
            if (outcome === 'completed') repaired++;
        }
        return repaired;
    }

    private async reconcileCurrentRepositories(shouldContinue: () => boolean): Promise<number> {
        if (!await this.database.schema.hasTable('repositories')
            || !await this.database.schema.hasColumn('repositories', 'indexing_run_id')) return 0;
        const query = this.database('repositories')
            .select(
                'full_name', 'branch', 'indexing_status', 'indexing_transition_at',
                'indexing_run_id', 'updated_at'
            )
            .whereIn('indexing_status', ['indexing', 'completed', 'failed', 'idle'])
            .whereNotNull('indexing_transition_at')
            .whereNotNull('indexing_run_id');
        if (this.repositoryCursor) {
            const cursor = this.repositoryCursor;
            query.andWhere((afterCursor) => afterCursor
                .where('updated_at', '>', cursor.updatedAt)
                .orWhere((sameTime) => sameTime.where('updated_at', '=', cursor.updatedAt)
                    .andWhere((afterIdentity) => afterIdentity
                        .where('full_name', '>', cursor.fullName)
                        .orWhere((sameRepository) => sameRepository
                            .where({ full_name: cursor.fullName })
                            .where('branch', '>', cursor.branch)))));
        }
        const rows = await query
            .orderBy('updated_at', 'asc')
            .orderBy('full_name', 'asc')
            .orderBy('branch', 'asc')
            .limit(this.batchSize) as Array<{
                full_name: string; branch: string; indexing_status: ReconciledRepositoryStatus;
                indexing_transition_at: unknown; indexing_run_id: string; updated_at: string;
            }>;

        let repaired = 0;
        for (const row of rows) {
            if (!shouldContinue()) break;
            const cursor = { updatedAt: row.updated_at, fullName: row.full_name, branch: row.branch };
            let transitionAt: string;
            try {
                transitionAt = normalizedReconciliationTimestamp(row.indexing_transition_at);
            } catch (error) {
                logMalformedReconciliationTimestamp(
                    INDEXING_CURRENT_CHECKPOINT,
                    `${row.full_name}:${row.branch}`,
                    row.indexing_transition_at,
                    error
                );
                await this.advanceTupleCheckpoint(INDEXING_CURRENT_CHECKPOINT, [
                    cursor.updatedAt, cursor.fullName, cursor.branch
                ]);
                this.repositoryCursor = cursor;
                continue;
            }
            const payload: IndexingUpdatePayload = {
                eventType: 'indexing:update', repository: row.full_name, branch: row.branch,
                phase: row.indexing_status, transitionAt, runId: row.indexing_run_id,
                timestamp: reconciliationPublicationTimestamp(this.now(), transitionAt)
            };
            const cursorTuple = [cursor.updatedAt, cursor.fullName, cursor.branch];
            const outcome = await this.projectIndexingUpdate(payload);
            if (outcome === 'deferred'
                && !await this.checkpoints.enqueueRetry(
                    INDEXING_CURRENT_CHECKPOINT, JSON.stringify(cursorTuple), payload
                )) break;
            await this.advanceTupleCheckpoint(INDEXING_CURRENT_CHECKPOINT, cursorTuple);
            this.repositoryCursor = cursor;
            if (outcome === 'completed') repaired++;
        }
        return repaired;
    }

    private async reconcileDrafts(shouldContinue: () => boolean): Promise<number> {
        if (!await this.database.schema.hasTable('task_drafts')
            || !await this.database.schema.hasColumn('task_drafts', 'review_transition_at')) return 0;
        const query = this.database('task_drafts')
            .select('draft_id', 'review_transition_at', 'updated_at')
            .where({ status: 'review' });
        if (this.draftCursor) {
            const cursor = this.draftCursor;
            query.andWhere((afterCursor) => afterCursor
                .where('updated_at', '>', cursor.updatedAt)
                .orWhere((sameTime) => sameTime
                    .where('updated_at', '=', cursor.updatedAt)
                    .where('draft_id', '>', cursor.draftId)));
        }
        const rows = await query
            .orderBy('updated_at', 'asc')
            .orderBy('draft_id', 'asc')
            .limit(this.batchSize) as Array<{
                draft_id: string; review_transition_at: unknown; updated_at: string;
            }>;

        let repaired = 0;
        for (const row of rows) {
            if (!shouldContinue()) break;
            let transitionAt: string;
            try {
                transitionAt = normalizedReconciliationTimestamp(row.review_transition_at ?? row.updated_at);
            } catch (error) {
                logMalformedReconciliationTimestamp(
                    DRAFT_CHECKPOINT, row.draft_id, row.review_transition_at ?? row.updated_at, error
                );
                await this.advanceTupleCheckpoint(DRAFT_CHECKPOINT, [row.updated_at, row.draft_id]);
                this.draftCursor = { updatedAt: row.updated_at, draftId: row.draft_id };
                continue;
            }
            const payload: DraftUpdatePayload = {
                eventType: 'draft:update', draftId: row.draft_id,
                step: 'notification-reconciliation', status: 'completed', draftStatus: 'review',
                timestamp: reconciliationPublicationTimestamp(this.now(), transitionAt)
            };
            const cursorTuple = [row.updated_at, row.draft_id];
            const outcome = await this.projectDraftUpdate(payload);
            if (outcome === 'deferred'
                && !await this.checkpoints.enqueueRetry(
                    DRAFT_CHECKPOINT,
                    JSON.stringify(cursorTuple),
                    { ...payload, step: 'notification-reconciliation-retry' }
                )) break;
            await this.advanceTupleCheckpoint(DRAFT_CHECKPOINT, cursorTuple);
            this.draftCursor = { updatedAt: row.updated_at, draftId: row.draft_id };
            if (outcome === 'completed') repaired++;
        }
        return repaired;
    }

    private async advanceNumericCheckpoint(
        source: NotificationProjectionCheckpointSource,
        cursor: number
    ): Promise<void> {
        await this.checkpoints.save(source, String(cursor));
    }

    private async advanceTupleCheckpoint(
        source: NotificationProjectionCheckpointSource,
        cursor: string[]
    ): Promise<void> {
        await this.checkpoints.save(source, JSON.stringify(cursor));
    }

    private async pruneDurableHistory(): Promise<void> {
        if (this.repositoryTransitionCursor <= 0 && this.taskEnrichmentCursor <= 0) return;
        const nowMs = new Date(this.now()).getTime();
        if (!Number.isFinite(nowMs)
            || nowMs - this.lastRetentionPruneAt < RETENTION_PRUNE_INTERVAL_MS) return;
        const cutoff = normalizeISO8601Timestamp(nowMs - this.transitionRetentionMs);
        if (this.repositoryTransitionCursor > 0) {
            await this.checkpoints.pruneTerminalIndexingActivities(
                this.repositoryTransitionCursor,
                cutoff
            );
            await this.checkpoints.pruneIndexingTransitions(
                this.repositoryTransitionCursor,
                cutoff
            );
        }
        if (this.taskEnrichmentCursor > 0) {
            await this.checkpoints.pruneTaskEnrichments(this.taskEnrichmentCursor, cutoff);
        }
        this.lastRetentionPruneAt = nowMs;
    }

}
