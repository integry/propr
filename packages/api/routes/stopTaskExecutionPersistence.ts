import { getStateManager, logger } from '@propr/core';
import type { RedisClientType } from 'redis';
import type { StopTaskCancellationReason, StopTaskExecutionDeps } from './stopTaskExecution.js';

type RedisConversationClient = Pick<RedisClientType, 'rPush'>;

export async function pushStopConversationMessage(
  redisClient: RedisConversationClient,
  taskId: string,
  message: Record<string, unknown>,
): Promise<void> {
  await redisClient.rPush(`conversation:${taskId}`, JSON.stringify(message));
}

export async function persistTaskCancellation(params: {
  taskId: string;
  requestedBy: string;
  cancellation: StopTaskCancellationReason;
  queueState: string | null;
  containerId: string | null;
  containerStopped: boolean;
  jobRemoved: boolean;
  stopVerified: boolean;
  abortSignalArmed: boolean;
  deps: StopTaskExecutionDeps;
}): Promise<void> {
  const {
    taskId,
    requestedBy,
    cancellation,
    queueState,
    containerId,
    containerStopped,
    jobRemoved,
    stopVerified,
    abortSignalArmed,
    deps,
  } = params;
  const stateManager = (deps.getStateManager ?? getStateManager)();

  await stateManager.markTaskCancelled(taskId, requestedBy, {
    reason: cancellation.message,
    cancellation: {
      code: cancellation.code,
      message: cancellation.message,
      cancelledBy: requestedBy === 'system' ? 'system' : 'user',
      source: getCancellationSource(cancellation),
      containerStopped,
      jobRemoved,
      ...(containerId ? { containerId } : {}),
    },
    historyMetadata: {
      cancellation: {
        code: cancellation.code,
        message: cancellation.message,
      },
      requestedBy,
      containerStopped,
      jobRemoved,
      stopVerified,
      abortSignalArmed,
      ...(containerId ? { containerId } : {}),
      ...(queueState ? { queueState } : {}),
    },
  });
  logger.info({
    taskId,
    requestedBy,
    reasonCode: cancellation.code,
    queueState,
    containerId: containerId ?? null,
    containerStopped,
    jobRemoved,
    stopVerified,
    abortSignalArmed,
  }, 'Task marked as cancelled');
}

function getCancellationSource(cancellation: StopTaskCancellationReason): string {
  if (typeof cancellation.source === 'string' && cancellation.source.length > 0) {
    return cancellation.source;
  }

  if (cancellation.code === 'pull_request_merged') {
    return 'pull_request_merged';
  }

  return 'task_stop';
}
