import { Redis } from 'ioredis';
import logger, { generateCorrelationId } from './logger.js';
import type { Logger } from 'pino';
import {
    TaskStates, type TaskState, type IssueRef, type TaskStateData, type UpdateMetadata,
    type TaskResult, type ResumableTaskInfo, type WorkerStateManagerOptions,
    type CreateTaskStateOptions, type NonTerminalTaskFilter, type NonTerminalTaskPage,
    type TaskStateExpectation
} from './workerStateManager.types.js';
import {
    cleanupOldTaskStates,
    getProcessingTaskStates,
    scanNonTerminalTaskStates,
} from './workerStateEnumeration.js';
import {
    publishHistoryMetadataUpdate,
    publishIssueRefUpdate,
} from './workerStateNotifications.js';
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
import { DEFAULT_WORKER_STATE_KEY_PREFIX } from './workerStateKeys.js';

export { DEFAULT_WORKER_STATE_KEY_PREFIX, getWorkerStateRedisKeys } from './workerStateKeys.js';

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
    private nonTerminalScanPositions = new Map<string, { cursor: string; pendingKeys: string[] }>();
    private persistenceTails = new Map<string, Promise<void>>();

    constructor(options: WorkerStateManagerOptions = {}) {
        this.redis = new Redis({
            host: process.env.REDIS_HOST ?? '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            ...options.redis
        });
        this.keyPrefix = options.keyPrefix ?? DEFAULT_WORKER_STATE_KEY_PREFIX;
        this.revisionKeyPrefix = options.revisionKeyPrefix ?? `revision:${this.keyPrefix}`;
        this.stateExpiry = options.stateExpiry ?? 7 * 24 * 3600;
        this.revisionExpiry = options.revisionExpiry ?? 30 * 24 * 3600;
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
            revisionExpiry: this.revisionExpiry,
            state,
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

        await publishIssueRefUpdate(state, issueRefPatch);
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
            await publishHistoryMetadataUpdate(state, historyState, metadata);
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
    async getNonTerminalTaskPage(filter: NonTerminalTaskFilter = {}): Promise<NonTerminalTaskPage> {
        const cursorKey = filter.taskTypes?.length
            ? [...filter.taskTypes].sort().join(',')
            : '*';
        const position = this.nonTerminalScanPositions.get(cursorKey);
        const result = await scanNonTerminalTaskStates(
            this.redis,
            this.keyPrefix,
            filter,
            position,
        );
        this.nonTerminalScanPositions.set(cursorKey, {
            cursor: result.nextCursor,
            pendingKeys: result.pendingKeys,
        });
        return {
            tasks: result.tasks,
            scanComplete: result.nextCursor === '0' && result.pendingKeys.length === 0,
        };
    }

    async getNonTerminalTasks(filter: NonTerminalTaskFilter = {}): Promise<TaskStateData[]> {
        return (await this.getNonTerminalTaskPage(filter)).tasks;
    }

    /**
     * Gets all tasks in processing states (for recovery)
     * @returns Array of processing tasks
     */
    async getProcessingTasks(): Promise<TaskStateData[]> {
        return await getProcessingTaskStates(this.redis, this.keyPrefix);
    }

    /**
     * Clears completed and failed tasks older than specified time
     * @param maxAge - Maximum age in seconds (default: 24 hours)
     * @returns Number of tasks cleaned up
     */
    async cleanupOldTasks(maxAge: number = 24 * 3600): Promise<number> {
        return await cleanupOldTaskStates(
            this.redis,
            this.keyPrefix,
            this.revisionKeyPrefix,
            maxAge,
        );
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
