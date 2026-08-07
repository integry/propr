import type { Job, JobsOptions } from 'bullmq';
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
    const sourceJobId = job.id
        ?? `pr-comments-${job.data.repoOwner}-${job.data.repoName}-${job.data.pullRequestNumber}-${job.data.correlationId}`;
    const preservedOptions: JobsOptions = {
        jobId: `${sourceJobId}-lease-requeue`,
        delay,
        ...(job.opts.priority !== undefined && { priority: job.opts.priority }),
        ...(job.opts.attempts !== undefined && { attempts: job.opts.attempts }),
        ...(job.opts.backoff !== undefined && { backoff: job.opts.backoff }),
        ...(job.opts.lifo !== undefined && { lifo: job.opts.lifo }),
        ...(job.opts.removeOnComplete !== undefined && { removeOnComplete: job.opts.removeOnComplete }),
        ...(job.opts.removeOnFail !== undefined && { removeOnFail: job.opts.removeOnFail }),
        ...(job.opts.keepLogs !== undefined && { keepLogs: job.opts.keepLogs }),
        ...(job.opts.stackTraceLimit !== undefined && { stackTraceLimit: job.opts.stackTraceLimit }),
        ...(job.opts.sizeLimit !== undefined && { sizeLimit: job.opts.sizeLimit }),
    };
    await issueQueue.add(job.name, requeuedData, preservedOptions);
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
