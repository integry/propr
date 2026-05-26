import type { RedisClientType } from 'redis';
import type {
  StopTaskCancellationReason,
  StopTaskExecutionDeps,
} from './stopTaskExecution.js';
import type { StopTaskContext } from './stopTaskExecutionContext.js';
import {
  clearPendingStopRequest,
  persistTaskCancellation,
  pushStopConversationMessage,
} from './stopTaskExecutionPersistence.js';
import {
  clearPersistedStopOutcome,
  persistStopOutcome,
} from './stopTaskExecutionOutcome.js';
import { shouldKeepAbortSignalsAfterCancellation } from './stopTaskExecutionGuards.js';
import { buildStopMessageMetadata } from './stopTaskExecutionMetadata.js';

type RedisClientLike = Pick<RedisClientType, 'get' | 'set' | 'del' | 'rPush' | 'lRange'>;

export async function finalizeStopCancellation(params: {
  redisClient: RedisClientLike;
  context: StopTaskContext;
  requestedBy: string;
  cancellation: StopTaskCancellationReason;
  resolvedQueueState: string | null;
  stopOutcome: {
    containerId: string | null;
    containerStopped: boolean;
    jobRemoved: boolean;
  };
  stopVerified: boolean;
  abortSignalArmed: boolean;
  hadPersistedStopOutcome: boolean;
  persistedStopOutcomeDuringStop: boolean;
  deps: StopTaskExecutionDeps;
}): Promise<void> {
  const {
    redisClient,
    context,
    requestedBy,
    cancellation,
    resolvedQueueState,
    stopOutcome,
    stopVerified,
    abortSignalArmed,
    hadPersistedStopOutcome,
    persistedStopOutcomeDuringStop,
    deps,
  } = params;
  await pushStopConversationMessage(redisClient, context.taskId, {
    type: 'system',
    timestamp: new Date().toISOString(),
    content: cancellation.message,
    level: 'warning',
    metadata: buildStopMessageMetadata(cancellation, requestedBy),
  });
  try {
    await persistTaskCancellation({
      taskId: context.taskId,
      requestedBy,
      cancellation,
      queueState: resolvedQueueState,
      containerId: stopOutcome.containerId,
      containerStopped: stopOutcome.containerStopped,
      jobRemoved: stopOutcome.jobRemoved,
      stopVerified,
      abortSignalArmed,
      deps,
    });
  } catch (error) {
    await persistStopOutcome(redisClient, context.abortTaskIds, stopOutcome);
    throw error;
  }
  await pushStopConversationMessage(redisClient, context.taskId, {
    type: 'system',
    timestamp: new Date().toISOString(),
    content: stopVerified
      ? 'Task cancelled successfully.'
      : 'Cancellation requested. Worker shutdown is still in progress.',
    level: stopVerified ? 'info' : 'warning',
    metadata: buildStopMessageMetadata(cancellation, requestedBy),
  });
  await clearFinalizedStopState({
    redisClient,
    taskIds: context.abortTaskIds,
    shouldAbort: abortSignalArmed,
    stopVerified,
    shouldClearPersistedStopOutcome: hadPersistedStopOutcome || persistedStopOutcomeDuringStop,
  });
}

export async function clearFinalizedStopState(params: {
  redisClient: RedisClientLike;
  taskIds: string[];
  shouldAbort: boolean;
  stopVerified: boolean;
  shouldClearPersistedStopOutcome: boolean;
}): Promise<void> {
  const {
    redisClient,
    taskIds,
    shouldAbort,
    stopVerified,
    shouldClearPersistedStopOutcome,
  } = params;
  const shouldRetainAbortSignals = shouldKeepAbortSignalsAfterCancellation({
    shouldAbort,
    stopVerified,
  });
  await clearPendingStopRequest(redisClient, taskIds);
  if (!shouldRetainAbortSignals) {
    await clearAbortSignals(redisClient, taskIds);
  }
  if (shouldClearPersistedStopOutcome) {
    await clearPersistedStopOutcome(redisClient, taskIds);
  }
}

async function clearAbortSignals(redisClient: RedisClientLike, taskIds: string[]): Promise<void> {
  for (const taskId of taskIds) {
    await redisClient.del(`worker:abort:${taskId}`);
  }
}
