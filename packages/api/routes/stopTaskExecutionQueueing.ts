import type { Job } from 'bullmq';
import {
  buildPrQueueJobContext,
  clearPendingPrQueueJob,
  clearTrackedPrQueueJob,
  getIssueQueue,
  logger,
  stopDockerContainer,
} from '@propr/core';
import type { RedisClientType } from 'redis';
import type { StopTaskExecutionDeps } from './stopTaskExecution.js';
import { pushStopConversationMessage } from './stopTaskExecutionPersistence.js';
import type { QueueJobData } from './stopTaskExecutionContext.js';

type RedisClientLike = Pick<RedisClientType, 'rPush'>;

const TERMINAL_QUEUE_STATES = new Set(['completed', 'failed']);

export async function stopTaskContainer(params: {
  redisClient: RedisClientLike;
  taskId: string;
  containerId: string | null;
  shouldAbort: boolean;
  containerStopTimeoutSeconds?: number;
  stopContainer?: typeof stopDockerContainer;
}): Promise<{ containerId: string | null; containerStopped: boolean }> {
  const {
    redisClient,
    taskId,
    containerId,
    shouldAbort,
    containerStopTimeoutSeconds = 10,
    stopContainer = stopDockerContainer,
  } = params;
  if (!containerId) {
    if (shouldAbort) {
      logger.info({ taskId }, 'No container ID found for task stop; relying on abort signal');
    }
    return { containerId: null, containerStopped: false };
  }

  logger.info({ taskId, containerId }, 'Stopping task container');
  const stopResult = await stopContainer(containerId, containerStopTimeoutSeconds);
  if (!stopResult.success) {
    logger.warn({ taskId, containerId, error: stopResult.error }, 'Failed to stop task container');
    return { containerId, containerStopped: false };
  }

  logger.info({ taskId, containerId }, 'Task container stopped successfully');
  await pushStopConversationMessage(redisClient, taskId, {
    type: 'system',
    timestamp: new Date().toISOString(),
    content: 'Docker container terminated.',
    level: 'info',
  });
  return { containerId, containerStopped: true };
}

export async function removeQueueJobIfNeeded(
  queueJob: Job<QueueJobData> | null,
  isQueuePreStart: boolean,
): Promise<{ jobRemoved: boolean; queueStateAfterFailure: string | null }> {
  if (!queueJob || !isQueuePreStart) {
    return { jobRemoved: false, queueStateAfterFailure: null };
  }

  try {
    await queueJob.remove();
    logger.info({ jobId: String(queueJob.id) }, 'Removed queued job before execution started');
    return { jobRemoved: true, queueStateAfterFailure: null };
  } catch (error) {
    const queueState = await reloadQueueStateAfterRemovalFailure(queueJob);
    if (isBenignQueueRemovalRace(queueState)) {
      logger.warn({ jobId: String(queueJob.id), queueState }, 'Queue job changed state during removal; relying on abort signal');
      return { jobRemoved: false, queueStateAfterFailure: queueState };
    }
    throw error;
  }
}

export async function clearPrQueueJobIndexEntriesIfNeeded(
  queueJob: Job<QueueJobData> | null,
  deps: StopTaskExecutionDeps,
): Promise<void> {
  const prJobContext = queueJob ? buildPrQueueJobContext(queueJob) : null;
  if (!prJobContext) {
    return;
  }

  try {
    const queue = await (deps.getIssueQueue ?? getIssueQueue)();
    await Promise.all([
      clearTrackedPrQueueJob(queue as never, prJobContext.repository, prJobContext.prNumber, prJobContext.jobId),
      clearPendingPrQueueJob(queue as never, prJobContext.repository, prJobContext.prNumber, prJobContext.jobId),
    ]);
  } catch (error) {
    logger.warn({
      repository: prJobContext.repository,
      prNumber: prJobContext.prNumber,
      jobId: prJobContext.jobId,
      error: (error as Error).message,
    }, 'Failed to clear PR queue-job index entries after queued task cancellation');
  }
}

export function isBenignQueueRemovalRace(queueState: string | null): boolean {
  return queueState === null
    || queueState === 'active'
    || queueState === 'unknown'
    || (queueState !== null && TERMINAL_QUEUE_STATES.has(queueState));
}

export function getStopTaskSuccessMessage(params: {
  jobRemoved: boolean;
  shouldAbort: boolean;
  containerStopped: boolean;
}): string {
  const { jobRemoved, shouldAbort, containerStopped } = params;
  if (jobRemoved) return 'Queued task cancelled before execution started.';
  if (shouldAbort) {
    return containerStopped
      ? 'Execution stopped. The Docker container has been terminated.'
      : 'Stop request sent to worker. The execution will be terminated shortly.';
  }
  return 'Task cancelled.';
}

async function reloadQueueStateAfterRemovalFailure(queueJob: Job<QueueJobData>): Promise<string | null> {
  try {
    return await queueJob.getState();
  } catch (error) {
    logger.warn({ jobId: String(queueJob.id), error: (error as Error).message }, 'Failed to reload queue state after removal failure');
    return null;
  }
}
