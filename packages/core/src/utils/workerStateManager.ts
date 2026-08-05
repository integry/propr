import { Redis } from 'ioredis';
import logger, { generateCorrelationId } from './logger.js';
import type { Logger } from 'pino';
import {
    TaskStates, type TaskState, type IssueRef, type TaskStateData, type UpdateMetadata,
    type TaskResult, type ResumableTaskInfo, type WorkerStateManagerOptions,
    type CreateTaskStateOptions, type NonTerminalTaskFilter, type TaskStateExpectation
} from './workerStateManager.types.js';
import { getEventPublisher } from './eventPublisher.js';
import { scanNonTerminalTaskStates } from './workerStateEnumeration.js';
import {
    ADMINISTRATIVE_TASK_ATTEMPT_OVERRIDE,
    assertTaskAttemptOwnership,
    SupersededTaskAttemptError,
    type TaskAttemptMutationAuthority,
} from './taskAttemptGeneration.js';
import {
    applyTaskStateUpdate,
    canTransitionTaskState,
    compareAndSetTaskStateRecord,
    createTaskStateRecord,
    deleteTaskStateIfAttempt,
    MAX_CAS_ATTEMPTS,
    persistTaskStateCreation,
    persistTaskStateUpdate,
    waitForCASRetry,
} from './workerStatePersistence.js';

export {
    ADMINISTRATIVE_TASK_ATTEMPT_OVERRIDE,
    TaskStates,
    SupersededTaskAttemptError,
    type TaskState,
    type IssueRef,
};

/**
 * Worker state manager for persistent task state tracking
 */
export class WorkerStateManager {
    private redis: InstanceType<typeof Redis>;
    private keyPrefix: string;
    private revisionKeyPrefix: string;
    private stateExpiry: number;
    private revisionExpiry: number;
    private nonTerminalScanCursors = new Map<string, string>();
    private persistenceTails = new Map<string, Promise<void>>();

    constructor(options: WorkerStateManagerOptions = {}) {
        this.redis = new Redis({
            host: process.env.REDIS_HOST ?? '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            ...options.redis
        });
        this.keyPrefix = options.keyPrefix ?? 'worker:state:';
        this.revisionKeyPrefix = options.revisionKeyPrefix ?? `revision:${this.keyPrefix}`;
        this.stateExpiry = options.stateExpiry ?? 7 * 24 * 3600;
        this.revisionExpiry = options.revisionExpiry ?? this.stateExpiry * 2;
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
    async createTaskState(
        taskId: string,
        issueRef: IssueRef,
        correlationId: string | null = null,
        options: CreateTaskStateOptions = {},
    ): Promise<TaskStateData> {
        if (Boolean(options.prProcessingLockToken) !== Boolean(options.prProcessingLockKey)) {
            throw new Error('PR task state creation requires both a processing lock token and key');
        }
        const state: TaskStateData = {
            taskId, issueRef, correlationId: correlationId ?? generateCorrelationId(),
            state: TaskStates.PENDING, createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(), version: 1, attempts: 0,
            history: [{ state: TaskStates.PENDING, timestamp: new Date().toISOString(), reason: 'Task created' }],
            ...(options.prProcessingLockToken
                ? { prProcessingLockToken: options.prProcessingLockToken }
                : {}),
        };
        const key = this.getTaskKey(taskId);
        const revisionKey = `${this.revisionKeyPrefix}${taskId}`;
        const createdVersion = await createTaskStateRecord(this.redis, {
            stateKey: key, revisionKey, stateExpiry: this.stateExpiry,
            revisionExpiry: this.revisionExpiry, state,
            ...options,
        });
        if (options.prProcessingLockToken && createdVersion < 1) {
            throw new Error(`PR processing attempt no longer owns its lease for taskId: ${taskId}`);
        }
        state.version = createdVersion;
        const correlatedLogger: Logger = logger.withCorrelation(state.correlationId);
        correlatedLogger.info({
            taskId, issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`, state: TaskStates.PENDING
        }, 'Task state created');

        try {
            await persistTaskStateCreation(state, { requireDatabase: options.prProcessingLockToken !== undefined });
        } catch (error) {
            if (options.prProcessingLockToken) {
                try {
                    await deleteTaskStateIfAttempt(
                        this.redis,
                        key,
                        options.prProcessingLockToken,
                        state.version,
                    );
                } catch (cleanupError) {
                    correlatedLogger.warn({
                        taskId,
                        error: (cleanupError as Error).message,
                    }, 'Failed to compensate fenced task state after SQL persistence failure');
                }
            }
            throw error;
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
    async updateTaskState(
        taskId: string,
        newState: TaskState,
        metadata: UpdateMetadata = {},
        expectedPrProcessingLockToken?: TaskAttemptMutationAuthority,
    ): Promise<TaskStateData> {
        const key = this.getTaskKey(taskId);
        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            const stateJson = await this.redis.get(key);
            if (!stateJson) throw new Error(`Task state not found for taskId: ${taskId}`);

            const state: TaskStateData = JSON.parse(stateJson);
            assertTaskAttemptOwnership(taskId, state.prProcessingLockToken, expectedPrProcessingLockToken);
            // Terminal state is monotonic. A retry is the sole intentional path
            // back into processing and must opt in explicitly.
            if (!canTransitionTaskState(state.state, newState, metadata)) return state;

            const previousState = state.state;
            applyTaskStateUpdate(state, newState, metadata);
            const updatedVersion = await compareAndSetTaskStateRecord(this.redis, {
                stateKey: key,
                revisionKey: `${this.revisionKeyPrefix}${taskId}`,
                stateExpiry: this.stateExpiry,
                revisionExpiry: this.revisionExpiry,
                expectedJson: stateJson,
                state,
            });
            if (updatedVersion === null) {
                await waitForCASRetry(attempt);
                continue;
            }
            state.version = updatedVersion;

            await this.enqueueTaskStatePersistence(
                taskId,
                () => persistTaskStateUpdate(taskId, state, { previousState, newState, metadata }),
            );
            return state;
        }
        throw new Error(`Task state update contention exceeded ${MAX_CAS_ATTEMPTS} attempts for taskId: ${taskId}`);
    }

    /**
     * Atomically updates a task only while it remains in the expected state.
     * A concurrent cancellation or processor transition makes this a no-op.
     */
    async updateTaskStateIfCurrent(
        taskId: string,
        expectation: TaskStateExpectation,
        newState: TaskState,
        metadata: UpdateMetadata = {},
    ): Promise<TaskStateData | null> {
        const key = this.getTaskKey(taskId);
        const stateJson = await this.redis.get(key);
        if (!stateJson) return null;

        const state: TaskStateData = JSON.parse(stateJson);
        if (state.state !== expectation.state) return null;
        if (expectation.updatedAt && state.updatedAt !== expectation.updatedAt) return null;
        if (expectation.version !== undefined && (state.version ?? 0) !== expectation.version) return null;
        if (expectation.prProcessingLockToken !== undefined
            && state.prProcessingLockToken !== expectation.prProcessingLockToken) return null;
        if (state.prProcessingLockToken !== undefined
            && expectation.prProcessingLockToken === undefined) return null;
        if (!canTransitionTaskState(state.state, newState, metadata)) return null;

        const previousState = state.state;
        applyTaskStateUpdate(state, newState, metadata);
        const updatedVersion = await compareAndSetTaskStateRecord(this.redis, {
            stateKey: key,
            revisionKey: `${this.revisionKeyPrefix}${taskId}`,
            stateExpiry: this.stateExpiry,
            revisionExpiry: this.revisionExpiry,
            expectedJson: stateJson,
            state,
        });
        if (updatedVersion === null) return null;
        state.version = updatedVersion;

        await this.enqueueTaskStatePersistence(
            taskId,
            () => persistTaskStateUpdate(taskId, state, { previousState, newState, metadata }),
        );
        return state;
    }

    private async enqueueTaskStatePersistence(taskId: string, operation: () => Promise<void>): Promise<void> {
        const previous = this.persistenceTails.get(taskId) ?? Promise.resolve();
        const current = previous.catch(() => undefined).then(operation);
        this.persistenceTails.set(taskId, current);
        try {
            await current;
        } finally {
            if (this.persistenceTails.get(taskId) === current) this.persistenceTails.delete(taskId);
        }
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
    async updateIssueRef(
        taskId: string,
        issueRefPatch: Partial<IssueRef>,
        expectedPrProcessingLockToken?: TaskAttemptMutationAuthority,
    ): Promise<TaskStateData | null> {
        const key = this.getTaskKey(taskId);
        let state: TaskStateData | null = null;
        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            const stateJson = await this.redis.get(key);
            if (!stateJson) return null;

            state = JSON.parse(stateJson) as TaskStateData;
            assertTaskAttemptOwnership(taskId, state.prProcessingLockToken, expectedPrProcessingLockToken);
            state.issueRef = { ...state.issueRef, ...issueRefPatch };
            state.updatedAt = new Date().toISOString();
            state.version = (state.version ?? 0) + 1;
            const updatedVersion = await compareAndSetTaskStateRecord(this.redis, {
                stateKey: key,
                revisionKey: `${this.revisionKeyPrefix}${taskId}`,
                stateExpiry: this.stateExpiry,
                revisionExpiry: this.revisionExpiry,
                expectedJson: stateJson,
                state,
            });
            if (updatedVersion !== null) {
                state.version = updatedVersion;
                break;
            }
            state = null;
            await waitForCASRetry(attempt);
        }
        if (!state) {
            throw new Error(`Task issue reference update contention exceeded ${MAX_CAS_ATTEMPTS} attempts for taskId: ${taskId}`);
        }

        const correlatedLogger: Logger = logger.withCorrelation(state.correlationId);
        correlatedLogger.info({
            taskId,
            issueNumber: state.issueRef.number,
            repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
            updatedFields: Object.keys(issueRefPatch)
        }, 'Task issue reference updated');

        try {
            const eventPublisher = getEventPublisher();
            await eventPublisher.publishTaskUpdate({
                taskId,
                state: state.state,
                repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
                issueNumber: state.issueRef.number,
                version: state.version,
                updatedAt: state.updatedAt,
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
    async updateHistoryMetadata(
        taskId: string,
        historyState: TaskState,
        metadata: Record<string, unknown> = {},
        expectedPrProcessingLockToken?: TaskAttemptMutationAuthority,
    ): Promise<TaskStateData> {
        const key = this.getTaskKey(taskId);
        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            const stateJson = await this.redis.get(key);
            if (!stateJson) throw new Error(`Task state not found for taskId: ${taskId}`);

            const state: TaskStateData = JSON.parse(stateJson);
            assertTaskAttemptOwnership(taskId, state.prProcessingLockToken, expectedPrProcessingLockToken);
            const historyIndex = state.history.findLastIndex(h => h.state === historyState);

            if (historyIndex < 0) {
                logger.warn({ taskId, historyState }, 'Could not find history entry to update metadata');
                return state;
            }
            state.history[historyIndex].metadata = { ...state.history[historyIndex].metadata, ...metadata };
            state.updatedAt = new Date().toISOString();
            state.version = (state.version ?? 0) + 1;
            const updatedVersion = await compareAndSetTaskStateRecord(this.redis, {
                stateKey: key,
                revisionKey: `${this.revisionKeyPrefix}${taskId}`,
                stateExpiry: this.stateExpiry,
                revisionExpiry: this.revisionExpiry,
                expectedJson: stateJson,
                state,
            });
            if (updatedVersion === null) {
                await waitForCASRetry(attempt);
                continue;
            }
            state.version = updatedVersion;
            const correlatedLogger: Logger = logger.withCorrelation(state.correlationId);
            correlatedLogger.debug({ taskId, historyState, metadata }, 'Updated history metadata');

            // Publish real-time event for metadata update so UI can refresh
            try {
                const eventPublisher = getEventPublisher();
                await eventPublisher.publishTaskUpdate({
                    taskId,
                    state: state.state,
                    repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
                    issueNumber: state.issueRef.number,
                    version: state.version,
                    updatedAt: state.updatedAt,
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
        throw new Error(`Task history metadata update contention exceeded ${MAX_CAS_ATTEMPTS} attempts for taskId: ${taskId}`);
    }

    /**
     * Marks task as failed
     * @param taskId - Task identifier
     * @param error - Error that caused failure
     * @param metadata - Additional metadata
     * @returns Updated state
     */
    async markTaskFailed(
        taskId: string,
        error: Error,
        metadata: UpdateMetadata = {},
        authority?: TaskAttemptMutationAuthority,
    ): Promise<TaskStateData> {
        const errorMetadata: UpdateMetadata = {
            ...metadata,
            error: { message: error.message, category: metadata.errorCategory ?? 'unknown' },
            reason: `Task failed: ${error.message}`
        };
        return await this.updateTaskState(taskId, TaskStates.FAILED, errorMetadata, authority);
    }

    /**
     * Marks task as cancelled (stopped by user request)
     * @param taskId - Task identifier
     * @param cancelledBy - Who/what cancelled the task (e.g., 'user', 'system', username)
     * @param metadata - Additional metadata
     * @returns Updated state
     */
    async markTaskCancelled(
        taskId: string,
        cancelledBy: string = 'user',
        metadata: UpdateMetadata = {},
        authority?: TaskAttemptMutationAuthority,
    ): Promise<TaskStateData> {
        const cancelMetadata: UpdateMetadata = {
            ...metadata,
            reason: metadata.reason ?? `Task cancelled by ${cancelledBy}`,
            historyMetadata: {
                ...(metadata.historyMetadata ?? {}),
                cancelledBy,
                cancelledAt: new Date().toISOString()
            }
        };
        return await this.updateTaskState(taskId, TaskStates.CANCELLED, cancelMetadata, authority);
    }

    /**
     * Marks task as completed
     * @param taskId - Task identifier
     * @param result - Task result
     * @returns Updated state
     */
    async markTaskCompleted(
        taskId: string,
        result: TaskResult = {},
        authority?: TaskAttemptMutationAuthority,
    ): Promise<TaskStateData> {
        const metadata: UpdateMetadata = {
            prResult: result, reason: 'Task completed successfully',
            historyMetadata: {
                pr: (result.prUrl && result.prNumber) ? { number: result.prNumber, url: result.prUrl } : null,
                commitResult: result.commitResult ?? null
            }
        };
        return await this.updateTaskState(taskId, TaskStates.COMPLETED, metadata, authority);
    }

    /**
     * Gets all tasks that have not reached a terminal state. Used by the worker
     * reconciler to repair state after an unclean restart.
     */
    async getNonTerminalTasks(filter: NonTerminalTaskFilter = {}): Promise<TaskStateData[]> {
        const cursorKey = filter.taskTypes?.length
            ? [...filter.taskTypes].sort().join(',')
            : '*';
        const result = await scanNonTerminalTaskStates(
            this.redis,
            this.keyPrefix,
            filter,
            this.nonTerminalScanCursors.get(cursorKey) ?? '0',
        );
        this.nonTerminalScanCursors.set(cursorKey, result.nextCursor);
        return result.tasks;
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
    async close(): Promise<void> { await this.redis.quit(); }
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
