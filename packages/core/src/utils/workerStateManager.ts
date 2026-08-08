import { Redis } from 'ioredis';
import logger, { generateCorrelationId } from './logger.js';
import { db } from '../db/connection.js';
import type { Logger } from 'pino';
import {
    TaskStates, type TaskState, type IssueRef, type TaskStateData, type UpdateMetadata,
    type TaskResult, type ResumableTaskInfo, type TaskStateExpectation,
    type NonTerminalTaskScanResult,
    type TaskStateUpdateResult,
    type WorkerStateManagerOptions
} from './workerStateManager.types.js';
import { getEventPublisher } from './eventPublisher.js';
import {
    buildTaskStateTransition,
    buildTaskStateMutation,
    compareAndSetTaskStateData,
    compareAndSetTaskState,
    publishTaskStateTransition,
} from './workerStateTransition.js';
import { scanNonTerminalTaskStates } from './workerStateScan.js';

const MAX_ATOMIC_UPDATE_ATTEMPTS = 8;
const TERMINAL_TASK_STATES = new Set<TaskState>([
    TaskStates.COMPLETED,
    TaskStates.FAILED,
    TaskStates.CANCELLED,
]);

async function waitForAtomicUpdateRetry(attempt: number): Promise<void> {
    const delayMs = Math.min(5 * (2 ** attempt), 100);
    await new Promise(resolve => setTimeout(resolve, delayMs));
}

export { TaskStates, type TaskState, type IssueRef };

/**
 * Worker state manager for persistent task state tracking
 */
export class WorkerStateManager {
    private redis: InstanceType<typeof Redis>;
    private keyPrefix: string;
    private stateExpiry: number;

    constructor(options: WorkerStateManagerOptions = {}) {
        this.redis = new Redis({
            host: process.env.REDIS_HOST ?? '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            ...options.redis
        });
        this.keyPrefix = options.keyPrefix ?? 'worker:state:';
        this.stateExpiry = options.stateExpiry ?? 7 * 24 * 3600;
        this.redis.on('error', (error: Error) => {
            logger.error({ error: error.message }, 'Redis error in WorkerStateManager');
        });
    }

    /**
     * Creates a task state entry
     * @param taskId - Unique task identifier
     * @param issueRef - GitHub issue reference
     * @param correlationId - Correlation ID for tracking
     * @returns Task state data
     */
    async createTaskState(taskId: string, issueRef: IssueRef, correlationId: string | null = null): Promise<TaskStateData> {
        const timestamp = new Date().toISOString();
        const state: TaskStateData = {
            taskId, issueRef, correlationId: correlationId ?? generateCorrelationId(),
            state: TaskStates.PENDING, createdAt: timestamp,
            updatedAt: timestamp, version: 1, attempts: 0,
            history: [{ state: TaskStates.PENDING, timestamp, reason: 'Task created' }]
        };
        const key = this.getTaskKey(taskId);
        await this.redis.setex(key, this.stateExpiry, JSON.stringify(state));
        const correlatedLogger: Logger = logger.withCorrelation(state.correlationId);
        correlatedLogger.info({
            taskId, issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`, state: TaskStates.PENDING
        }, 'Task state created');

        try {
            // Validate repository name components before storing
            const repoOwner = issueRef.repoOwner ?? 'unknown';
            const repoName = issueRef.repoName ?? 'unknown';
            const repository = `${repoOwner}/${repoName}`;
            const taskData = {
                task_id: taskId, job_id: null, correlation_id: state.correlationId,
                repository,
                issue_number: issueRef.number, task_type: issueRef.type ?? 'issue',
                model_name: issueRef.modelName ?? null, created_at: state.createdAt,
                initial_job_data: JSON.stringify(issueRef)
            };
            await db('tasks').insert(taskData).onConflict('task_id').ignore();
            const historyData = {
                task_id: taskId, state: TaskStates.PENDING,
                timestamp: state.createdAt, reason: 'Task created', metadata: JSON.stringify({})
            };
            await db('task_history').insert(historyData);
            correlatedLogger.debug({ taskId }, 'Task state persisted to database');

            // Publish real-time event for task creation
            const eventPublisher = getEventPublisher();
            await eventPublisher.publishTaskUpdate({
                taskId,
                state: TaskStates.PENDING,
                repository,
                issueNumber: issueRef.number,
                timestamp: state.updatedAt,
                version: state.version,
            });
        } catch (error) {
            correlatedLogger.error({ error: (error as Error).message, taskId }, 'Failed to persist task state to database');
        }
        return state;
    }

    /**
     * Updates task state
     * @param taskId - Task identifier
     * @param newState - New state
     * @param metadata - Additional metadata
     * @returns Updated state
     */
    async updateTaskState(taskId: string, newState: TaskState, metadata: UpdateMetadata = {}): Promise<TaskStateData> {
        const key = this.getTaskKey(taskId);
        for (let attempt = 0; attempt < MAX_ATOMIC_UPDATE_ATTEMPTS; attempt++) {
            const stateJson = await this.redis.get(key);
            if (!stateJson) throw new Error(`Task state not found for taskId: ${taskId}`);

            const current = JSON.parse(stateJson) as TaskStateData;
            const isExplicitFailedRetry = current.state === TaskStates.FAILED
                && newState === TaskStates.PROCESSING
                && metadata.isRetry === true;
            if (TERMINAL_TASK_STATES.has(current.state)
                && current.state !== newState
                && !isExplicitFailedRetry) {
                logger.warn({ taskId, currentState: current.state, requestedState: newState },
                    'Ignored state transition from a terminal task');
                return current;
            }

            const transition = buildTaskStateTransition(current, newState, metadata);
            const updated = await compareAndSetTaskStateData(this.redis, {
                key,
                stateExpiry: this.stateExpiry,
                currentJson: stateJson,
                state: transition.state,
            });
            if (updated) {
                await publishTaskStateTransition(taskId, transition, metadata);
                return transition.state;
            }
            await waitForAtomicUpdateRetry(attempt);
        }
        throw new Error(`Task state update conflicted ${MAX_ATOMIC_UPDATE_ATTEMPTS} times for taskId: ${taskId}`);
    }

    /**
     * Updates task state only if it has not changed since it was read.
     * @returns Updated state, or null when the expectation no longer matches
     */
    async updateTaskStateIfCurrent(
        taskId: string,
        expectation: TaskStateExpectation,
        newState: TaskState,
        metadata: UpdateMetadata = {},
    ): Promise<TaskStateData | null> {
        const result = await this.updateTaskStateIfCurrentDetailed(
            taskId,
            expectation,
            newState,
            metadata,
        );
        return result?.state ?? null;
    }

    /**
     * Conditional state update with explicit database/event publication status.
     */
    async updateTaskStateIfCurrentDetailed(
        taskId: string,
        expectation: TaskStateExpectation,
        newState: TaskState,
        metadata: UpdateMetadata = {},
    ): Promise<TaskStateUpdateResult | null> {
        const transition = await compareAndSetTaskState(this.redis, {
            key: this.getTaskKey(taskId),
            stateExpiry: this.stateExpiry,
            expectation,
            newState,
            metadata,
        });
        if (!transition) return null;
        const publication = await publishTaskStateTransition(taskId, transition, metadata);
        return { state: transition.state, publication };
    }

    /**
     * Gets task state
     * @param taskId - Task identifier
     * @returns Task state or null if not found
     */
    async getTaskState(taskId: string): Promise<TaskStateData | null> {
        const key = this.getTaskKey(taskId);
        const stateJson = await this.redis.get(key);
        if (!stateJson) return null;
        return JSON.parse(stateJson) as TaskStateData;
    }

    /**
     * Updates issue reference metadata without changing the task state.
     * @param taskId - Task identifier
     * @param issueRefPatch - Issue reference fields to merge
     * @returns Updated state, or null if no state exists
     */
    async updateIssueRef(taskId: string, issueRefPatch: Partial<IssueRef>): Promise<TaskStateData | null> {
        const key = this.getTaskKey(taskId);
        for (let attempt = 0; attempt < MAX_ATOMIC_UPDATE_ATTEMPTS; attempt++) {
            const stateJson = await this.redis.get(key);
            if (!stateJson) return null;

            const current = JSON.parse(stateJson) as TaskStateData;
            const state = buildTaskStateMutation(current, next => {
                next.issueRef = { ...next.issueRef, ...issueRefPatch };
            });
            const updated = await compareAndSetTaskStateData(this.redis, {
                key,
                stateExpiry: this.stateExpiry,
                currentJson: stateJson,
                state,
            });
            if (!updated) {
                await waitForAtomicUpdateRetry(attempt);
                continue;
            }

            const correlatedLogger: Logger = logger.withCorrelation(state.correlationId);
            correlatedLogger.info({
                taskId,
                issueNumber: state.issueRef.number,
                repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
                updatedFields: Object.keys(issueRefPatch),
                version: state.version,
            }, 'Task issue reference updated');

            try {
                await getEventPublisher().publishTaskUpdate({
                    taskId,
                    state: state.state,
                    repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
                    issueNumber: state.issueRef.number,
                    timestamp: state.updatedAt,
                    version: state.version,
                    metadata: {
                        issueRefUpdated: true,
                        updatedFields: Object.keys(issueRefPatch)
                    }
                });
            } catch (error) {
                correlatedLogger.warn({ error: (error as Error).message, taskId }, 'Failed to publish issue reference update event');
            }
            return state;
        }
        throw new Error(`Task issue reference update conflicted ${MAX_ATOMIC_UPDATE_ATTEMPTS} times for taskId: ${taskId}`);
    }

    /**
     * Checks if task can be resumed after worker restart
     * @param taskId - Task identifier
     * @returns Resumable task info or null
     */
    async getResumableTask(taskId: string): Promise<ResumableTaskInfo | null> {
        const state = await this.getTaskState(taskId);
        if (!state) return null;

        const resumableStates: TaskState[] = [TaskStates.PROCESSING, TaskStates.CLAUDE_EXECUTION, TaskStates.POST_PROCESSING];
        if (!resumableStates.includes(state.state)) return null;

        const staleThreshold = 30 * 60 * 1000;
        const updatedAt = new Date(state.updatedAt).getTime();
        const now = Date.now();

        if (now - updatedAt > staleThreshold) {
            logger.warn({
                taskId, correlationId: state.correlationId, issueNumber: state.issueRef.number,
                state: state.state, lastUpdate: state.updatedAt, staleDuration: now - updatedAt
            }, 'Found stale task that may need recovery');
            return { ...state, isStale: true, staleDuration: now - updatedAt };
        }
        return { ...state, isStale: false };
    }

    /**
     * Updates metadata for a specific history entry
     * @param taskId - Task identifier
     * @param historyState - State name to find in history
     * @param metadata - Metadata to merge
     * @returns Updated state
     */
    async updateHistoryMetadata(taskId: string, historyState: TaskState, metadata: Record<string, unknown> = {}): Promise<TaskStateData> {
        const key = this.getTaskKey(taskId);
        for (let attempt = 0; attempt < MAX_ATOMIC_UPDATE_ATTEMPTS; attempt++) {
            const stateJson = await this.redis.get(key);
            if (!stateJson) throw new Error(`Task state not found for taskId: ${taskId}`);

            const current = JSON.parse(stateJson) as TaskStateData;
            const historyIndex = current.history.findLastIndex(h => h.state === historyState);
            if (historyIndex < 0) {
                logger.warn({ taskId, historyState }, 'Could not find history entry to update metadata');
                return current;
            }

            const state = buildTaskStateMutation(current, next => {
                next.history[historyIndex].metadata = {
                    ...next.history[historyIndex].metadata,
                    ...metadata,
                };
            });
            const updated = await compareAndSetTaskStateData(this.redis, {
                key,
                stateExpiry: this.stateExpiry,
                currentJson: stateJson,
                state,
            });
            if (!updated) {
                await waitForAtomicUpdateRetry(attempt);
                continue;
            }

            const correlatedLogger: Logger = logger.withCorrelation(state.correlationId);
            correlatedLogger.debug({ taskId, historyState, metadata, version: state.version }, 'Updated history metadata');

            // Publish real-time event for metadata update so UI can refresh
            try {
                await getEventPublisher().publishTaskUpdate({
                    taskId,
                    state: state.state,
                    repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
                    issueNumber: state.issueRef.number,
                    timestamp: state.updatedAt,
                    version: state.version,
                    metadata: {
                        metadataUpdate: true,
                        updatedFields: Object.keys(metadata)
                    }
                });
            } catch (error) {
                correlatedLogger.warn({ error: (error as Error).message, taskId }, 'Failed to publish metadata update event');
            }
            return state;
        }
        throw new Error(`Task history metadata update conflicted ${MAX_ATOMIC_UPDATE_ATTEMPTS} times for taskId: ${taskId}`);
    }

    /**
     * Marks task as failed
     * @param taskId - Task identifier
     * @param error - Error that caused failure
     * @param metadata - Additional metadata
     * @returns Updated state
     */
    async markTaskFailed(taskId: string, error: Error, metadata: UpdateMetadata = {}): Promise<TaskStateData> {
        const errorMetadata: UpdateMetadata = {
            ...metadata,
            error: { message: error.message, category: metadata.errorCategory ?? 'unknown' },
            reason: `Task failed: ${error.message}`
        };
        return await this.updateTaskState(taskId, TaskStates.FAILED, errorMetadata);
    }

    /**
     * Marks task as cancelled (stopped by user request)
     * @param taskId - Task identifier
     * @param cancelledBy - Who/what cancelled the task (e.g., 'user', 'system', username)
     * @param metadata - Additional metadata
     * @returns Updated state
     */
    async markTaskCancelled(taskId: string, cancelledBy: string = 'user', metadata: UpdateMetadata = {}): Promise<TaskStateData> {
        const cancelMetadata: UpdateMetadata = {
            ...metadata,
            reason: metadata.reason ?? `Task cancelled by ${cancelledBy}`,
            historyMetadata: {
                ...(metadata.historyMetadata ?? {}),
                cancelledBy,
                cancelledAt: new Date().toISOString()
            }
        };
        return await this.updateTaskState(taskId, TaskStates.CANCELLED, cancelMetadata);
    }

    /**
     * Marks task as completed
     * @param taskId - Task identifier
     * @param result - Task result
     * @returns Updated state
     */
    async markTaskCompleted(taskId: string, result: TaskResult = {}): Promise<TaskStateData> {
        const metadata: UpdateMetadata = {
            prResult: result, reason: 'Task completed successfully',
            historyMetadata: {
                pr: (result.prUrl && result.prNumber) ? { number: result.prNumber, url: result.prUrl } : null,
                commitResult: result.commitResult ?? null
            }
        };
        return await this.updateTaskState(taskId, TaskStates.COMPLETED, metadata);
    }

    /**
     * Gets all tasks in processing states (for recovery)
     * @returns Array of processing tasks
     */
    async getProcessingTasks(): Promise<TaskStateData[]> {
        const pattern = `${this.keyPrefix}*`;
        const keys = await this.redis.keys(pattern);
        const processingTasks: TaskStateData[] = [];

        for (const key of keys) {
            try {
                const stateJson = await this.redis.get(key);
                if (!stateJson) continue;
                const state: TaskStateData = JSON.parse(stateJson);
                const processingStates: TaskState[] = [TaskStates.PROCESSING, TaskStates.CLAUDE_EXECUTION, TaskStates.POST_PROCESSING];
                if (processingStates.includes(state.state)) processingTasks.push(state);
            } catch (error) {
                logger.warn({ key, error: (error as Error).message }, 'Failed to parse task state during recovery scan');
            }
        }
        return processingTasks;
    }

    /**
     * Reads one bounded Redis SCAN page for crash recovery without blocking
     * Redis with KEYS. Callers retain nextCursor between reconciliation runs.
     */
    async scanNonTerminalTasks(cursor = '0', count = 100): Promise<NonTerminalTaskScanResult> {
        return scanNonTerminalTaskStates(this.redis, this.keyPrefix, cursor, count);
    }

    /**
     * Clears completed and failed tasks older than specified time
     * @param maxAge - Maximum age in seconds (default: 24 hours)
     * @returns Number of tasks cleaned up
     */
    async cleanupOldTasks(maxAge: number = 24 * 3600): Promise<number> {
        const pattern = `${this.keyPrefix}*`;
        const keys = await this.redis.keys(pattern);
        let cleanedCount = 0;
        const cutoffTime = Date.now() - (maxAge * 1000);

        for (const key of keys) {
            try {
                const stateJson = await this.redis.get(key);
                if (!stateJson) continue;
                const state: TaskStateData = JSON.parse(stateJson);
                const cleanupStates: TaskState[] = [TaskStates.COMPLETED, TaskStates.FAILED, TaskStates.CANCELLED];
                if (cleanupStates.includes(state.state)) {
                    const updatedAt = new Date(state.updatedAt).getTime();
                    if (updatedAt < cutoffTime) {
                        await this.redis.del(key);
                        cleanedCount++;
                        logger.debug({ taskId: state.taskId, state: state.state, age: Date.now() - updatedAt }, 'Cleaned up old task state');
                    }
                }
            } catch (error) {
                logger.warn({ key, error: (error as Error).message }, 'Failed to cleanup task state');
            }
        }
        logger.info({ cleanedCount, totalKeys: keys.length, maxAge }, 'Task state cleanup completed');
        return cleanedCount;
    }

    /**
     * Generates task key
     * @param taskId - Task identifier
     * @returns Redis key
     */
    getTaskKey(taskId: string): string {
        return `${this.keyPrefix}${taskId}`;
    }

    /**
     * Closes Redis connection
     */
    async close(): Promise<void> {
        this.redis.disconnect();
    }
}

/**
 * Creates a singleton instance of WorkerStateManager
 */
let stateManagerInstance: WorkerStateManager | null = null;

export function getStateManager(options: WorkerStateManagerOptions = {}): WorkerStateManager {
    if (!stateManagerInstance) stateManagerInstance = new WorkerStateManager(options);
    return stateManagerInstance;
}

export async function closeStateManager(): Promise<void> {
    if (stateManagerInstance) {
        await stateManagerInstance.close();
        stateManagerInstance = null;
    }
}
