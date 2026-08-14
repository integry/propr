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
import {
    type TaskRecoveryLease,
    withTaskRecoveryReadLease,
    withTaskRecoveryWriteLease,
} from './workerStateRecoveryLease.js';

type TaskStateRedis = Pick<InstanceType<typeof Redis>, 'eval' | 'get' | 'set'>;

const MAX_RESTORATION_VALIDATIONS = 8;

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

function isSamePersistedHistory(left: TaskStateData, right: TaskStateData): boolean {
    return left.historyId === right.historyId && left.state === right.state;
}

async function validatePersistedTaskState(
    restoredState: TaskStateData,
): Promise<TaskStateData> {
    let candidate = restoredState;
    for (let attempt = 0; attempt < MAX_RESTORATION_VALIDATIONS; attempt++) {
        const latest = await loadPersistedTaskState(candidate.taskId);
        if (!latest) throw new Error(`Persisted task disappeared during restoration: ${candidate.taskId}`);
        if (isSamePersistedHistory(candidate, latest)) return candidate;
        candidate = latest;
    }
    throw new Error(`Task state history kept changing during restoration for taskId: ${restoredState.taskId}`);
}

export async function restorePersistedTaskState(
    redis: TaskStateRedis,
    key: string,
    stateExpiry: number,
    taskId: string,
): Promise<TaskStateData | null> {
    return withTaskRecoveryReadLease(redis, key, lease => restorePersistedTaskStateWithLease(
        redis, { key, stateExpiry, taskId }, lease,
    ));
}

export async function restorePersistedTaskStateWithLease(
    redis: TaskStateRedis,
    options: { key: string; stateExpiry: number; taskId: string },
    lease: TaskRecoveryLease,
): Promise<TaskStateData | null> {
    const { key, stateExpiry, taskId } = options;
    const existingJson = await redis.get(key);
    if (existingJson) {
        logger.info({ taskId }, 'Task state already exists; preserving the current attempt');
        return JSON.parse(existingJson) as TaskStateData;
    }
    const persistedState = await loadPersistedTaskState(taskId);
    if (!persistedState) return null;
    const validated = await validatePersistedTaskState(persistedState);
    await lease.assertOwned();
    const restored = await redis.set(key, JSON.stringify(validated), 'EX', stateExpiry, 'NX');
    if (restored === 'OK') {
        await lease.assertOwned();
        const ownerJson = await redis.get(key);
        if (ownerJson !== JSON.stringify(validated)) {
            throw new Error(`Task state restoration lost Redis ownership for taskId: ${taskId}`);
        }
        logger.info({ taskId, state: validated.state }, 'Restored task state from persisted history');
        return validated;
    }
    const winnerJson = await redis.get(key);
    if (winnerJson) return JSON.parse(winnerJson) as TaskStateData;
    throw new Error(`Task state restoration raced with removal for taskId: ${taskId}`);
}

export async function readTaskStateWithRecoveryLease(
    redis: TaskStateRedis,
    key: string,
): Promise<TaskStateData | null> {
    return withTaskRecoveryReadLease(redis, key, async () => {
        const stateJson = await redis.get(key);
        return stateJson ? JSON.parse(stateJson) as TaskStateData : null;
    });
}

export async function associatePersistedTaskWithJob(taskId: string, jobId: string): Promise<void> {
    await db('tasks')
        .where({ task_id: taskId })
        .whereNull('job_id')
        .update({ job_id: jobId });
}

interface DatabaseTaskStateUpdateOptions {
    taskId: string;
    expectation: TaskStateExpectation;
    newState: TaskState;
    metadata: UpdateMetadata;
}

export async function updateDatabaseTaskStateIfCurrent(
    redis: TaskStateRedis,
    key: string,
    stateExpiry: number,
    options: DatabaseTaskStateUpdateOptions,
): Promise<TaskStateUpdateResult | null> {
    const { taskId, expectation, newState, metadata } = options;
    return withTaskRecoveryWriteLease(redis, key, async lease => {
        const redisJson = await redis.get(key);
        if (redisJson) return null;
        const result = await updatePersistedTaskStateIfCurrent(taskId, expectation, newState, metadata);
        if (!result) return null;
        await lease.assertOwned();
        await installDatabaseFallbackState(redis, {
            key, stateExpiry, state: result.state,
        });
        return result;
    });
}

async function installDatabaseFallbackState(
    redis: TaskStateRedis,
    options: {
        key: string;
        stateExpiry: number;
        state: TaskStateData;
    },
): Promise<void> {
    const { key, stateExpiry, state } = options;
    const installed = await redis.set(key, JSON.stringify(state), 'EX', stateExpiry, 'NX');
    if (installed === 'OK') return;
    throw new Error(`Database fallback lost Redis ownership for taskId: ${state.taskId}`);
}

async function updatePersistedTaskStateIfCurrent(
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
