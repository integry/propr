import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { db } from '../db/connection.js';
import { getStateManager } from '../utils/workerStateManager.js';
import { clearPendingPrQueueJob, trackPrQueueJob, TRACKED_PR_QUEUE_STATE_SET, type PrQueueIndexableQueue } from './prQueueJobIndex.js';
import { hasPullRequestMerged } from './prMergeState.js';
import { buildIssueRefFromQueueJob, getTaskIdFromQueueJob, type PrTaskJobData } from './prTaskIdentity.js';

const BENIGN_QUEUE_REMOVAL_FAILURE_STATES = new Set(['active', 'completed', 'failed', 'unknown']);
type LookupFailureBehavior = 'continue' | 'skip' | 'throw';

type QueueJobLike = {
  id?: string | number | null;
  name?: string;
  data: PrTaskJobData;
  remove: () => Promise<unknown>;
  getState: () => Promise<string>;
};

type LogLike = Pick<Logger, 'info' | 'warn'>;

interface PreparedMergedQueueJobCancellation {
  taskId: string;
  queueJobId: string;
  issueRef: NonNullable<ReturnType<typeof buildIssueRefFromQueueJob>>;
  correlationId: string | null;
  initialJobData: string;
  cancellation: {
    code: 'pull_request_merged';
    message: string;
  };
}

export async function shouldSkipEnqueueForMergedPullRequest(params: {
  redisClient: Redis;
  repository: string;
  prNumber: number;
  log: LogLike;
  mergedMessage: string;
  lookupFailureMessage: string;
  lookupFailureBehavior?: LookupFailureBehavior;
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
    if (lookupFailureBehavior === 'skip') {
      return true;
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
    log,
    removedMessage,
    removalFailureMessage,
    pendingIndexClearFailureMessage,
    trackFailureMessage,
  } = params;
  const taskIds = resolveMergedPrAbortTaskIds(queuedJob, jobId);
  let removalFailure: Error | null = null;
  let persistenceFailure: Error | null = null;
  let queueRemoved = false;
  let shouldClearPendingIndex = false;
  let preparedCancellation: PreparedMergedQueueJobCancellation | null = null;

  try {
    try {
      preparedCancellation = prepareMergedQueueJobCancellation({ queuedJob, repository, prNumber, jobId, log });
    } catch (error) {
      await setMergedPrAbortSignals(redisClient, taskIds, prNumber);
      throw error;
    }

    try {
      await queuedJob.remove();
      queueRemoved = true;
      shouldClearPendingIndex = true;
      log.info({ repository, prNumber, jobId }, removedMessage);
    } catch (error) {
      const queueState = await reloadQueueStateAfterRemovalFailure(queuedJob);
      await setMergedPrAbortSignals(redisClient, taskIds, prNumber);
      await trackQueueJobIfStillIndexed({
        queue,
        repository,
        prNumber,
        jobId,
        queueState,
        log,
        trackFailureMessage,
      });

      if (!isBenignRemovalFailureState(queueState)) {
        removalFailure = new Error(`${removalFailureMessage}: queue job remained ${queueState ?? 'unknown'} after removal failure`);
      }

      log.warn({
        repository,
        prNumber,
        jobId,
        queueState,
        error: (error as Error).message,
      }, removalFailureMessage);
    }

    if (queueRemoved && preparedCancellation) {
      try {
        await persistCancelledTaskRecordForMergedQueueJob(preparedCancellation);
      } catch (error) {
        persistenceFailure = error as Error;
        log.warn({
          repository,
          prNumber,
          jobId,
          taskId: preparedCancellation.taskId,
          error: (error as Error).message,
        }, 'Failed to persist merged PR cancellation state for removed queue job');
      }
    }
  } finally {
    if (shouldClearPendingIndex) {
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

  if (removalFailure) {
    throw removalFailure;
  }

  if (persistenceFailure) {
    throw persistenceFailure;
  }

  if (queueRemoved) {
    return;
  }
}

async function reloadQueueStateAfterRemovalFailure(queueJob: QueueJobLike): Promise<string | null> {
  try {
    return await queueJob.getState();
  } catch {
    return null;
  }
}

function isBenignRemovalFailureState(queueState: string | null): boolean {
  return queueState !== null && BENIGN_QUEUE_REMOVAL_FAILURE_STATES.has(queueState);
}

async function trackQueueJobIfStillIndexed(params: {
  queue: PrQueueIndexableQueue;
  repository: string;
  prNumber: number;
  jobId: string;
  queueState: string | null;
  log: LogLike;
  trackFailureMessage: string;
}): Promise<void> {
  const { queue, repository, prNumber, jobId, queueState, log, trackFailureMessage } = params;
  if (!queueState || !TRACKED_PR_QUEUE_STATE_SET.has(queueState)) {
    return;
  }

  try {
    await trackPrQueueJob(queue, repository, prNumber, jobId);
  } catch (error) {
    log.warn({
      repository,
      prNumber,
      jobId,
      error: (error as Error).message,
    }, trackFailureMessage);
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

function resolveMergedPrAbortTaskIds(queueJob: QueueJobLike, jobId: string): string[] {
  return [...new Set([
    jobId,
    queueJob.id === null || queueJob.id === undefined ? null : String(queueJob.id),
    getTaskIdFromQueueJob(queueJob),
  ].filter((taskId): taskId is string => Boolean(taskId)))];
}

function prepareMergedQueueJobCancellation(params: {
  queuedJob: QueueJobLike;
  repository: string;
  prNumber: number;
  jobId: string;
  log: LogLike;
}): PreparedMergedQueueJobCancellation {
  const { queuedJob, repository, prNumber, jobId, log } = params;
  const issueRef = buildIssueRefFromQueueJob(queuedJob);
  if (!issueRef) {
    log.warn({ repository, prNumber, jobId }, 'Failed to reconstruct merged PR queue job into a task record');
    throw new Error(`Failed to reconstruct merged PR queue job into a task record: ${jobId}`);
  }

  return {
    issueRef,
    taskId: getTaskIdFromQueueJob(queuedJob) ?? (queuedJob.id === null || queuedJob.id === undefined ? jobId : String(queuedJob.id)),
    queueJobId: queuedJob.id === null || queuedJob.id === undefined ? jobId : String(queuedJob.id),
    correlationId: typeof queuedJob.data.correlationId === 'string' ? queuedJob.data.correlationId : null,
    initialJobData: JSON.stringify(queuedJob.data),
    cancellation: {
      code: 'pull_request_merged',
      message: `Task cancelled because pull request #${prNumber} was merged.`,
    },
  };
}

async function persistCancelledTaskRecordForMergedQueueJob(params: PreparedMergedQueueJobCancellation): Promise<void> {
  const { issueRef, taskId, queueJobId, correlationId, initialJobData, cancellation } = params;
  const stateManager = getStateManager();

  const existingState = await stateManager.getTaskState(taskId);
  if (!existingState) {
    await stateManager.createTaskState(taskId, issueRef, correlationId);
  }

  await db('tasks')
    .where({ task_id: taskId })
    .update({
      job_id: queueJobId,
      pr_number: issueRef.pullRequestNumber,
      initial_job_data: initialJobData,
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
      jobId: queueJobId,
    },
  });
}
