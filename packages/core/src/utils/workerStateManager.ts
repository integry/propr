import { Redis } from 'ioredis';
import logger, { generateCorrelationId } from './logger.js';
import { db } from '../db/connection.js';
import type { Logger } from 'pino';
import {
    TaskStates, type TaskState, type IssueRef, type TaskStateData, type UpdateMetadata,
    type TaskResult, type ResumableTaskInfo, type WorkerStateManagerOptions
} from './workerStateManager.types.js';

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
        const state: TaskStateData = {
            taskId, issueRef, correlationId: correlationId ?? generateCorrelationId(),
            state: TaskStates.PENDING, createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(), attempts: 0,
            history: [{ state: TaskStates.PENDING, timestamp: new Date().toISOString(), reason: 'Task created' }]
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
        const stateJson = await this.redis.get(key);
        if (!stateJson) throw new Error(`Task state not found for taskId: ${taskId}`);

        const state: TaskStateData = JSON.parse(stateJson);
        const previousState = state.state;
        state.state = newState;
        state.updatedAt = new Date().toISOString();
        state.attempts = metadata.isRetry ? (state.attempts + 1) : state.attempts;

        if (metadata.error) {
            state.lastError = { message: metadata.error.message, category: metadata.error.category ?? 'unknown', timestamp: new Date().toISOString() };
        }
        if (metadata.worktreeInfo) state.worktreeInfo = metadata.worktreeInfo;
        if (metadata.claudeResult) {
            state.claudeResult = { success: metadata.claudeResult.success, sessionId: metadata.claudeResult.sessionId, executionTime: metadata.claudeResult.executionTime };
        }
        if (metadata.prResult) state.prResult = metadata.prResult;

        state.history.push({
            state: newState, timestamp: new Date().toISOString(),
            reason: metadata.reason ?? `State changed from ${previousState}`,
            metadata: metadata.historyMetadata ?? {}
        });
        await this.redis.setex(key, this.stateExpiry, JSON.stringify(state));

        const correlatedLogger: Logger = logger.withCorrelation(state.correlationId);
        correlatedLogger.info({
            taskId, issueNumber: state.issueRef.number,
            repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
            previousState, newState, attempts: state.attempts
        }, 'Task state updated');

        try {
            const historyData = {
                task_id: taskId, state: newState, timestamp: new Date().toISOString(),
                reason: metadata.reason ?? `State changed from ${previousState}`,
                metadata: JSON.stringify({
                    ...(metadata.historyMetadata ?? {}), previousState, attempts: state.attempts,
                    error: metadata.error, worktreeInfo: metadata.worktreeInfo,
                    claudeResult: metadata.claudeResult, prResult: metadata.prResult, commitHash: metadata.commitHash
                    })
                };
                await db('task_history').insert(historyData);
            correlatedLogger.debug({ taskId, newState }, 'Task state update persisted to database');
        } catch (error) {
            correlatedLogger.error({ error: (error as Error).message, taskId }, 'Failed to persist task state update to database');
        }
        return state;
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
        const stateJson = await this.redis.get(key);
        if (!stateJson) throw new Error(`Task state not found for taskId: ${taskId}`);

        const state: TaskStateData = JSON.parse(stateJson);
        const historyIndex = state.history.findLastIndex(h => h.state === historyState);

        if (historyIndex >= 0) {
            state.history[historyIndex].metadata = { ...state.history[historyIndex].metadata, ...metadata };
            state.updatedAt = new Date().toISOString();
            await this.redis.setex(key, this.stateExpiry, JSON.stringify(state));
            const correlatedLogger: Logger = logger.withCorrelation(state.correlationId);
            correlatedLogger.debug({ taskId, historyState, metadata }, 'Updated history metadata');
        } else {
            logger.warn({ taskId, historyState }, 'Could not find history entry to update metadata');
        }
        return state;
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
        try {
            // Remove all event listeners before closing
            this.redis.removeAllListeners();
            // Use disconnect() instead of quit() for more aggressive cleanup
            // disconnect() immediately closes the socket without waiting
            this.redis.disconnect();
        } catch {
            // Ignore disconnect errors
        }
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

/**
 * Check if state manager resources have been initialized. Useful for tests.
 */
export function hasStateManagerResources(): boolean {
    return stateManagerInstance !== null;
}

export async function closeStateManager(): Promise<void> {
    if (stateManagerInstance) {
        await stateManagerInstance.close();
        stateManagerInstance = null;
    }
}
