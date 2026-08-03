import type { Knex } from 'knex';
import {
    normalizeISO8601Timestamp,
    type DraftUpdatePayload,
    type IndexingUpdatePayload,
    type TaskUpdatePayload
} from '@propr/shared';
import logger from '../utils/logger.js';
import {
    NotificationProjectionCheckpointStore,
    type NotificationProjectionCheckpointSource
} from './notificationProjectionCheckpointStore.js';

const DEFAULT_RECONCILIATION_BATCH_SIZE = 100;
export const DEFAULT_NOTIFICATION_INDEXING_TRANSITION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RETENTION_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const TERMINAL_TASK_STATES = ['completed', 'complete', 'succeeded', 'failed', 'error', 'cancelled', 'canceled'] as const;

const TASK_CHECKPOINT = 'terminal-task-history';
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

function positiveIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value > 0) return value;
    logger.warn({ name, value: raw }, 'Ignoring invalid notification reconciliation configuration');
    return fallback;
}

export function getNotificationIndexingTransitionRetentionMs(): number {
    return positiveIntegerEnv(
        'NOTIFICATION_INDEXING_TRANSITION_RETENTION_MS',
        DEFAULT_NOTIFICATION_INDEXING_TRANSITION_RETENTION_MS
    );
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
        throw new TypeError('durable notification transition timestamp is invalid');
    }
    return normalizeISO8601Timestamp(value);
}

function nonNegativeInteger(value: string | undefined): number | undefined {
    if (value === undefined || !/^\d+$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function stringTuple(value: string | undefined, length: number): string[] | undefined {
    if (value === undefined) return undefined;
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed) && parsed.length === length
            && parsed.every((part) => typeof part === 'string')
            ? parsed
            : undefined;
    } catch {
        return undefined;
    }
}

/** Bounded scans repair missed terminal projections and durably advance each source. */
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
        let repaired = await this.reconcileTasks(shouldContinue);
        if (shouldContinue()) repaired += await this.reconcileRepositories(shouldContinue);
        if (shouldContinue()) repaired += await this.reconcileDrafts(shouldContinue);
        return repaired;
    }

    private async ensureCursorsLoaded(): Promise<void> {
        this.cursorLoad ??= this.loadCursors();
        await this.cursorLoad;
    }

    private async loadCursors(): Promise<void> {
        const [task, indexingHistory, indexingCurrent, draft] = await Promise.all([
            this.checkpoints.load(TASK_CHECKPOINT),
            this.checkpoints.load(INDEXING_HISTORY_CHECKPOINT),
            this.checkpoints.load(INDEXING_CURRENT_CHECKPOINT),
            this.checkpoints.load(DRAFT_CHECKPOINT)
        ]);
        this.taskCursor = nonNegativeInteger(task) ?? 0;
        this.repositoryTransitionCursor = nonNegativeInteger(indexingHistory) ?? 0;
        const repositoryTuple = stringTuple(indexingCurrent, 3);
        if (repositoryTuple) {
            this.repositoryCursor = {
                updatedAt: repositoryTuple[0],
                fullName: repositoryTuple[1],
                branch: repositoryTuple[2]
            };
        }
        const draftTuple = stringTuple(draft, 2);
        if (draftTuple) this.draftCursor = { updatedAt: draftTuple[0], draftId: draftTuple[1] };
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
                transitionAt = normalizedTimestamp(row.timestamp);
            } catch (error) {
                this.logMalformedTimestamp(TASK_CHECKPOINT, row.history_id, row.timestamp, error);
                await this.advanceNumericCheckpoint(TASK_CHECKPOINT, row.history_id);
                this.taskCursor = row.history_id;
                continue;
            }
            const outcome = await this.projectTaskUpdate({
                eventType: 'task:update',
                taskId: row.task_id,
                state: row.state,
                timestamp: this.publicationTimestamp(transitionAt),
                metadata: {
                    ...parseMetadata(row.metadata),
                    transitionAt,
                    transitionSequence: row.history_id
                }
            });
            if (outcome === 'deferred') break;
            await this.advanceNumericCheckpoint(TASK_CHECKPOINT, row.history_id);
            this.taskCursor = row.history_id;
            repaired++;
        }
        return repaired;
    }

    private async reconcileRepositories(shouldContinue: () => boolean): Promise<number> {
        const hasHistory = await this.database.schema.hasTable('repository_indexing_transitions');
        const repaired = hasHistory
            ? await this.reconcileRepositoryTransitionHistory(shouldContinue)
            : await this.reconcileCurrentRepositories(shouldContinue);
        if (hasHistory && shouldContinue()) await this.pruneRepositoryTransitionHistory();
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
                transitionAt = normalizedTimestamp(row.transition_at);
            } catch (error) {
                this.logMalformedTimestamp(
                    INDEXING_HISTORY_CHECKPOINT, row.transition_id, row.transition_at, error
                );
                await this.advanceNumericCheckpoint(INDEXING_HISTORY_CHECKPOINT, row.transition_id);
                this.repositoryTransitionCursor = row.transition_id;
                continue;
            }
            const outcome = await this.projectIndexingUpdate({
                eventType: 'indexing:update',
                repository: row.full_name,
                branch: row.branch,
                phase: row.status,
                transitionAt,
                runId: row.run_id,
                timestamp: this.publicationTimestamp(transitionAt)
            });
            if (outcome === 'deferred') break;
            await this.advanceNumericCheckpoint(INDEXING_HISTORY_CHECKPOINT, row.transition_id);
            this.repositoryTransitionCursor = row.transition_id;
            repaired++;
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
                transitionAt = normalizedTimestamp(row.indexing_transition_at);
            } catch (error) {
                this.logMalformedTimestamp(
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
            const outcome = await this.projectIndexingUpdate({
                eventType: 'indexing:update', repository: row.full_name, branch: row.branch,
                phase: row.indexing_status, transitionAt, runId: row.indexing_run_id,
                timestamp: this.publicationTimestamp(transitionAt)
            });
            if (outcome === 'deferred') break;
            await this.advanceTupleCheckpoint(INDEXING_CURRENT_CHECKPOINT, [
                cursor.updatedAt, cursor.fullName, cursor.branch
            ]);
            this.repositoryCursor = cursor;
            repaired++;
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
                transitionAt = normalizedTimestamp(row.review_transition_at ?? row.updated_at);
            } catch (error) {
                this.logMalformedTimestamp(
                    DRAFT_CHECKPOINT, row.draft_id, row.review_transition_at ?? row.updated_at, error
                );
                await this.advanceTupleCheckpoint(DRAFT_CHECKPOINT, [row.updated_at, row.draft_id]);
                this.draftCursor = { updatedAt: row.updated_at, draftId: row.draft_id };
                continue;
            }
            const outcome = await this.projectDraftUpdate({
                eventType: 'draft:update', draftId: row.draft_id,
                step: 'notification-reconciliation', status: 'completed', draftStatus: 'review',
                timestamp: this.publicationTimestamp(transitionAt)
            });
            if (outcome === 'deferred') break;
            await this.advanceTupleCheckpoint(DRAFT_CHECKPOINT, [row.updated_at, row.draft_id]);
            this.draftCursor = { updatedAt: row.updated_at, draftId: row.draft_id };
            repaired++;
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

    private async pruneRepositoryTransitionHistory(): Promise<void> {
        if (this.repositoryTransitionCursor <= 0) return;
        const nowMs = new Date(this.now()).getTime();
        if (!Number.isFinite(nowMs)
            || nowMs - this.lastRetentionPruneAt < RETENTION_PRUNE_INTERVAL_MS) return;
        const cutoff = normalizeISO8601Timestamp(nowMs - this.transitionRetentionMs);
        await this.checkpoints.pruneTerminalIndexingActivities(
            this.repositoryTransitionCursor,
            cutoff
        );
        await this.checkpoints.pruneIndexingTransitions(this.repositoryTransitionCursor, cutoff);
        this.lastRetentionPruneAt = nowMs;
    }

    private logMalformedTimestamp(
        source: NotificationProjectionCheckpointSource,
        identity: string | number,
        value: unknown,
        error: unknown
    ): void {
        logger.warn({
            source,
            identity,
            value: String(value).slice(0, 128),
            error: error instanceof Error ? error.message : String(error)
        }, 'Skipping malformed durable notification transition and advancing its checkpoint');
    }

    private publicationTimestamp(transitionAt: string): string {
        const current = normalizeISO8601Timestamp(this.now());
        return current >= transitionAt ? current : transitionAt;
    }
}
