import type { Redis } from 'ioredis';
import type {
    TaskState,
    TaskStateData,
    TaskStateExpectation,
    TaskStatePublicationResult,
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
        version: task.version,
    };
}

function matchesExpectation(task: TaskStateData, expectation: TaskStateExpectation): boolean {
    return task.state === expectation.state
        && task.createdAt === expectation.createdAt
        && task.updatedAt === expectation.updatedAt
        && task.correlationId === expectation.correlationId
        && (task.version ?? 0) === (expectation.version ?? 0);
}

function nextUpdatedAt(): string {
    return new Date().toISOString();
}

export function buildTaskStateMutation(
    current: TaskStateData,
    mutate: (state: TaskStateData, timestamp: string) => void,
): TaskStateData {
    const state = structuredClone(current);
    const timestamp = nextUpdatedAt();
    state.updatedAt = timestamp;
    state.version = (current.version ?? 0) + 1;
    mutate(state, timestamp);
    return state;
}

export function buildTaskStateTransition(
    current: TaskStateData,
    newState: TaskState,
    metadata: UpdateMetadata,
): TaskStateTransition {
    const previousState = current.state;
    const reason = metadata.reason ?? `State changed from ${previousState}`;
    const state = buildTaskStateMutation(current, (next, timestamp) => {
        next.state = newState;
        next.attempts = metadata.isRetry ? next.attempts + 1 : next.attempts;

        if (metadata.error) {
            next.lastError = {
                message: metadata.error.message,
                category: metadata.error.category ?? 'unknown',
                timestamp,
            };
        }
        if (metadata.worktreeInfo) next.worktreeInfo = metadata.worktreeInfo;
        if (metadata.claudeResult) next.claudeResult = { ...metadata.claudeResult };
        if (metadata.prResult) next.prResult = metadata.prResult;
        next.history.push({
            state: newState,
            timestamp,
            reason,
            metadata: metadata.historyMetadata ?? {},
        });
    });
    return { state, previousState, reason };
}

export async function compareAndSetTaskStateData(
    redis: Pick<InstanceType<typeof Redis>, 'eval'>,
    options: {
        key: string;
        stateExpiry: number;
        currentJson: string;
        state: TaskStateData;
    },
): Promise<boolean> {
    const updated = await redis.eval(
        COMPARE_AND_SET_TASK_STATE_SCRIPT,
        1,
        options.key,
        options.currentJson,
        options.stateExpiry,
        JSON.stringify(options.state),
    );
    return Number(updated) === 1;
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
    const updated = await compareAndSetTaskStateData(redis, {
        key: options.key,
        stateExpiry: options.stateExpiry,
        currentJson,
        state: transition.state,
    });
    return updated ? transition : null;
}

export async function publishTaskStateTransition(
    taskId: string,
    transition: TaskStateTransition,
    metadata: UpdateMetadata,
): Promise<TaskStatePublicationResult> {
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

    const publication: TaskStatePublicationResult = {
        historyPersisted: false,
        eventPublished: false,
        errors: [],
    };

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
        publication.historyPersisted = true;
        correlatedLogger.debug({ taskId, newState: state.state }, 'Task state update persisted to database');
    } catch (error) {
        publication.errors.push(`history: ${(error as Error).message}`);
        correlatedLogger.error({
            error: (error as Error).message,
            taskId,
            version: state.version,
        }, 'Failed to persist task state update to database');
    }

    try {
        publication.eventPublished = await getEventPublisher().publishTaskUpdate({
            taskId,
            state: state.state,
            previousState,
            repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
            issueNumber: state.issueRef.number,
            timestamp: state.updatedAt,
            metadata: { attempts: state.attempts, reason: metadata.reason },
        });
        if (!publication.eventPublished) publication.errors.push('event: publisher returned false');
    } catch (error) {
        publication.errors.push(`event: ${(error as Error).message}`);
        correlatedLogger.error({
            error: (error as Error).message,
            taskId,
            version: state.version,
        }, 'Failed to publish task state update event');
    }

    if (!publication.historyPersisted || !publication.eventPublished) {
        correlatedLogger.error({
            taskId,
            version: state.version,
            historyPersisted: publication.historyPersisted,
            eventPublished: publication.eventPublished,
            errors: publication.errors,
        }, 'Task state changed in Redis but publication was only partially successful');
    }
    return publication;
}
