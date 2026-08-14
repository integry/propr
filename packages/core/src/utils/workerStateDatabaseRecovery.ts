import type { Redis } from 'ioredis';
import { db } from '../db/connection.js';
import { getEventPublisher } from './eventPublisher.js';
import logger from './logger.js';
import {
    TaskStates,
    type IssueRef,
    type NonTerminalTaskScanResult,
    type TaskState,
    type TaskStateData,
    type TaskStateExpectation,
    type TaskStateUpdateResult,
    type UpdateMetadata,
} from './workerStateManager.types.js';

type TaskStateRedis = Pick<InstanceType<typeof Redis>, 'get' | 'set'>;

function normalizeTimestamp(value: unknown): string {
    const parsed = new Date(String(value ?? ''));
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

function parsePersistedIssueRef(value: unknown, fallback: IssueRef): IssueRef {
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        if (parsed && typeof parsed === 'object') return { ...fallback, ...parsed as IssueRef };
    } catch {
        // Malformed historical payloads still remain recoverable from task columns.
    }
    return fallback;
}

function persistedRowToTaskState(row: Record<string, unknown>): TaskStateData {
    const repository = String(row.repository ?? 'unknown/unknown');
    const [repoOwner = 'unknown', repoName = 'unknown'] = repository.split('/');
    const issueRef = parsePersistedIssueRef(row.initial_job_data, {
        number: Number(row.issue_number ?? 0),
        repoOwner,
        repoName,
        type: String(row.task_type ?? 'issue'),
    });
    if (row.job_id) issueRef.jobId = String(row.job_id);
    return {
        taskId: String(row.task_id),
        issueRef,
        correlationId: String(row.correlation_id ?? ''),
        state: row.state as TaskState,
        createdAt: normalizeTimestamp(row.created_at),
        updatedAt: normalizeTimestamp(row.state_timestamp),
        version: Number(row.history_id),
        historyId: Number(row.history_id),
        attempts: 0,
        history: [],
    };
}

async function loadPersistedTaskState(taskId: string): Promise<TaskStateData | null> {
    const task = await db('tasks').where({ task_id: taskId }).first();
    if (!task) return null;
    const latestHistory = await db('task_history')
        .where({ task_id: taskId })
        .orderBy('history_id', 'desc')
        .first();
    if (!latestHistory) throw new Error(`Persisted task has no history for taskId: ${taskId}`);
    return persistedRowToTaskState({
        ...task,
        history_id: latestHistory.history_id,
        state: latestHistory.state,
        state_timestamp: latestHistory.timestamp,
    });
}

export async function restorePersistedTaskState(
    redis: TaskStateRedis,
    key: string,
    stateExpiry: number,
    taskId: string,
): Promise<TaskStateData | null> {
    const existingJson = await redis.get(key);
    if (existingJson) {
        logger.info({ taskId }, 'Task state already exists; preserving the current attempt');
        return JSON.parse(existingJson) as TaskStateData;
    }
    const persistedState = await loadPersistedTaskState(taskId);
    if (!persistedState) return null;
    const restored = await redis.set(
        key, JSON.stringify(persistedState), 'EX', stateExpiry, 'NX',
    );
    if (restored === 'OK') {
        logger.info({ taskId, state: persistedState.state }, 'Restored task state from persisted history');
        return persistedState;
    }
    const winnerJson = await redis.get(key);
    if (winnerJson) return JSON.parse(winnerJson) as TaskStateData;
    throw new Error(`Task state restoration raced with removal for taskId: ${taskId}`);
}

export async function associatePersistedTaskWithJob(taskId: string, jobId: string): Promise<void> {
    await db('tasks')
        .where({ task_id: taskId })
        .whereNull('job_id')
        .update({ job_id: jobId });
}

export async function updateDatabaseTaskStateIfCurrent(
    taskId: string,
    expectation: TaskStateExpectation,
    newState: TaskState,
    metadata: UpdateMetadata,
): Promise<TaskStateUpdateResult | null> {
    const timestamp = new Date().toISOString();
    const reason = metadata.reason ?? `State changed from ${expectation.state}`;
    const inserted = await db.transaction(async trx => {
        const latest = await trx('task_history')
            .where({ task_id: taskId })
            .orderBy('history_id', 'desc')
            .first();
        if (!latest
            || Number(latest.history_id) !== expectation.historyId
            || latest.state !== expectation.state) return null;
        const [historyId] = await trx('task_history').insert({
            task_id: taskId,
            state: newState,
            timestamp,
            reason,
            metadata: JSON.stringify({
                ...(metadata.historyMetadata ?? {}),
                previousState: expectation.state,
                error: metadata.error,
                recoveredFromHistoryId: expectation.historyId,
            }),
        });
        return Number(historyId);
    });
    if (inserted === null) return null;

    const task = await db('tasks').where({ task_id: taskId }).first();
    const repository = String(task?.repository ?? 'unknown/unknown');
    const [repoOwner = 'unknown', repoName = 'unknown'] = repository.split('/');
    const issueRef = parsePersistedIssueRef(task?.initial_job_data, {
        number: Number(task?.issue_number ?? 0), repoOwner, repoName,
    });
    const state: TaskStateData = {
        taskId,
        issueRef,
        correlationId: String(task?.correlation_id ?? expectation.correlationId),
        state: newState,
        createdAt: normalizeTimestamp(task?.created_at),
        updatedAt: timestamp,
        version: inserted,
        historyId: inserted,
        attempts: 0,
        history: [{ state: newState, timestamp, reason, metadata: metadata.historyMetadata }],
    };
    const publication = { historyPersisted: true, eventPublished: false, errors: [] as string[] };
    try {
        publication.eventPublished = await getEventPublisher().publishTaskUpdate({
            taskId,
            state: newState,
            previousState: expectation.state,
            repository,
            issueNumber: issueRef.number,
            timestamp,
            version: inserted,
            metadata: { reason, recoveredFromHistoryId: expectation.historyId },
        });
        if (!publication.eventPublished) publication.errors.push('event: publisher returned false');
    } catch (error) {
        publication.errors.push(`event: ${(error as Error).message}`);
    }
    return { state, publication };
}

async function scanDatabaseRecoverableTasks(
    afterTaskId: string,
    count: number,
): Promise<NonTerminalTaskScanResult> {
    const limit = Math.max(1, count);
    const latestHistory = db('task_history')
        .select('task_id')
        .max('history_id as history_id')
        .groupBy('task_id')
        .as('latest');
    const rows = await db('tasks as t')
        .join(latestHistory, 'latest.task_id', 't.task_id')
        .join('task_history as h', 'h.history_id', 'latest.history_id')
        .whereIn('h.state', [
            TaskStates.PENDING,
            TaskStates.PROCESSING,
            TaskStates.CLAUDE_EXECUTION,
            TaskStates.POST_PROCESSING,
        ])
        .modify(query => { if (afterTaskId) query.where('t.task_id', '>', afterTaskId); })
        .select('t.*', 'h.history_id', 'h.state', 'h.timestamp as state_timestamp')
        .orderBy('t.task_id', 'asc')
        .limit(limit);

    return {
        tasks: rows.map((row: Record<string, unknown>) => persistedRowToTaskState(row)),
        nextCursor: rows.length < limit
            ? 'redis:0'
            : `database:${String(rows[rows.length - 1].task_id)}`,
    };
}

export async function scanRecoverableTaskStates(
    scanRedis: (cursor: string, count: number) => Promise<NonTerminalTaskScanResult>,
    cursor = 'redis:0',
    count = 100,
): Promise<NonTerminalTaskScanResult> {
    if (!cursor.startsWith('database:')) {
        const redisCursor = cursor.startsWith('redis:') ? cursor.slice('redis:'.length) : cursor;
        const page = await scanRedis(redisCursor || '0', count);
        return {
            tasks: page.tasks,
            nextCursor: page.nextCursor === '0' ? 'database:' : `redis:${page.nextCursor}`,
        };
    }
    return scanDatabaseRecoverableTasks(cursor.slice('database:'.length), count);
}
