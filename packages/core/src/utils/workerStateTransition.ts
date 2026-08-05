import type { Redis } from 'ioredis';
import type {
    TaskState,
    TaskStateData,
    TaskStateExpectation,
    UpdateMetadata,
} from './workerStateManager.types.js';
import { db } from '../db/connection.js';
import { getEventPublisher } from './eventPublisher.js';
import logger from './logger.js';

const COMPARE_AND_SET_TASK_STATE_SCRIPT = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then
    return 0
end
redis.call('setex', KEYS[1], ARGV[2], ARGV[3])
return 1
`;

export interface TaskStateTransition {
    state: TaskStateData;
    previousState: TaskState;
    reason: string;
}

export function taskStateExpectation(task: TaskStateData): TaskStateExpectation {
    return {
        state: task.state,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        correlationId: task.correlationId,
    };
}

function matchesExpectation(task: TaskStateData, expectation: TaskStateExpectation): boolean {
    return task.state === expectation.state
        && task.createdAt === expectation.createdAt
        && task.updatedAt === expectation.updatedAt
        && task.correlationId === expectation.correlationId;
}

export function buildTaskStateTransition(
    current: TaskStateData,
    newState: TaskState,
    metadata: UpdateMetadata,
): TaskStateTransition {
    const now = new Date().toISOString();
    const state: TaskStateData = structuredClone(current);
    const previousState = state.state;
    const reason = metadata.reason ?? `State changed from ${previousState}`;
    state.state = newState;
    state.updatedAt = now;
    state.attempts = metadata.isRetry ? state.attempts + 1 : state.attempts;

    if (metadata.error) {
        state.lastError = {
            message: metadata.error.message,
            category: metadata.error.category ?? 'unknown',
            timestamp: now,
        };
    }
    if (metadata.worktreeInfo) state.worktreeInfo = metadata.worktreeInfo;
    if (metadata.claudeResult) state.claudeResult = { ...metadata.claudeResult };
    if (metadata.prResult) state.prResult = metadata.prResult;
    state.history.push({
        state: newState,
        timestamp: now,
        reason,
        metadata: metadata.historyMetadata ?? {},
    });
    return { state, previousState, reason };
}

export async function compareAndSetTaskState(
    redis: Pick<InstanceType<typeof Redis>, 'get' | 'eval'>,
    options: {
        key: string;
        stateExpiry: number;
        expectation: TaskStateExpectation;
        newState: TaskState;
        metadata: UpdateMetadata;
    },
): Promise<TaskStateTransition | null> {
    const currentJson = await redis.get(options.key);
    if (!currentJson) return null;
    const current = JSON.parse(currentJson) as TaskStateData;
    if (!matchesExpectation(current, options.expectation)) return null;

    const transition = buildTaskStateTransition(current, options.newState, options.metadata);
    const updated = await redis.eval(
        COMPARE_AND_SET_TASK_STATE_SCRIPT,
        1,
        options.key,
        currentJson,
        options.stateExpiry,
        JSON.stringify(transition.state),
    );
    return Number(updated) === 1 ? transition : null;
}

export async function publishTaskStateTransition(
    taskId: string,
    transition: TaskStateTransition,
    metadata: UpdateMetadata,
): Promise<void> {
    const { state, previousState, reason } = transition;
    const correlatedLogger = logger.withCorrelation(state.correlationId);
    correlatedLogger.info({
        taskId,
        issueNumber: state.issueRef.number,
        repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
        previousState,
        newState: state.state,
        attempts: state.attempts,
    }, 'Task state updated');

    try {
        await db('task_history').insert({
            task_id: taskId,
            state: state.state,
            timestamp: state.updatedAt,
            reason,
            metadata: JSON.stringify({
                ...(metadata.historyMetadata ?? {}),
                previousState,
                attempts: state.attempts,
                error: metadata.error,
                worktreeInfo: metadata.worktreeInfo,
                claudeResult: metadata.claudeResult,
                prResult: metadata.prResult,
                commitHash: metadata.commitHash,
            }),
        });
        correlatedLogger.debug({ taskId, newState: state.state }, 'Task state update persisted to database');

        await getEventPublisher().publishTaskUpdate({
            taskId,
            state: state.state,
            previousState,
            repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
            issueNumber: state.issueRef.number,
            metadata: { attempts: state.attempts, reason: metadata.reason },
        });
    } catch (error) {
        correlatedLogger.error({
            error: (error as Error).message,
            taskId,
        }, 'Failed to persist task state update to database');
    }
}
