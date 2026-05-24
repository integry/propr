import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { db } from '../db/connection.js';
import { getStateManager } from '../utils/workerStateManager.js';
import { clearPendingPrQueueJob, trackPrQueueJob, TRACKED_PR_QUEUE_STATE_SET, type PrQueueIndexableQueue } from './prQueueJobIndex.js';
import { hasPullRequestMerged } from './prMergeState.js';
import { buildIssueRefFromQueueJob, type PrTaskJobData } from './prTaskIdentity.js';

type QueueJobLike = {
  id?: string | number | null;
  name?: string;
  data: PrTaskJobData;
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
  lookupFailureBehavior?: 'continue' | 'throw';
}): Promise<boolean> {
  const {
    redisClient,
    repository,
    prNumber,
    log,
    mergedMessage,
    lookupFailureMessage,
    lookupFailureBehavior = 'throw',
  } = params;

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
    if (lookupFailureBehavior === 'continue') {
      return false;
    }
    throw error;
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
    await persistCancelledTaskRecordForMergedQueueJob({ queuedJob, repository, prNumber, jobId, log });
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

async function persistCancelledTaskRecordForMergedQueueJob(params: {
  queuedJob: QueueJobLike;
  repository: string;
  prNumber: number;
  jobId: string;
  log: LogLike;
}): Promise<void> {
  const { queuedJob, repository, prNumber, jobId, log } = params;
  const issueRef = buildIssueRefFromQueueJob(queuedJob);
  if (!issueRef) {
    log.warn({ repository, prNumber, jobId }, 'Failed to reconstruct merged PR queue job into a task record');
    return;
  }

  const taskId = queuedJob.id === null || queuedJob.id === undefined ? jobId : String(queuedJob.id);
  const stateManager = getStateManager();
  const cancellation = {
    code: 'pull_request_merged',
    message: `Task cancelled because pull request #${prNumber} was merged.`,
  };

  try {
    const existingState = await stateManager.getTaskState(taskId);
    if (!existingState) {
      const correlationId = typeof queuedJob.data.correlationId === 'string' ? queuedJob.data.correlationId : null;
      await stateManager.createTaskState(taskId, issueRef, correlationId);
    }

    await db('tasks')
      .where({ task_id: taskId })
      .update({
        job_id: taskId,
        pr_number: prNumber,
        initial_job_data: JSON.stringify(queuedJob.data),
      });

    await stateManager.markTaskCancelled(taskId, 'system', {
      reason: cancellation.message,
      cancellation: {
        code: cancellation.code,
        message: cancellation.message,
        cancelledBy: 'system',
        source: 'pull_request_merged',
        containerStopped: false,
      },
      historyMetadata: {
        cancellation: {
          code: cancellation.code,
          message: cancellation.message,
        },
        requestedBy: 'system',
        queueState: 'removed_before_start',
        jobId: taskId,
      },
    });
  } catch (error) {
    log.warn({
      repository,
      prNumber,
      jobId,
      taskId,
      error: (error as Error).message,
    }, 'Failed to persist merged PR cancellation state for removed queue job');
  }
}
