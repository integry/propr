import type { Logger } from 'pino';
import type { WorkerStateManager } from '@gitfix/core';
import { TaskStates } from '@gitfix/core';
import fs from 'fs-extra';
import type { Redis } from 'ioredis';
import type { IssueJobData } from '@gitfix/core';

export interface SessionIdCallback {
    (sessionId: string, conversationId?: string): Promise<void>;
}

export interface ContainerIdCallback {
    (containerId: string, containerName: string): Promise<void>;
}

export interface SessionIdCallbackOptions {
    modelName: string;
    stateManager: WorkerStateManager;
    correlatedLogger: Logger;
    redisClient: InstanceType<typeof Redis>;
}

export function createSessionIdCallback(
    taskId: string,
    issueRef: IssueJobData,
    options: SessionIdCallbackOptions
): SessionIdCallback {
    const { modelName, stateManager, correlatedLogger, redisClient } = options;
    return async (sessionId: string, conversationId?: string): Promise<void> => {
        try {
            await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
                reason: 'Claude execution started',
                claudeResult: { success: false, sessionId, conversationId },
                historyMetadata: { sessionId, conversationId, model: modelName }
            });

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const logDir = '/tmp/claude-logs';
            await fs.ensureDir(logDir);

            const filePrefix = `issue-${issueRef.number}-${timestamp}`;
            const conversationPath = `${logDir}/${filePrefix}-conversation.json`;

            await fs.writeFile(conversationPath, JSON.stringify({
                sessionId, conversationId, timestamp: new Date().toISOString(),
                issueNumber: issueRef.number, repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
                messages: [], _streaming: true
            }, null, 2));

            const logData = {
                files: { conversation: conversationPath },
                issueNumber: issueRef.number,
                repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
                timestamp, sessionId, conversationId
            };

            if (sessionId) await redisClient.set(`execution:logs:session:${sessionId}`, JSON.stringify(logData), 'EX', 86400 * 30);
            if (conversationId) await redisClient.set(`execution:logs:conversation:${conversationId}`, JSON.stringify(logData), 'EX', 86400 * 30);
        } catch (error) {
            correlatedLogger.warn({ error: (error as Error).message, taskId, sessionId }, 'Failed to update task state with early sessionId');
        }
    };
}

export function createContainerIdCallback(
    taskId: string,
    stateManager: WorkerStateManager,
    correlatedLogger: Logger
): ContainerIdCallback {
    return async (containerId: string, containerName: string): Promise<void> => {
        try {
            await stateManager.updateHistoryMetadata(taskId, 'claude_execution', { containerId, containerName });
        } catch (err) {
            correlatedLogger.warn({ taskId, error: (err as Error).message }, 'Failed to update state with container info');
        }
    };
}
