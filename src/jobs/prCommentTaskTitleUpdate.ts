import { db } from '@propr/core';
import type { CommentJobData, WorkerStateManager } from '@propr/core';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

interface UpdateTaskTitleOptions {
    taskId: string;
    jobData: CommentJobData;
    stateManager: WorkerStateManager;
    correlatedLogger: Logger;
    redisClient?: InstanceType<typeof Redis>;
    linkedIssueNumber?: number | null;
    prProcessingLockToken?: string;
}

export async function updateTaskTitleForPR(options: UpdateTaskTitleOptions): Promise<void> {
    const { taskId, jobData, stateManager, correlatedLogger, linkedIssueNumber, prProcessingLockToken } = options;
    if (prProcessingLockToken !== undefined) {
        const currentState = await stateManager.getTaskState(taskId);
        if (currentState?.prProcessingLockToken !== prProcessingLockToken) {
            correlatedLogger.info({ taskId }, 'Skipped task title update for a superseded PR attempt');
            return;
        }
    }

    const jobDataWithIssue = linkedIssueNumber
        ? { ...jobData, issueNumber: linkedIssueNumber }
        : jobData;
    try {
        await db('tasks').where({ task_id: taskId }).update({ initial_job_data: JSON.stringify(jobDataWithIssue) });
        correlatedLogger.info({ taskId, title: jobData.title, subtitle: jobData.subtitle, linkedIssueNumber }, 'Updated task with title/subtitle in DB');
    } catch (dbError) {
        correlatedLogger.warn({ taskId, error: (dbError as Error).message }, 'Failed to update task with title/subtitle in DB');
    }
    try {
        await stateManager.updateIssueRef(taskId, {
            number: jobData.pullRequestNumber,
            repoOwner: jobData.repoOwner,
            repoName: jobData.repoName,
            pullRequestNumber: jobData.pullRequestNumber,
            title: jobData.title,
            subtitle: jobData.subtitle,
            ...(linkedIssueNumber && { issueNumber: linkedIssueNumber }),
        }, prProcessingLockToken);
        correlatedLogger.info({ taskId, title: jobData.title, linkedIssueNumber }, 'Updated task with title/subtitle in Redis');
    } catch (redisError) {
        correlatedLogger.warn({ taskId, error: (redisError as Error).message }, 'Failed to update task with title/subtitle in Redis');
    }
}
