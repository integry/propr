import type { Knex } from 'knex';
import type { IssueJobData } from '@propr/core';
import type { ReplacementCause } from './policy.js';

export type ReplacementState = 'pending' | 'dispatched' | 'skipped' | 'exhausted';

export interface ReplacementRequestRecord {
    cause: ReplacementCause;
    terminalReason?: string | null;
    requestedAt: string;
}

export interface ReplaceableTask {
    taskId: string;
    repository: string;
    issueNumber: number | null;
    taskType: string | null;
    modelName: string | null;
    replacesTaskId: string | null;
    replacedByTaskId: string | null;
    attemptNumber: number;
    lineageRootTaskId: string;
    replacementCause: ReplacementCause | null;
    replacementState: ReplacementState | null;
    replacementRequest: ReplacementRequestRecord | null;
    replayJobData: IssueJobData | null;
    branchName: string | null;
    latestState: string | null;
    latestTerminalReason: string | null;
}

export interface LineageAttempt {
    taskId: string;
    attemptNumber: number;
    replacementCause: ReplacementCause | null;
    state: string | null;
    costUsd: number;
}

export interface CreateReplacementInput {
    original: ReplaceableTask;
    replacementTaskId: string;
    jobId: string;
    correlationId: string;
    attemptNumber: number;
    cause: ReplacementCause;
    jobData: IssueJobData;
    /** What a later replacement of this attempt re-runs; keeps the lineage's original cost cap. */
    replayData: IssueJobData;
    timestamp: string;
}

/** A timeline event recorded on a task without changing its state. */
export interface TimelineEvent {
    taskId: string;
    event: 'replacement.dispatched' | 'replacement.skipped' | 'replacement.exhausted';
    reason: string;
    metadata: Record<string, unknown>;
    timestamp: string;
}

export interface PendingReplacementRequest {
    taskId: string;
    request: ReplacementRequestRecord;
    latestState: string | null;
}

export interface TaskReplacementStore {
    loadTask(taskId: string): Promise<ReplaceableTask | null>;
    loadLineage(rootTaskId: string): Promise<LineageAttempt[]>;
    markRequested(taskId: string, request: ReplacementRequestRecord): Promise<boolean>;
    setState(taskId: string, state: ReplacementState | null): Promise<void>;
    /** Claims the original's single replacement slot and persists the new attempt. */
    createReplacement(input: CreateReplacementInput): Promise<boolean>;
    /** Undoes `createReplacement` when the replacement could not be queued. */
    revertReplacement(originalTaskId: string, replacementTaskId: string): Promise<void>;
    appendEvent(entry: TimelineEvent): Promise<void>;
    listPendingRequests(requestedBefore: string, limit: number): Promise<PendingReplacementRequest[]>;
}

/** Fields that describe one queue delivery rather than the task, or are re-read on every run. */
const TRANSIENT_JOB_FIELDS = ['issuePayload', 'repoPayload', 'isRetryFromRateLimit', 'replacementBranch'] as const;

/** The queue payload a replacement re-runs: agent/model selection and per-task overrides. */
export function replayJobData(data: IssueJobData): IssueJobData {
    const replay: Record<string, unknown> = { ...data };
    for (const field of TRANSIENT_JOB_FIELDS) delete replay[field];
    // Repository workflow policy and capacity deferrals are resolved again by every run.
    for (const field of Object.keys(replay)) {
        if (field.startsWith('repositoryWorkflow')) delete replay[field];
    }
    return replay as unknown as IssueJobData;
}

function parseJson<T>(value: unknown): T | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') return value as T;
    if (typeof value !== 'string') return null;
    try {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === 'object' ? parsed as T : null;
    } catch {
        return null;
    }
}

function text(value: unknown): string | null {
    return value === null || value === undefined || value === '' ? null : String(value);
}

function positiveInteger(value: unknown): number | null {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function latestHistorySubquery(database: Knex, column: 'state' | 'metadata', alias: string): Knex.Raw {
    // Timeline events repeat the current state; metadata comes from the last transition.
    const transitionsOnly = column === 'metadata'
        ? "AND (latest_h.metadata IS NULL OR json_extract(latest_h.metadata, '$.event') IS NULL)"
        : '';
    return database.raw(`(
        SELECT latest_h.${column}
        FROM task_history AS latest_h
        WHERE latest_h.task_id = t.task_id ${transitionsOnly}
        ORDER BY latest_h.history_id DESC
        LIMIT 1
    ) AS ${alias}`);
}

function taskFromRow(row: Record<string, unknown>): ReplaceableTask {
    const taskId = String(row.task_id);
    const latestMetadata = parseJson<{ terminalReason?: unknown }>(row.latest_metadata);
    return {
        taskId,
        repository: String(row.repository),
        issueNumber: positiveInteger(row.issue_number),
        taskType: text(row.task_type),
        modelName: text(row.model_name),
        replacesTaskId: text(row.replaces_task_id),
        replacedByTaskId: text(row.replaced_by_task_id),
        attemptNumber: positiveInteger(row.attempt_number) ?? 1,
        lineageRootTaskId: text(row.lineage_root_task_id) ?? taskId,
        replacementCause: text(row.replacement_cause) as ReplacementCause | null,
        replacementState: text(row.replacement_state) as ReplacementState | null,
        replacementRequest: parseJson<ReplacementRequestRecord>(row.replacement_request),
        replayJobData: parseJson<IssueJobData>(row.replay_job_data),
        branchName: text(row.branch_name),
        latestState: text(row.latest_state),
        latestTerminalReason: typeof latestMetadata?.terminalReason === 'string' ? latestMetadata.terminalReason : null,
    };
}

function initialIssueRef(data: IssueJobData, correlationId: string): Record<string, unknown> {
    return {
        number: data.number, repoOwner: data.repoOwner, repoName: data.repoName, type: 'issue',
        ...Object.fromEntries(['triggeringLabel', 'modelName', 'agentAlias'].flatMap(key =>
            typeof (data as unknown as Record<string, unknown>)[key] === 'string'
                ? [[key, (data as unknown as Record<string, unknown>)[key]]]
                : [])),
        correlationId,
    };
}

export function createTaskReplacementStore(database: Knex): TaskReplacementStore {
    const selectTask = () => database('tasks as t').select(
        't.task_id', 't.repository', 't.issue_number', 't.task_type', 't.model_name',
        't.replaces_task_id', 't.replaced_by_task_id', 't.attempt_number', 't.lineage_root_task_id',
        't.replacement_cause', 't.replacement_state', 't.replacement_request', 't.replay_job_data', 't.branch_name',
        latestHistorySubquery(database, 'state', 'latest_state'),
        latestHistorySubquery(database, 'metadata', 'latest_metadata'),
    );

    return {
        async loadTask(taskId) {
            const row = await selectTask().where('t.task_id', taskId).first() as Record<string, unknown> | undefined;
            return row ? taskFromRow(row) : null;
        },

        async loadLineage(rootTaskId) {
            const rows = await selectTask()
                .where('t.task_id', rootTaskId)
                .orWhere('t.lineage_root_task_id', rootTaskId) as Array<Record<string, unknown>>;
            const tasks = rows.map(taskFromRow);
            const costs = new Map<string, number>();
            if (tasks.length > 0) {
                const costRows = await database('llm_executions')
                    .whereIn('task_id', tasks.map(task => task.taskId))
                    .groupBy('task_id')
                    .select('task_id')
                    .sum({ cost: 'cost_usd' }) as Array<{ task_id: string; cost: unknown }>;
                for (const row of costRows) costs.set(String(row.task_id), Number(row.cost) || 0);
            }
            return tasks
                .map(task => ({
                    taskId: task.taskId,
                    attemptNumber: task.attemptNumber,
                    replacementCause: task.replacementCause,
                    state: task.latestState,
                    costUsd: costs.get(task.taskId) ?? 0,
                }))
                .sort((left, right) => left.attemptNumber - right.attemptNumber);
        },

        async markRequested(taskId, request) {
            const updated = await database('tasks')
                .where({ task_id: taskId })
                .whereNull('replaced_by_task_id')
                .update({ replacement_state: 'pending', replacement_request: JSON.stringify(request) });
            return updated > 0;
        },

        async setState(taskId, state) {
            await database('tasks').where({ task_id: taskId }).update({ replacement_state: state });
        },

        async createReplacement(input) {
            const { original, replacementTaskId, jobId, correlationId, attemptNumber, cause, jobData, replayData, timestamp } = input;
            return database.transaction(async trx => {
                const claimed = await trx('tasks')
                    .where({ task_id: original.taskId })
                    .whereNull('replaced_by_task_id')
                    .update({ replaced_by_task_id: replacementTaskId });
                if (claimed === 0) return false;
                await trx('tasks').where({ job_id: jobId }).whereNot({ task_id: replacementTaskId }).update({ job_id: null });
                await trx('tasks').insert({
                    task_id: replacementTaskId,
                    job_id: jobId,
                    correlation_id: correlationId,
                    repository: original.repository,
                    issue_number: original.issueNumber,
                    task_type: original.taskType ?? 'issue',
                    model_name: jobData.modelName ?? original.modelName,
                    created_at: timestamp,
                    initial_job_data: JSON.stringify(initialIssueRef(jobData, correlationId)),
                    replaces_task_id: original.taskId,
                    attempt_number: attemptNumber,
                    lineage_root_task_id: original.lineageRootTaskId,
                    replacement_cause: cause,
                    replay_job_data: JSON.stringify(replayJobData(replayData)),
                });
                await trx('task_history').insert({
                    task_id: replacementTaskId,
                    state: 'pending',
                    timestamp,
                    reason: `Replacement attempt ${attemptNumber} queued`,
                    metadata: JSON.stringify({ replacesTaskId: original.taskId, attemptNumber, replacementCause: cause }),
                });
                // The original stays the root of its lineage even when it predates lineage stamps.
                await trx('tasks').where({ task_id: original.taskId }).whereNull('lineage_root_task_id')
                    .update({ lineage_root_task_id: original.lineageRootTaskId });
                return true;
            });
        },

        async revertReplacement(originalTaskId, replacementTaskId) {
            await database.transaction(async trx => {
                await trx('task_history').where({ task_id: replacementTaskId }).delete();
                await trx('tasks').where({ task_id: replacementTaskId }).delete();
                await trx('tasks').where({ task_id: originalTaskId, replaced_by_task_id: replacementTaskId })
                    .update({ replaced_by_task_id: null });
            });
        },

        async appendEvent({ taskId, event, reason, metadata, timestamp }) {
            // Timeline events repeat the task's current state so they never change it.
            const latest = await database('task_history')
                .where({ task_id: taskId })
                .orderBy('history_id', 'desc')
                .first('state') as { state?: unknown } | undefined;
            await database('task_history').insert({
                task_id: taskId,
                state: typeof latest?.state === 'string' ? latest.state : 'failed',
                timestamp,
                reason,
                metadata: JSON.stringify({ ...metadata, event }),
            });
        },

        async listPendingRequests(requestedBefore, limit) {
            const rows = await database('tasks as t')
                .where('t.replacement_state', 'pending')
                .whereNull('t.replaced_by_task_id')
                .select('t.task_id', 't.replacement_request', latestHistorySubquery(database, 'state', 'latest_state'))
                .orderBy('t.task_id')
                .limit(limit) as Array<Record<string, unknown>>;
            return rows.flatMap(row => {
                const request = parseJson<ReplacementRequestRecord>(row.replacement_request);
                if (!request || typeof request.requestedAt !== 'string' || request.requestedAt > requestedBefore) return [];
                return [{ taskId: String(row.task_id), request, latestState: text(row.latest_state) }];
            });
        },
    };
}

/** Persists what a replacement needs from a running issue task, once per task. */
export async function recordReplayableIssueTask(
    database: Knex,
    taskId: string,
    data: IssueJobData,
): Promise<void> {
    await database('tasks').where({ task_id: taskId }).whereNull('replay_job_data')
        .update({ replay_job_data: JSON.stringify(replayJobData(data)) });
    if (data.replacesTaskId) {
        // Normally stamped when the replacement was queued; repeat for rows created by the worker.
        await database('tasks').where({ task_id: taskId }).whereNull('replaces_task_id').update({
            replaces_task_id: data.replacesTaskId,
            attempt_number: data.attemptNumber ?? 2,
            lineage_root_task_id: data.lineageRootTaskId ?? data.replacesTaskId,
            replacement_cause: data.replacementCause ?? null,
        });
    }
}

/** Records the pushed work branch so a replacement can continue on it. */
export async function recordPushedBranch(database: Knex, taskId: string, branchName: string): Promise<void> {
    await database('tasks').where({ task_id: taskId }).update({ branch_name: branchName });
}
