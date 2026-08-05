import { db } from '../db/connection.js';
import type { Redis } from 'ioredis';
import { getEventPublisher } from './eventPublisher.js';
import logger from './logger.js';
import { hashTaskAttemptToken } from './taskAttemptGeneration.js';
import {
    TaskStates,
    type TaskState,
    type TaskStateData,
    type UpdateMetadata,
} from './workerStateManager.types.js';

export const COMPARE_AND_SET_TASK_STATE_SCRIPT = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then
    return 0
end
redis.call('setex', KEYS[1], ARGV[2], ARGV[3])
return 1
`;

export const CREATE_TASK_STATE_SCRIPT = `
local version = tonumber(redis.call('get', KEYS[2])) or 0
local current = redis.call('get', KEYS[1])
if current then
    local decoded, existing = pcall(cjson.decode, current)
    if decoded and tonumber(existing.version) and tonumber(existing.version) > version then
        version = tonumber(existing.version)
    end
end
version = version + 1
redis.call('set', KEYS[2], version)
local next = cjson.decode(ARGV[2])
next.version = version
redis.call('setex', KEYS[1], ARGV[1], cjson.encode(next))
return version
`;

export const CREATE_FENCED_TASK_STATE_SCRIPT = `
if redis.call('get', KEYS[2]) ~= ARGV[1] then
    return 0
end
local version = tonumber(redis.call('get', KEYS[3])) or 0
local current = redis.call('get', KEYS[1])
if current then
    local decoded, existing = pcall(cjson.decode, current)
    if decoded and tonumber(existing.version) and tonumber(existing.version) > version then
        version = tonumber(existing.version)
    end
end
version = version + 1
redis.call('set', KEYS[3], version)
local next = cjson.decode(ARGV[3])
next.version = version
redis.call('setex', KEYS[1], ARGV[2], cjson.encode(next))
return version
`;

export const MAX_CAS_ATTEMPTS = 8;
const MAX_CAS_BACKOFF_MS = 25;

const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
    TaskStates.COMPLETED,
    TaskStates.FAILED,
    TaskStates.CANCELLED,
]);

interface CreateTaskStateRecordOptions {
    stateKey: string;
    revisionKey: string;
    stateExpiry: number;
    state: TaskStateData;
    prProcessingLockToken?: string;
    prProcessingLockKey?: string;
}

export async function createTaskStateRecord(
    redis: Pick<InstanceType<typeof Redis>, 'eval'>,
    options: CreateTaskStateRecordOptions,
): Promise<number> {
    const { stateKey, revisionKey, stateExpiry, state } = options;
    if (options.prProcessingLockToken && options.prProcessingLockKey) {
        return Number(await redis.eval(
            CREATE_FENCED_TASK_STATE_SCRIPT, 3,
            stateKey, options.prProcessingLockKey, revisionKey,
            options.prProcessingLockToken, stateExpiry, JSON.stringify(state),
        ));
    }
    return Number(await redis.eval(
        CREATE_TASK_STATE_SCRIPT, 2,
        stateKey, revisionKey, stateExpiry, JSON.stringify(state),
    ));
}

export interface PersistedTaskStateTransition {
    previousState: TaskState;
    newState: TaskState;
    metadata: UpdateMetadata;
}

export function canTransitionTaskState(
    currentState: TaskState,
    newState: TaskState,
    metadata: UpdateMetadata,
): boolean {
    if (!TERMINAL_TASK_STATES.has(currentState)) return true;
    return metadata.isRetry === true && !TERMINAL_TASK_STATES.has(newState);
}

export function applyTaskStateUpdate(
    state: TaskStateData,
    newState: TaskState,
    metadata: UpdateMetadata,
): void {
    const previousState = state.state;
    state.state = newState;
    state.updatedAt = new Date().toISOString();
    state.version = (state.version ?? 0) + 1;
    state.attempts = metadata.isRetry ? (state.attempts + 1) : state.attempts;

    if (metadata.error) {
        state.lastError = {
            message: metadata.error.message,
            category: metadata.error.category ?? 'unknown',
            timestamp: new Date().toISOString(),
        };
    }
    if (metadata.worktreeInfo) state.worktreeInfo = metadata.worktreeInfo;
    if (metadata.claudeResult) {
        state.claudeResult = {
            success: metadata.claudeResult.success,
            sessionId: metadata.claudeResult.sessionId,
            executionTime: metadata.claudeResult.executionTime,
        };
    }
    if (metadata.prResult) state.prResult = metadata.prResult;

    state.history.push({
        state: newState,
        timestamp: new Date().toISOString(),
        reason: metadata.reason ?? `State changed from ${previousState}`,
        metadata: metadata.historyMetadata ?? {},
    });
}

export async function waitForCASRetry(attempt: number): Promise<void> {
    const exponentialCap = Math.min(MAX_CAS_BACKOFF_MS, 2 ** attempt);
    const delayMs = Math.floor(Math.random() * (exponentialCap + 1));
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
}

interface PersistTaskStateCreationOptions {
    /** Fenced PR attempts cannot proceed without their SQL generation row. */
    requireDatabase?: boolean;
}

export async function persistTaskStateCreation(
    state: TaskStateData,
    options: PersistTaskStateCreationOptions = {},
): Promise<void> {
    const taskId = state.taskId;
    const correlatedLogger = logger.withCorrelation(state.correlationId);
    const repoOwner = state.issueRef.repoOwner ?? 'unknown';
    const repoName = state.issueRef.repoName ?? 'unknown';
    const repository = `${repoOwner}/${repoName}`;
    const taskData = {
        task_id: taskId,
        job_id: null,
        correlation_id: state.correlationId,
        repository,
        issue_number: state.issueRef.number,
        task_type: state.issueRef.type ?? 'issue',
        model_name: state.issueRef.modelName ?? null,
        created_at: state.createdAt,
        initial_job_data: JSON.stringify(state.issueRef),
        attempt_generation: state.prProcessingLockToken
            ? hashTaskAttemptToken(state.prProcessingLockToken)
            : null,
    };
    try {
        await db('tasks').insert(taskData).onConflict('task_id').merge({
            correlation_id: taskData.correlation_id,
            initial_job_data: taskData.initial_job_data,
            attempt_generation: taskData.attempt_generation,
        });
    } catch (error) {
        correlatedLogger.error(
            { error: (error as Error).message, taskId },
            'Failed to persist task generation to database',
        );
        if (options.requireDatabase) throw error;
        return;
    }

    try {
        await db('task_history').insert({
            task_id: taskId,
            state: TaskStates.PENDING,
            timestamp: state.createdAt,
            reason: 'Task created',
            metadata: JSON.stringify({}),
        });
    } catch (error) {
        correlatedLogger.error(
            { error: (error as Error).message, taskId },
            'Failed to persist initial task history to database',
        );
    }
    correlatedLogger.debug({ taskId }, 'Task state persisted to database');

    try {
        const eventPublisher = getEventPublisher();
        await eventPublisher.publishTaskUpdate({
            taskId,
            state: TaskStates.PENDING,
            repository,
            issueNumber: state.issueRef.number,
            version: state.version,
            updatedAt: state.updatedAt,
        });
    } catch (error) {
        correlatedLogger.warn(
            { error: (error as Error).message, taskId },
            'Failed to publish initial task state update event',
        );
    }
}

export async function persistTaskStateUpdate(
    taskId: string,
    state: TaskStateData,
    transition: PersistedTaskStateTransition,
): Promise<void> {
    const { previousState, newState, metadata } = transition;
    const correlatedLogger = logger.withCorrelation(state.correlationId);
    correlatedLogger.info({
        taskId,
        issueNumber: state.issueRef.number,
        repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
        previousState,
        newState,
        attempts: state.attempts,
    }, 'Task state updated');

    const historyTimestamp = state.history.at(-1)?.timestamp ?? state.updatedAt;
    const historyData = {
        task_id: taskId,
        state: newState,
        timestamp: historyTimestamp,
        reason: metadata.reason ?? `State changed from ${previousState}`,
        metadata: JSON.stringify({
            ...(metadata.historyMetadata ?? {}),
            previousState,
            attempts: state.attempts,
            stateVersion: state.version ?? 0,
            stateUpdatedAt: state.updatedAt,
            error: metadata.error,
            worktreeInfo: metadata.worktreeInfo,
            claudeResult: metadata.claudeResult,
            prResult: metadata.prResult,
            commitHash: metadata.commitHash,
        }),
    };
    try {
        await db('task_history').insert(historyData);
        correlatedLogger.debug({ taskId, newState }, 'Task state update persisted to database');
    } catch (error) {
        correlatedLogger.error(
            { error: (error as Error).message, taskId },
            'Failed to persist task state update to database',
        );
    }

    try {
        const eventPublisher = getEventPublisher();
        await eventPublisher.publishTaskUpdate({
            taskId,
            state: newState,
            previousState,
            repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
            issueNumber: state.issueRef.number,
            version: state.version,
            updatedAt: state.updatedAt,
            metadata: {
                attempts: state.attempts,
                reason: metadata.reason,
            },
        });
    } catch (error) {
        correlatedLogger.warn(
            { error: (error as Error).message, taskId },
            'Failed to publish task state update event',
        );
    }
}
