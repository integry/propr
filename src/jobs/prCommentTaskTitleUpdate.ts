import { db, hashTaskAttemptToken, SupersededTaskAttemptError } from '@propr/core';
import type { CommentJobData, WorkerStateManager } from '@propr/core';
import type { Logger } from 'pino';

interface UpdateTaskTitleOptions {
    taskId: string;
    jobData: CommentJobData;
    stateManager: WorkerStateManager;
    correlatedLogger: Logger;
    linkedIssueNumber?: number | null;
    prProcessingLockToken?: string;
}

function sanitizeJobDataForPersistence(jobData: CommentJobData): CommentJobData {
    const persistedJobData = { ...jobData };
    delete persistedJobData.prProcessingLockToken;
    return persistedJobData;
}

export async function updateTaskTitleForPR(options: UpdateTaskTitleOptions): Promise<void> {
    const { taskId, jobData, stateManager, correlatedLogger, linkedIssueNumber, prProcessingLockToken } = options;
    if (prProcessingLockToken !== undefined) {
        const currentState = await stateManager.getTaskState(taskId);
        if (currentState?.prProcessingLockToken !== prProcessingLockToken) {
            throw new SupersededTaskAttemptError(taskId);
        }
    }

    const persistedJobData = sanitizeJobDataForPersistence(jobData);
    const jobDataWithIssue = linkedIssueNumber
        ? { ...persistedJobData, issueNumber: linkedIssueNumber }
        : persistedJobData;
    try {
        const query = db('tasks').where({ task_id: taskId });
        if (prProcessingLockToken !== undefined) {
            query.andWhere('attempt_generation', hashTaskAttemptToken(prProcessingLockToken));
        }
        const updatedRows = await query.update({ initial_job_data: JSON.stringify(jobDataWithIssue) });
        if (prProcessingLockToken !== undefined && updatedRows !== 1) {
            throw new SupersededTaskAttemptError(taskId);
        }
        correlatedLogger.info({ taskId, title: jobData.title, subtitle: jobData.subtitle, linkedIssueNumber }, 'Updated task with title/subtitle in DB');
    } catch (dbError) {
        if (dbError instanceof SupersededTaskAttemptError) throw dbError;
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
        if (redisError instanceof SupersededTaskAttemptError) throw redisError;
        correlatedLogger.warn({ taskId, error: (redisError as Error).message }, 'Failed to update task with title/subtitle in Redis');
    }
}
