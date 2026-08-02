/* eslint-disable max-lines -- Redis state, durable history, and publication form one transition lifecycle */
import { Redis } from 'ioredis';
import logger, { generateCorrelationId } from './logger.js';
import { db } from '../db/connection.js';
import type { Logger } from 'pino';
import {
    TaskStates, type TaskState, type IssueRef, type TaskStateData, type UpdateMetadata,
    type TaskResult, type ResumableTaskInfo, type WorkerStateManagerOptions
} from './workerStateManager.types.js';
import { getEventPublisher } from './eventPublisher.js';

export { TaskStates, type TaskState, type IssueRef };

function buildPublishedTaskMetadata(
    issueNumber: number,
    attempts: number,
    metadata: UpdateMetadata,
    transitionSequence?: number
): Record<string, unknown> {
    const commandMode = typeof metadata.historyMetadata?.commandMode === 'string'
        ? metadata.historyMetadata.commandMode
        : undefined;
    const prNumber = typeof metadata.prResult?.prNumber === 'number'
        ? metadata.prResult.prNumber
        : commandMode === 'review' ? issueNumber : undefined;
    const prUrl = typeof metadata.prResult?.prUrl === 'string'
        ? metadata.prResult.prUrl
        : undefined;
    return {
        attempts,
        reason: metadata.reason,
        ...(commandMode === undefined ? {} : { commandMode }),
        ...(prNumber === undefined ? {} : { prNumber }),
        ...(prUrl === undefined ? {} : { prUrl }),
        ...(transitionSequence === undefined ? {} : { transitionSequence })
    };
}

function insertedSequence(value: unknown): number | undefined {
    const first = Array.isArray(value) ? value[0] : undefined;
    const candidate = typeof first === 'object' && first !== null
        ? (first as Record<string, unknown>).history_id
        : first;
    return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0
        ? candidate
        : undefined;
}

function parseMetadataRecord(value: unknown): Record<string, unknown> {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    if (typeof value !== 'string') return {};
    try {
        const parsed: unknown = JSON.parse(value);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
}

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
        const transitionAt = new Date().toISOString();
        const state: TaskStateData = {
            taskId, issueRef, correlationId: correlationId ?? generateCorrelationId(),
            state: TaskStates.PENDING, createdAt: transitionAt,
            updatedAt: transitionAt, attempts: 0,
            history: [{ state: TaskStates.PENDING, timestamp: transitionAt, reason: 'Task created' }]
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
            const insertedHistory = await db('task_history').insert(historyData);
            const transitionSequence = insertedSequence(insertedHistory);
            correlatedLogger.debug({ taskId }, 'Task state persisted to database');

            // Publish real-time event for task creation
            const eventPublisher = getEventPublisher();
            await eventPublisher.publishTaskUpdate({
                taskId,
                state: TaskStates.PENDING,
                repository,
                issueNumber: issueRef.number,
                metadata: transitionSequence === undefined ? undefined : { transitionSequence },
                timestamp: transitionAt
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
        const stateJson = await this.redis.get(key);
        if (!stateJson) throw new Error(`Task state not found for taskId: ${taskId}`);

        const state: TaskStateData = JSON.parse(stateJson);
        const previousState = state.state;
        const transitionAt = new Date().toISOString();
        state.state = newState;
        state.updatedAt = transitionAt;
        state.attempts = metadata.isRetry ? (state.attempts + 1) : state.attempts;

        if (metadata.error) {
            state.lastError = { message: metadata.error.message, category: metadata.error.category ?? 'unknown', timestamp: transitionAt };
        }
        if (metadata.worktreeInfo) state.worktreeInfo = metadata.worktreeInfo;
        if (metadata.claudeResult) {
            state.claudeResult = { success: metadata.claudeResult.success, sessionId: metadata.claudeResult.sessionId, executionTime: metadata.claudeResult.executionTime };
        }
        if (metadata.prResult) state.prResult = metadata.prResult;

        state.history.push({
            state: newState, timestamp: transitionAt,
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
                task_id: taskId, state: newState, timestamp: transitionAt,
                reason: metadata.reason ?? `State changed from ${previousState}`,
                metadata: JSON.stringify({
                    ...(metadata.historyMetadata ?? {}), previousState, attempts: state.attempts,
                    error: metadata.error, worktreeInfo: metadata.worktreeInfo,
                    claudeResult: metadata.claudeResult, prResult: metadata.prResult, commitHash: metadata.commitHash
                })
            };
            const insertedHistory = await db('task_history').insert(historyData);
            const transitionSequence = insertedSequence(insertedHistory);
            correlatedLogger.debug({ taskId, newState }, 'Task state update persisted to database');

            // Publish real-time event for task state change
            const eventPublisher = getEventPublisher();
            await eventPublisher.publishTaskUpdate({
                taskId,
                state: newState,
                previousState,
                repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
                issueNumber: state.issueRef.number,
                metadata: buildPublishedTaskMetadata(
                    state.issueRef.number,
                    state.attempts,
                    metadata,
                    transitionSequence
                ),
                timestamp: transitionAt
            });
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
     * Updates issue reference metadata without changing the task state.
     * @param taskId - Task identifier
     * @param issueRefPatch - Issue reference fields to merge
     * @returns Updated state, or null if no state exists
     */
    async updateIssueRef(taskId: string, issueRefPatch: Partial<IssueRef>): Promise<TaskStateData | null> {
        const key = this.getTaskKey(taskId);
        const stateJson = await this.redis.get(key);
        if (!stateJson) return null;

        const state: TaskStateData = JSON.parse(stateJson);
        const transitionAt = state.history.findLast(entry => entry.state === state.state)?.timestamp
            ?? state.updatedAt;
        state.issueRef = { ...state.issueRef, ...issueRefPatch };
        state.updatedAt = new Date().toISOString();
        await this.redis.setex(key, this.stateExpiry, JSON.stringify(state));

        const correlatedLogger: Logger = logger.withCorrelation(state.correlationId);
        correlatedLogger.info({
            taskId,
            issueNumber: state.issueRef.number,
            repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
            updatedFields: Object.keys(issueRefPatch)
        }, 'Task issue reference updated');

        try {
            const taskRow = await db('tasks')
                .select('initial_job_data')
                .where({ task_id: taskId })
                .first() as { initial_job_data?: unknown } | undefined;
            const initialJobData = {
                ...parseMetadataRecord(taskRow?.initial_job_data),
                ...state.issueRef
            };
            const durablePrNumber = typeof state.issueRef.pullRequestNumber === 'number'
                ? state.issueRef.pullRequestNumber
                : typeof state.issueRef.prNumber === 'number' ? state.issueRef.prNumber : undefined;
            const taskUpdate: Record<string, unknown> = {
                initial_job_data: JSON.stringify(initialJobData),
                repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
                issue_number: state.issueRef.number
            };
            if ('pullRequestNumber' in issueRefPatch || 'prNumber' in issueRefPatch) {
                taskUpdate.pr_number = durablePrNumber ?? null;
            }
            await db('tasks')
                .where({ task_id: taskId })
                .update(taskUpdate);
            const historyRow = await db('task_history')
                .select('history_id')
                .where({ task_id: taskId, state: state.state, timestamp: transitionAt })
                .orderBy('history_id', 'desc')
                .first() as { history_id?: number } | undefined;
            const eventPublisher = getEventPublisher();
            await eventPublisher.publishTaskUpdate({
                taskId,
                state: state.state,
                repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
                issueNumber: state.issueRef.number,
                metadata: {
                    issueRefUpdated: true,
                    updatedFields: Object.keys(issueRefPatch),
                    transitionAt,
                    ...(historyRow?.history_id === undefined
                        ? {}
                        : { transitionSequence: historyRow.history_id }),
                    ...(typeof initialJobData.commandMode === 'string'
                        ? { commandMode: initialJobData.commandMode }
                        : {}),
                    ...(durablePrNumber === undefined ? {} : { prNumber: durablePrNumber }),
                    ...(typeof state.issueRef.prUrl === 'string'
                        ? { prUrl: state.issueRef.prUrl }
                        : {})
                }
            });
        } catch (error) {
            correlatedLogger.warn({ error: (error as Error).message, taskId }, 'Failed to publish issue reference update event');
        }

        return state;
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
            const transitionAt = state.history[historyIndex].timestamp;
            state.history[historyIndex].metadata = { ...state.history[historyIndex].metadata, ...metadata };
            state.updatedAt = new Date().toISOString();
            await this.redis.setex(key, this.stateExpiry, JSON.stringify(state));
            const correlatedLogger: Logger = logger.withCorrelation(state.correlationId);
            correlatedLogger.debug({ taskId, historyState, metadata }, 'Updated history metadata');

            // Publish real-time event for metadata update so UI can refresh
            try {
                const historyRow = await db('task_history')
                    .select('history_id', 'metadata')
                    .where({ task_id: taskId, state: historyState, timestamp: transitionAt })
                    .orderBy('history_id', 'desc')
                    .first() as { history_id?: number; metadata?: unknown } | undefined;
                const durableMetadata = {
                    ...parseMetadataRecord(historyRow?.metadata),
                    ...(state.history[historyIndex].metadata ?? {})
                };
                if (historyRow?.history_id !== undefined) {
                    await db('task_history')
                        .where({ history_id: historyRow.history_id })
                        .update({ metadata: JSON.stringify(durableMetadata) });
                }
                const prResult = parseMetadataRecord(durableMetadata.prResult);
                const pr = parseMetadataRecord(durableMetadata.pr);
                const prNumber = typeof prResult.prNumber === 'number'
                    ? prResult.prNumber
                    : typeof pr.number === 'number' ? pr.number : undefined;
                const prUrl = typeof prResult.prUrl === 'string'
                    ? prResult.prUrl
                    : typeof pr.url === 'string' ? pr.url : undefined;
                const eventPublisher = getEventPublisher();
                await eventPublisher.publishTaskUpdate({
                    taskId,
                    state: state.state,
                    repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
                    issueNumber: state.issueRef.number,
                    metadata: {
                        metadataUpdate: true,
                        updatedFields: Object.keys(metadata),
                        transitionAt,
                        ...(historyRow?.history_id === undefined
                            ? {}
                            : { transitionSequence: historyRow.history_id }),
                        ...(typeof durableMetadata.commandMode === 'string'
                            ? { commandMode: durableMetadata.commandMode }
                            : {}),
                        ...(prNumber === undefined ? {} : { prNumber }),
                        ...(prUrl === undefined ? {} : { prUrl })
                    }
                });
            } catch (error) {
                correlatedLogger.warn({ error: (error as Error).message, taskId }, 'Failed to publish metadata update event');
            }
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
        await this.redis.quit();
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
