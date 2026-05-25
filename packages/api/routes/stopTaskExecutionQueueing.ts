import type { Job } from 'bullmq';
import {
  logger,
  stopDockerContainer,
} from '@propr/core';
import type { RedisClientType } from 'redis';
import { pushStopConversationMessage } from './stopTaskExecutionPersistence.js';
import type { QueueJobData, StopTaskContext } from './stopTaskExecutionContext.js';
import type { StopTaskActivity } from './stopTaskExecutionGuards.js';
import { persistStopOutcome } from './stopTaskExecutionOutcome.js';

type RedisClientLike = Pick<RedisClientType, 'rPush' | 'set' | 'del'> & Partial<Pick<RedisClientType, 'lRange'>>;
type QueueRemovalRedisClient = Pick<RedisClientType, 'get' | 'set' | 'del'>;
type StopTaskCancellationReason = {
  code: string;
};

const TERMINAL_QUEUE_STATES = new Set(['completed', 'failed']);

export async function stopTaskContainer(params: {
  redisClient: RedisClientLike;
  taskId: string;
  containerId: string | null;
  shouldAbort: boolean;
  requestedBy: string;
  cancellation: StopTaskCancellationReason;
  containerStopTimeoutSeconds?: number;
  stopContainer?: typeof stopDockerContainer;
}): Promise<{ containerId: string | null; containerStopped: boolean }> {
  const {
    redisClient,
    taskId,
    containerId,
    shouldAbort,
    requestedBy,
    cancellation,
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
    metadata: { reasonCode: cancellation.code, requestedBy },
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
    if (isTerminalQueueRemovalRace(queueState)) {
      logger.warn({
        jobId: String(queueJob.id),
        queueState,
      }, 'Queue job reached a terminal state before queued cancellation was applied');
      return { jobRemoved: false, queueStateAfterFailure: queueState };
    }

    if (isBenignQueueRemovalRace(queueState)) {
      logger.warn({ jobId: String(queueJob.id), queueState }, 'Queue job changed state during removal; relying on abort signal');
      return { jobRemoved: false, queueStateAfterFailure: queueState };
    }
    throw error;
  }
}

export async function removeQueuedJobAfterStateCreation(params: {
  context: StopTaskContext;
  activity: StopTaskActivity;
  redisClient: QueueRemovalRedisClient;
}): Promise<{ jobRemoved: boolean; queueStateAfterFailure: string | null; persistedStopOutcomeDuringStop: boolean }> {
  const {
    context,
    activity,
    redisClient,
  } = params;
  let persistedStopOutcomeDuringStop = false;
  const removalResult = await removeQueueJobIfNeeded(context.queueJob, activity.isQueuePreStart);
  if (removalResult.jobRemoved) {
    persistedStopOutcomeDuringStop = await persistQueueRemovalOutcome(redisClient, context.abortTaskIds);
  }
  if (!removalResult.jobRemoved) {
    if (removalResult.queueStateAfterFailure === 'active') {
      logger.info({
        taskId: context.taskId,
        jobId: context.queueJob?.id ? String(context.queueJob.id) : null,
      }, 'Queued job became active after cancellation state was created; relying on worker abort signal');
    }
  }
  return {
    ...removalResult,
    persistedStopOutcomeDuringStop,
  };
}

export function isBenignQueueRemovalRace(queueState: string | null): boolean {
  return queueState === 'active';
}

function isTerminalQueueRemovalRace(queueState: string | null): boolean {
  return queueState !== null && TERMINAL_QUEUE_STATES.has(queueState);
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

async function persistQueueRemovalOutcome(
  redisClient: QueueRemovalRedisClient,
  taskIds: string[],
): Promise<boolean> {
  try {
    await persistStopOutcome(redisClient, taskIds, {
      containerId: null,
      containerStopped: false,
      jobRemoved: true,
    });
    return true;
  } catch (error) {
    logger.error({
      taskIds,
      error: (error as Error).message,
    }, 'Failed to persist queued removal stop outcome after removing queued job');
    return false;
  }
}
