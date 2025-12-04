import Redis from 'ioredis';
import logger, { generateCorrelationId } from './logger.js';
import { db, isEnabled as isDbEnabled } from '../db/postgres.js';

/**
 * Worker task states
 */
export const TaskStates = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    CLAUDE_EXECUTION: 'claude_execution',
    POST_PROCESSING: 'post_processing',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled'
};

/**
 * Worker state manager for persistent task state tracking
 */
export class WorkerStateManager {
    constructor(options = {}) {
        this.redis = new Redis({
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            ...options.redis
        });
        
        this.keyPrefix = options.keyPrefix || 'worker:state:';
        this.stateExpiry = options.stateExpiry || 7 * 24 * 3600; // 7 days
        
        this.redis.on('error', (error) => {
            logger.error({ error: error.message }, 'Redis error in WorkerStateManager');
        });
    }

    /**
     * Creates a task state entry
     * @param {string} taskId - Unique task identifier
     * @param {object} issueRef - GitHub issue reference
     * @param {string} correlationId - Correlation ID for tracking
     * @returns {Promise<void>}
     */
    async createTaskState(taskId, issueRef, correlationId = null) {
        const state = {
            taskId,
            issueRef,
            correlationId: correlationId || generateCorrelationId(),
            state: TaskStates.PENDING,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            attempts: 0,
            history: [{
                state: TaskStates.PENDING,
                timestamp: new Date().toISOString(),
                reason: 'Task created'
            }]
        };

        const key = this.getTaskKey(taskId);
        await this.redis.setex(key, this.stateExpiry, JSON.stringify(state));
        
        const correlatedLogger = logger.withCorrelation(state.correlationId);
        correlatedLogger.info({
            taskId,
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            state: TaskStates.PENDING
        }, 'Task state created');
        
        if (isDbEnabled && db) {
            try {
                const taskData = {
                    task_id: taskId,
                    job_id: null,
                    correlation_id: state.correlationId,
                    repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
                    issue_number: issueRef.number,
                    task_type: issueRef.type || 'issue',
                    model_name: issueRef.modelName || null,
                    created_at: state.createdAt,
                    initial_job_data: JSON.stringify(issueRef)
                };
                
                await db('tasks').insert(taskData).onConflict('task_id').ignore();
                
                const historyData = {
                    task_id: taskId,
                    state: TaskStates.PENDING,
                    timestamp: state.createdAt,
                    reason: 'Task created',
                    metadata: JSON.stringify({})
                };
                
                await db('task_history').insert(historyData);
                
                correlatedLogger.debug({ taskId }, 'Task state persisted to database');
            } catch (error) {
                correlatedLogger.error({
                    error: error.message,
                    taskId
                }, 'Failed to persist task state to database');
            }
        }
        
        return state;
    }

    /**
     * Updates task state
     * @param {string} taskId - Task identifier
     * @param {string} newState - New state
     * @param {object} metadata - Additional metadata
     * @returns {Promise<object>} Updated state
     */
    async updateTaskState(taskId, newState, metadata = {}) {
        const key = this.getTaskKey(taskId);
        const stateJson = await this.redis.get(key);
        
        if (!stateJson) {
            throw new Error(`Task state not found for taskId: ${taskId}`);
        }
        
        const state = JSON.parse(stateJson);
        const previousState = state.state;
        
        state.state = newState;
        state.updatedAt = new Date().toISOString();
        state.attempts = metadata.isRetry ? (state.attempts + 1) : state.attempts;
        
        // Add metadata
        if (metadata.error) {
            state.lastError = {
                message: metadata.error.message,
                category: metadata.error.category,
                timestamp: new Date().toISOString()
            };
        }
        
        if (metadata.worktreeInfo) {
            state.worktreeInfo = metadata.worktreeInfo;
        }
        
        if (metadata.claudeResult) {
            state.claudeResult = {
                success: metadata.claudeResult.success,
                sessionId: metadata.claudeResult.sessionId,
                executionTime: metadata.claudeResult.executionTime
            };
        }
        
        if (metadata.prResult) {
            state.prResult = metadata.prResult;
        }
        
        // Add to history
        state.history.push({
            state: newState,
            timestamp: new Date().toISOString(),
            reason: metadata.reason || `State changed from ${previousState}`,
            metadata: metadata.historyMetadata || {}
        });
        
        await this.redis.setex(key, this.stateExpiry, JSON.stringify(state));
        
        const correlatedLogger = logger.withCorrelation(state.correlationId);
        correlatedLogger.info({
            taskId,
            issueNumber: state.issueRef.number,
            repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
            previousState,
            newState,
            attempts: state.attempts
        }, 'Task state updated');
        
        if (isDbEnabled && db) {
            try {
                const historyData = {
                    task_id: taskId,
                    state: newState,
                    timestamp: new Date().toISOString(),
                    reason: metadata.reason || `State changed from ${previousState}`,
                    metadata: JSON.stringify({
                        ...(metadata.historyMetadata || {}),
                        previousState,
                        attempts: state.attempts,
                        error: metadata.error,
                        worktreeInfo: metadata.worktreeInfo,
                        claudeResult: metadata.claudeResult,
                        prResult: metadata.prResult,
                        commitHash: metadata.commitHash
                    })
                };
                
                await db('task_history').insert(historyData);
                
                correlatedLogger.debug({ taskId, newState }, 'Task state update persisted to database');
            } catch (error) {
                correlatedLogger.error({
                    error: error.message,
                    taskId
                }, 'Failed to persist task state update to database');
            }
        }
        
        return state;
    }

    /**
     * Gets task state
     * @param {string} taskId - Task identifier
     * @returns {Promise<object|null>} Task state or null if not found
     */
    async getTaskState(taskId) {
        const key = this.getTaskKey(taskId);
        const stateJson = await this.redis.get(key);
        
        if (!stateJson) {
            return null;
        }
        
        return JSON.parse(stateJson);
    }

    /**
     * Checks if task can be resumed after worker restart
     * @param {string} taskId - Task identifier
     * @returns {Promise<object|null>} Resumable task info or null
     */
    async getResumableTask(taskId) {
        const state = await this.getTaskState(taskId);
        
        if (!state) {
            return null;
        }
        
        // Tasks in these states can potentially be resumed
        const resumableStates = [
            TaskStates.PROCESSING,
            TaskStates.CLAUDE_EXECUTION,
            TaskStates.POST_PROCESSING
        ];
        
        if (!resumableStates.includes(state.state)) {
            return null;
        }
        
        // Check if task is stale (stuck for too long)
        const staleThreshold = 30 * 60 * 1000; // 30 minutes
        const updatedAt = new Date(state.updatedAt).getTime();
        const now = Date.now();
        
        if (now - updatedAt > staleThreshold) {
            logger.warn({
                taskId,
                correlationId: state.correlationId,
                issueNumber: state.issueRef.number,
                state: state.state,
                lastUpdate: state.updatedAt,
                staleDuration: now - updatedAt
            }, 'Found stale task that may need recovery');
            
            return {
                ...state,
                isStale: true,
                staleDuration: now - updatedAt
            };
        }
        
        return {
            ...state,
            isStale: false
        };
    }

    /**
     * Updates metadata for a specific history entry
     * @param {string} taskId - Task identifier
     * @param {string} historyState - State name to find in history
     * @param {object} metadata - Metadata to merge
     * @returns {Promise<object>} Updated state
     */
    async updateHistoryMetadata(taskId, historyState, metadata = {}) {
        const key = this.getTaskKey(taskId);
        const stateJson = await this.redis.get(key);
        
        if (!stateJson) {
            throw new Error(`Task state not found for taskId: ${taskId}`);
        }
        
        const state = JSON.parse(stateJson);
        
        // Find the history entry with the specified state (most recent one)
        const historyIndex = state.history.findLastIndex(h => h.state === historyState);
        
        if (historyIndex >= 0) {
            // Merge new metadata with existing metadata
            state.history[historyIndex].metadata = {
                ...state.history[historyIndex].metadata,
                ...metadata
            };
            
            state.updatedAt = new Date().toISOString();
            await this.redis.setex(key, this.stateExpiry, JSON.stringify(state));
            
            const correlatedLogger = logger.withCorrelation(state.correlationId);
            correlatedLogger.debug({
                taskId,
                historyState,
                metadata
            }, 'Updated history metadata');
        } else {
            logger.warn({
                taskId,
                historyState
            }, 'Could not find history entry to update metadata');
        }
        
        return state;
    }

    /**
     * Marks task as failed
     * @param {string} taskId - Task identifier
     * @param {Error} error - Error that caused failure
     * @param {object} metadata - Additional metadata
     * @returns {Promise<object>} Updated state
     */
    async markTaskFailed(taskId, error, metadata = {}) {
        const errorMetadata = {
            ...metadata,
            error: {
                message: error.message,
                category: metadata.errorCategory || 'unknown',
                stack: error.stack,
                code: error.code,
                status: error.status
            },
            reason: `Task failed: ${error.message}`
        };
        
        return await this.updateTaskState(taskId, TaskStates.FAILED, errorMetadata);
    }

    /**
     * Marks task as completed
     * @param {string} taskId - Task identifier
     * @param {object} result - Task result
     * @returns {Promise<object>} Updated state
     */
    async markTaskCompleted(taskId, result = {}) {
        const metadata = {
            result,
            reason: 'Task completed successfully',
            historyMetadata: {
                pr: (result.prUrl && result.prNumber) ? {
                    number: result.prNumber,
                    url: result.prUrl
                } : null,
                commitResult: result.commitResult || null
            }
        };
        
        return await this.updateTaskState(taskId, TaskStates.COMPLETED, metadata);
    }

    /**
     * Gets all tasks in processing states (for recovery)
     * @returns {Promise<Array>} Array of processing tasks
     */
    async getProcessingTasks() {
        const pattern = `${this.keyPrefix}*`;
        const keys = await this.redis.keys(pattern);
        
        const processingTasks = [];
        
        for (const key of keys) {
            try {
                const stateJson = await this.redis.get(key);
                if (!stateJson) continue;
                
                const state = JSON.parse(stateJson);
                const processingStates = [
                    TaskStates.PROCESSING,
                    TaskStates.CLAUDE_EXECUTION,
                    TaskStates.POST_PROCESSING
                ];
                
                if (processingStates.includes(state.state)) {
                    processingTasks.push(state);
                }
            } catch (error) {
                logger.warn({
                    key,
                    error: error.message
                }, 'Failed to parse task state during recovery scan');
            }
        }
        
        return processingTasks;
    }

    /**
     * Clears completed and failed tasks older than specified time
     * @param {number} maxAge - Maximum age in seconds (default: 24 hours)
     * @returns {Promise<number>} Number of tasks cleaned up
     */
    async cleanupOldTasks(maxAge = 24 * 3600) {
        const pattern = `${this.keyPrefix}*`;
        const keys = await this.redis.keys(pattern);
        
        let cleanedCount = 0;
        const cutoffTime = Date.now() - (maxAge * 1000);
        
        for (const key of keys) {
            try {
                const stateJson = await this.redis.get(key);
                if (!stateJson) continue;
                
                const state = JSON.parse(stateJson);
                const cleanupStates = [TaskStates.COMPLETED, TaskStates.FAILED, TaskStates.CANCELLED];
                
                if (cleanupStates.includes(state.state)) {
                    const updatedAt = new Date(state.updatedAt).getTime();
                    
                    if (updatedAt < cutoffTime) {
                        await this.redis.del(key);
                        cleanedCount++;
                        
                        logger.debug({
                            taskId: state.taskId,
                            state: state.state,
                            age: Date.now() - updatedAt
                        }, 'Cleaned up old task state');
                    }
                }
            } catch (error) {
                logger.warn({
                    key,
                    error: error.message
                }, 'Failed to cleanup task state');
            }
        }
        
        logger.info({
            cleanedCount,
            totalKeys: keys.length,
            maxAge
        }, 'Task state cleanup completed');
        
        return cleanedCount;
    }

    /**
     * Generates task key
     * @param {string} taskId - Task identifier
     * @returns {string} Redis key
     */
    getTaskKey(taskId) {
        return `${this.keyPrefix}${taskId}`;
    }

    /**
     * Closes Redis connection
     * @returns {Promise<void>}
     */
    async close() {
        await this.redis.quit();
    }
}

/**
 * Creates a singleton instance of WorkerStateManager
 */
let stateManagerInstance = null;

export function getStateManager(options = {}) {
    if (!stateManagerInstance) {
        stateManagerInstance = new WorkerStateManager(options);
    }
    return stateManagerInstance;
}

export async function closeStateManager() {
    if (stateManagerInstance) {
        await stateManagerInstance.close();
        stateManagerInstance = null;
    }
}