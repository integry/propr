import type { RedisClientType } from 'redis';
import type { StopTaskCancellationReason, StopTaskExecutionResult } from './stopTaskExecution.js';
import type { StopTaskContext } from './stopTaskExecutionContext.js';
import {
  loadPendingStopRequest,
  type PendingStopRequest,
} from './stopTaskExecutionPersistence.js';

type RedisClientLike = Pick<RedisClientType, 'get' | 'del'>;

export async function loadFirstPendingStopRequest(
  redisClient: RedisClientLike,
  taskIds: string[],
): Promise<PendingStopRequest | null> {
  for (const taskId of taskIds) {
    const pendingStopRequest = await loadPendingStopRequest(redisClient, taskId);
    if (pendingStopRequest) {
      return pendingStopRequest;
    }
  }

  return null;
}

export function isSameCancellationRequest(
  pendingStopRequest: PendingStopRequest | null,
  cancellation: StopTaskCancellationReason,
): boolean {
  if (!pendingStopRequest) {
    return false;
  }

  if (pendingStopRequest.requestId || cancellation.requestId) {
    return pendingStopRequest.requestId === cancellation.requestId;
  }

  return pendingStopRequest.reasonCode === cancellation.code
    && pendingStopRequest.source === (cancellation.source ?? 'task_stop');
}

export function buildPendingStopResult(params: {
  context: StopTaskContext;
  cancellation: StopTaskCancellationReason;
  currentState: string | null;
  queueState: string | null;
}): StopTaskExecutionResult {
  const {
    context,
    cancellation,
    currentState,
    queueState,
  } = params;

  return {
    success: true,
    message: 'Stop request sent to worker. The execution will be terminated shortly.',
    taskId: context.taskId,
    containerStopped: false,
    jobRemoved: false,
    stopVerified: false,
    cancellationRequested: true,
    abortSignalArmed: true,
    currentState,
    queueState,
    cancellation,
  };
}
