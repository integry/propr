import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { issueQueue, type CommentJobData } from '@propr/core';
import type { Redis } from 'ioredis';
import { acquirePRProcessingLock } from './prProcessingLock.js';
import type { LockParams } from './prCommentProcessingTypes.js';

export async function requeuePRCommentJobWithoutLease(
    job: Job<CommentJobData>,
    delay: number,
): Promise<void> {
    const requeuedData = { ...job.data };
    delete requeuedData.prProcessingLockToken;
    await issueQueue.add(job.name, requeuedData, { delay });
}

export async function acquirePRCommentProcessingLock(
    redisClient: Redis,
    lockParams: LockParams,
): Promise<boolean> {
    const { lockKey, lockToken, correlatedLogger, job } = lockParams;
    if (await acquirePRProcessingLock(redisClient, lockKey, lockToken)) {
        correlatedLogger.debug({ lockKey }, 'PR lock acquired');
        return true;
    }
    correlatedLogger.info({ lockKey }, 'PR is currently being processed by another execution. Rescheduling...');
    await requeuePRCommentJobWithoutLease(job, 10000);
    return false;
}

export async function clearRetainedPRProcessingLockToken(
    job: Job<CommentJobData>,
    taskId: string,
    correlatedLogger: Logger,
): Promise<void> {
    delete job.data.prProcessingLockToken;
    try {
        await job.updateData({ ...job.data });
    } catch (error) {
        correlatedLogger.warn(
            { taskId, error: (error as Error).message },
            'Could not remove the completed PR lease token from retained job data',
        );
    }
}
