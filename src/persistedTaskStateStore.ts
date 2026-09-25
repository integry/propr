import type { Knex } from 'knex';

export const RECONCILABLE_PERSISTED_TASK_STATES = [
    'pending',
    'processing',
    'claude_execution',
    'post_processing',
] as const;

export interface PersistedTaskStateCandidate {
    taskId: string;
    jobId: string | null;
    repository: string;
    issueNumber: number | null;
    taskType: string | null;
    state: string;
    updatedAt: string | number;
    historyId: number;
}

export interface PersistedTaskStatePage {
    tasks: PersistedTaskStateCandidate[];
    nextCursor: string;
}

export interface MissingTaskObservation {
    observations: number;
    firstMissingAt: string;
}

export interface PersistedTaskTerminalTransition {
    state: 'completed' | 'failed' | 'cancelled';
    reason: string;
    metadata: Record<string, unknown>;
}

export interface PersistedTaskFinalizationResult {
    stateChanged: boolean;
    eventPublished: boolean;
}

export interface TaskStateEventPublisher {
    publishTaskUpdate(params: {
        taskId: string;
        state: string;
        previousState?: string;
        repository?: string;
        issueNumber?: number;
        timestamp?: string;
        metadata?: Record<string, unknown>;
    }): Promise<boolean>;
}

export interface PersistedTaskStateStore {
    scanNonTerminalTasks(cursor: string, count: number): Promise<PersistedTaskStatePage>;
    recordMissing(candidate: PersistedTaskStateCandidate, observedAt: string): Promise<MissingTaskObservation>;
    clearMissing(taskId: string): Promise<void>;
    ownsJobAssignment(candidate: PersistedTaskStateCandidate): Promise<boolean>;
    finalizeIfCurrent(
        candidate: PersistedTaskStateCandidate,
        transition: PersistedTaskTerminalTransition,
        timestamp: string,
    ): Promise<PersistedTaskFinalizationResult>;
}

interface CandidateRow {
    task_id: unknown;
    job_id: unknown;
    repository: unknown;
    issue_number: unknown;
    task_type: unknown;
    state: unknown;
    state_timestamp: string | number;
    history_id: unknown;
}

interface ObservationRow {
    task_id: string;
    expected_history_id: number;
    first_missing_at: string;
    observations: number;
}

function candidateFromRow(row: CandidateRow): PersistedTaskStateCandidate {
    return {
        taskId: String(row.task_id),
        jobId: row.job_id === null || row.job_id === undefined ? null : String(row.job_id),
        repository: String(row.repository),
        issueNumber: row.issue_number === null || row.issue_number === undefined
            ? null
            : Number(row.issue_number),
        taskType: row.task_type === null || row.task_type === undefined ? null : String(row.task_type),
        state: String(row.state),
        updatedAt: row.state_timestamp,
        historyId: Number(row.history_id),
    };
}

function returnedRows(result: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
    if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
        return (result as { rows: Array<Record<string, unknown>> }).rows;
    }
    return [];
}

export function createPersistedTaskStateStore(
    database: Knex,
    publisher: TaskStateEventPublisher,
): PersistedTaskStateStore {
    return {
        async scanNonTerminalTasks(cursor, count) {
            const query = database('tasks as t')
                .joinRaw(`
                    JOIN task_history AS h ON h.history_id = (
                        SELECT latest_h.history_id
                        FROM task_history AS latest_h
                        WHERE latest_h.task_id = t.task_id
                        ORDER BY latest_h.history_id DESC
                        LIMIT 1
                    )
                `)
                .where(function () {
                    this.whereNull('t.task_type').orWhereNot('t.task_type', 'goal');
                })
                .whereIn('h.state', RECONCILABLE_PERSISTED_TASK_STATES)
                .select(
                    't.task_id',
                    't.job_id',
                    't.repository',
                    't.issue_number',
                    't.task_type',
                    'h.state',
                    'h.timestamp as state_timestamp',
                    'h.history_id',
                )
                .orderBy('t.task_id', 'asc')
                .limit(count);
            if (cursor && cursor !== '0') query.where('t.task_id', '>', cursor);

            const rows = await query as CandidateRow[];
            return {
                tasks: rows.map(candidateFromRow),
                nextCursor: rows.length < count ? '0' : String(rows.at(-1)?.task_id ?? '0'),
            };
        },

        async recordMissing(candidate, observedAt) {
            return database.transaction(async trx => {
                const existing = await trx<ObservationRow>('task_reconciliation_observations')
                    .where({ task_id: candidate.taskId })
                    .first();
                if (existing?.expected_history_id === candidate.historyId) {
                    const observations = existing.observations + 1;
                    await trx('task_reconciliation_observations')
                        .where({ task_id: candidate.taskId })
                        .update({ observations, last_missing_at: observedAt });
                    return { observations, firstMissingAt: existing.first_missing_at };
                }

                await trx('task_reconciliation_observations').insert({
                    task_id: candidate.taskId,
                    expected_history_id: candidate.historyId,
                    first_missing_at: observedAt,
                    last_missing_at: observedAt,
                    observations: 1,
                }).onConflict('task_id').merge();
                return { observations: 1, firstMissingAt: observedAt };
            });
        },

        async clearMissing(taskId) {
            await database('task_reconciliation_observations').where({ task_id: taskId }).delete();
        },

        async ownsJobAssignment(candidate) {
            const row = await database('tasks')
                .where({ task_id: candidate.taskId })
                .first('job_id') as { job_id: unknown } | undefined;
            if (!row) return false;
            const jobId = row.job_id === null || row.job_id === undefined ? null : String(row.job_id);
            return jobId === candidate.jobId;
        },

        async finalizeIfCurrent(candidate, transition, timestamp) {
            // A deterministic BullMQ job ID can move to a newer task; the
            // scanned assignment must still be current or this row would adopt
            // the replacement job's outcome.
            const jobAssignment = candidate.jobId === null
                ? 'owner_t.job_id IS NULL'
                : 'owner_t.job_id = ?';
            const metadata = JSON.stringify({
                ...transition.metadata,
                previousState: candidate.state,
                expectedHistoryId: candidate.historyId,
            });
            const stateChanged = await database.transaction(async trx => {
                const result = await trx.raw(`
                    INSERT INTO task_history (task_id, state, timestamp, reason, metadata)
                    SELECT ?, ?, ?, ?, ?
                    WHERE ? = (
                        SELECT latest_h.history_id
                        FROM task_history AS latest_h
                        WHERE latest_h.task_id = ?
                        ORDER BY latest_h.history_id DESC
                        LIMIT 1
                    )
                    AND ? = (
                        SELECT expected_h.state
                        FROM task_history AS expected_h
                        WHERE expected_h.history_id = ? AND expected_h.task_id = ?
                    )
                    AND EXISTS (
                        SELECT 1
                        FROM tasks AS owner_t
                        WHERE owner_t.task_id = ? AND ${jobAssignment}
                    )
                    RETURNING history_id
                `, [
                    candidate.taskId,
                    transition.state,
                    timestamp,
                    transition.reason,
                    metadata,
                    candidate.historyId,
                    candidate.taskId,
                    candidate.state,
                    candidate.historyId,
                    candidate.taskId,
                    candidate.taskId,
                    ...(candidate.jobId === null ? [] : [candidate.jobId]),
                ]);
                const inserted = returnedRows(result).length === 1;
                if (inserted) {
                    await trx('task_reconciliation_observations').where({ task_id: candidate.taskId }).delete();
                }
                return inserted;
            });
            if (!stateChanged) return { stateChanged: false, eventPublished: false };

            const eventPublished = await publisher.publishTaskUpdate({
                taskId: candidate.taskId,
                state: transition.state,
                previousState: candidate.state,
                repository: candidate.repository,
                issueNumber: candidate.issueNumber ?? undefined,
                timestamp,
                metadata: { reason: transition.reason, reconciled: true },
            });
            return { stateChanged: true, eventPublished };
        },
    };
}
