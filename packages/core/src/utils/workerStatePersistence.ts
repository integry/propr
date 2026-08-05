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
    return {0, 0}
end
local current = cjson.decode(ARGV[1])
local next = cjson.decode(ARGV[4])
local durable_version = tonumber(redis.call('get', KEYS[2])) or 0
local current_version = tonumber(current.version) or 0
local next_version = tonumber(next.version) or (current_version + 1)
if current_version > durable_version then
    durable_version = current_version
end
if next_version <= durable_version then
    next_version = durable_version + 1
end
next.version = next_version
redis.call('set', KEYS[2], next_version)
redis.call('setex', KEYS[1], ARGV[2], cjson.encode(next))
return {1, next_version}
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
local next = cjson.decode(ARGV[3])
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
local next = cjson.decode(ARGV[4])
next.version = version
redis.call('setex', KEYS[1], ARGV[2], cjson.encode(next))
return version
`;

export const DELETE_TASK_STATE_IF_ATTEMPT_SCRIPT = `
local current = redis.call('get', KEYS[1])
if not current then
    return 0
end
local decoded, state = pcall(cjson.decode, current)
if not decoded or state.prProcessingLockToken ~= ARGV[1] or tonumber(state.version) ~= tonumber(ARGV[2]) then
    return 0
end
return redis.call('del', KEYS[1])
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
    revisionExpiry: number;
    state: TaskStateData;
    prProcessingLockToken?: string;
    prProcessingLockKey?: string;
}

export async function createTaskStateRecord(
    redis: Pick<InstanceType<typeof Redis>, 'eval'>,
    options: CreateTaskStateRecordOptions,
): Promise<number> {
    const { stateKey, revisionKey, stateExpiry, revisionExpiry, state } = options;
    if (options.prProcessingLockToken && options.prProcessingLockKey) {
        return Number(await redis.eval(
            CREATE_FENCED_TASK_STATE_SCRIPT, 3,
            stateKey, options.prProcessingLockKey, revisionKey,
            options.prProcessingLockToken, stateExpiry, revisionExpiry, JSON.stringify(state),
        ));
    }
    return Number(await redis.eval(
        CREATE_TASK_STATE_SCRIPT, 2,
        stateKey, revisionKey, stateExpiry, revisionExpiry, JSON.stringify(state),
    ));
}

interface CompareAndSetTaskStateRecordOptions {
    stateKey: string;
    revisionKey: string;
    stateExpiry: number;
    revisionExpiry: number;
    expectedJson: string;
    state: TaskStateData;
}

/** Commits the state and its durable revision in one Redis CAS operation. */
export async function compareAndSetTaskStateRecord(
    redis: Pick<InstanceType<typeof Redis>, 'eval'>,
    options: CompareAndSetTaskStateRecordOptions,
): Promise<number | null> {
    const result = await redis.eval(
        COMPARE_AND_SET_TASK_STATE_SCRIPT,
        2,
        options.stateKey,
        options.revisionKey,
        options.expectedJson,
        options.stateExpiry,
        options.revisionExpiry,
        JSON.stringify(options.state),
    );
    // Numeric results keep lightweight Redis mocks backwards compatible.
    if (!Array.isArray(result)) return Number(result) === 1 ? (options.state.version ?? 0) : null;
    return Number(result[0]) === 1 ? Number(result[1]) : null;
}

export async function deleteTaskStateIfAttempt(
    redis: Pick<InstanceType<typeof Redis>, 'eval'>,
    stateKey: string,
    token: string,
    version: number,
): Promise<boolean> {
    const deleted = await redis.eval(
        DELETE_TASK_STATE_IF_ATTEMPT_SCRIPT,
        1,
        stateKey,
        token,
        version,
    );
    return Number(deleted) === 1;
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
        attempt_generation_version: state.prProcessingLockToken
            ? state.version ?? 0
            : null,
    };
    try {
        const upsert = db('tasks').insert(taskData).onConflict('task_id').merge({
            correlation_id: taskData.correlation_id,
            initial_job_data: taskData.initial_job_data,
            attempt_generation: taskData.attempt_generation,
            attempt_generation_version: taskData.attempt_generation_version,
        });
        if (state.prProcessingLockToken) {
            const persisted = await upsert
                .where(query => query
                    .whereNull('attempt_generation_version')
                    .orWhere('attempt_generation_version', '<', taskData.attempt_generation_version))
                .returning('task_id');
            if (Array.isArray(persisted) && persisted.length === 0) {
                throw new Error(`A newer task generation is already persisted for taskId: ${taskId}`);
            }
        } else {
            await upsert;
        }
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
