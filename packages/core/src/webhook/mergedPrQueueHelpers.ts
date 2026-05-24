import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { clearPendingPrQueueJob, trackPrQueueJob, TRACKED_PR_QUEUE_STATE_SET, type PrQueueIndexableQueue } from './prQueueJobIndex.js';
import { hasPullRequestMerged } from './prMergeState.js';

type QueueJobLike = {
  remove: () => Promise<unknown>;
  getState: () => Promise<string>;
};

type LogLike = Pick<Logger, 'info' | 'warn'>;

export async function shouldSkipEnqueueForMergedPullRequest(params: {
  redisClient: Redis;
  repository: string;
  prNumber: number;
  log: LogLike;
  mergedMessage: string;
  lookupFailureMessage: string;
}): Promise<boolean> {
  const { redisClient, repository, prNumber, log, mergedMessage, lookupFailureMessage } = params;

  try {
    const merged = await hasPullRequestMerged(redisClient as never, repository, prNumber);
    if (merged) {
      log.info({ repository, prNumber }, mergedMessage);
    }
    return merged;
  } catch (error) {
    log.warn({
      repository,
      prNumber,
      error: (error as Error).message,
    }, lookupFailureMessage);
    return false;
  }
}

export async function discardFreshQueueJobAfterMerge(params: {
  queuedJob: QueueJobLike;
  queue: PrQueueIndexableQueue;
  redisClient: Redis;
  repository: string;
  prNumber: number;
  jobId: string;
  taskIds: string[];
  log: LogLike;
  removedMessage: string;
  removalFailureMessage: string;
  pendingIndexClearFailureMessage: string;
  trackFailureMessage: string;
}): Promise<void> {
  const {
    queuedJob,
    queue,
    redisClient,
    repository,
    prNumber,
    jobId,
    taskIds,
    log,
    removedMessage,
    removalFailureMessage,
    pendingIndexClearFailureMessage,
    trackFailureMessage,
  } = params;

  try {
    await queuedJob.remove();
    log.info({ repository, prNumber, jobId }, removedMessage);
    return;
  } catch (error) {
    const queueState = await reloadQueueStateAfterRemovalFailure(queuedJob);
    await setMergedPrAbortSignals(redisClient, taskIds, prNumber);

    if (queueState && TRACKED_PR_QUEUE_STATE_SET.has(queueState)) {
      try {
        await trackPrQueueJob(queue, repository, prNumber, jobId);
      } catch (trackError) {
        log.warn({
          repository,
          prNumber,
          jobId,
          error: (trackError as Error).message,
        }, trackFailureMessage);
      }
    }

    log.warn({
      repository,
      prNumber,
      jobId,
      queueState,
      error: (error as Error).message,
    }, removalFailureMessage);
  } finally {
    try {
      await clearPendingPrQueueJob(queue, repository, prNumber, jobId);
    } catch (error) {
      log.warn({
        repository,
        prNumber,
        jobId,
        error: (error as Error).message,
      }, pendingIndexClearFailureMessage);
    }
  }
}

async function reloadQueueStateAfterRemovalFailure(queueJob: QueueJobLike): Promise<string | null> {
  try {
    return await queueJob.getState();
  } catch {
    return null;
  }
}

async function setMergedPrAbortSignals(redisClient: Redis, taskIds: string[], prNumber: number): Promise<void> {
  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    reasonCode: 'pull_request_merged',
    reason: `Task cancelled because pull request #${prNumber} was merged.`,
  });

  for (const taskId of new Set(taskIds)) {
    await redisClient.set(`worker:abort:${taskId}`, payload, 'EX', 3600);
  }
}
