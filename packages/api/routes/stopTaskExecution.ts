import { RedisClientType } from 'redis';
import {
  logger,
  stopDockerContainer,
} from '@propr/core';
import {
  ensureTaskStateForCancellation,
  loadStopTaskContext,
  type StopTaskContext,
} from './stopTaskExecutionContext.js';
import {
  assertStopApplied,
  assertTaskCanBeStopped,
  isStopVerified,
  shouldKeepAbortSignalsAfterCancellation,
} from './stopTaskExecutionGuards.js';
import {
  clearPendingStopRequest,
  persistPendingCancellationRequest,
  persistTaskCancellation,
  pushStopConversationMessage,
} from './stopTaskExecutionPersistence.js';
import {
  clearPersistedStopOutcome,
  loadPersistedStopOutcome,
  mergeStopOutcomes,
  persistStopOutcome,
  resolveCancellationQueueState,
  hasConcreteStopOutcome,
} from './stopTaskExecutionOutcome.js';
import {
  getStopTaskSuccessMessage,
  stopTaskContainer,
} from './stopTaskExecutionQueueing.js';
import {
  ensureContextTaskStateAfterQueueRemoval,
  prepareContextForStop,
  refreshContextForStop,
  removeQueueJobAfterAbortIfNeeded,
} from './stopTaskExecutionPreparation.js';
import { StopTaskExecutionError } from './stopTaskExecutionErrors.js';
import { buildStopMessageMetadata } from './stopTaskExecutionMetadata.js';
export { isBenignQueueRemovalRace } from './stopTaskExecutionQueueing.js';
export { StopTaskExecutionError, isStopTaskExecutionError } from './stopTaskExecutionErrors.js';

export interface StopTaskCancellationReason {
  code: string;
  message: string;
  source?: string;
  requestId?: string;
}

type RedisClientLike = Pick<RedisClientType, 'get' | 'set' | 'del' | 'rPush' | 'lRange'>;

export interface StopTaskExecutionOptions {
  redisClient: RedisClientLike;
  requestedBy?: string;
  cancellation?: StopTaskCancellationReason;
  containerStopTimeoutSeconds?: number;
  forceQueueScan?: boolean;
  requireVerifiedStop?: boolean;
}

export interface StopTaskExecutionDeps {
  stopDockerContainer?: typeof stopDockerContainer;
  getStateManager?: typeof import('@propr/core').getStateManager;
  getIssueQueue?: typeof import('@propr/core').getIssueQueue;
  db?: typeof import('@propr/core').db;
  loadStopTaskContext?: typeof loadStopTaskContext;
  ensureTaskStateForCancellation?: typeof ensureTaskStateForCancellation;
}

export interface StopTaskExecutionResult {
  success: true;
  message: string;
  taskId: string;
  containerStopped: boolean;
  jobRemoved: boolean;
  /**
   * stopVerified means the container was stopped, queued job was removed, or no
   * async abort was needed. cancellationRequested means a worker abort request
   * was durably recorded but the worker may still look active briefly.
   */
  stopVerified: boolean;
  cancellationRequested: boolean;
  abortSignalArmed: boolean;
  currentState: string | null;
  queueState: string | null;
  cancellation: StopTaskCancellationReason;
}

const DEFAULT_STOP_REASON: StopTaskCancellationReason = {
  code: 'user_requested_stop',
  message: 'Task cancelled by user request.',
  source: 'task_stop',
};

export { loadPendingStopRequest, type PendingStopRequest } from './stopTaskExecutionPersistence.js';

export async function stopTaskExecution(
  taskReference: string,
  options: StopTaskExecutionOptions,
  deps: StopTaskExecutionDeps = {},
): Promise<StopTaskExecutionResult> {
  const {
    redisClient,
    requestedBy = 'user',
    cancellation = DEFAULT_STOP_REASON,
    containerStopTimeoutSeconds,
    forceQueueScan = false,
    requireVerifiedStop = false,
  } = options;
  let context = await (deps.loadStopTaskContext ?? loadStopTaskContext)(taskReference, redisClient, { ...deps, forceQueueScan });
  const persistedStopOutcome = await loadPersistedStopOutcome(redisClient, context.abortTaskIds);
  const hadPersistedStopOutcome = hasConcreteStopOutcome(persistedStopOutcome);
  const refreshedStopContext = await refreshContextForStop(context, deps);
  context = refreshedStopContext.context;
  const { trackedContainerId, activity, shouldAbort, queueRemovalShouldPrecedeAbort } = refreshedStopContext;
  assertTaskCanBeStopped({
    state: context.state,
    queueJob: context.queueJob,
    currentState: context.currentState,
    queueState: context.queueState,
    activity,
    persistedStopOutcome,
    createError: (status, body) => new StopTaskExecutionError(status, body),
  });

  const timestamp = new Date().toISOString();
  const preparedStop = await prepareContextForStop({
    context,
    redisClient,
    activity,
    shouldAbort,
    queueRemovalShouldPrecedeAbort,
  });
  context = preparedStop.context;
  await setAbortSignalIfNeeded({
    redisClient,
    taskIds: context.abortTaskIds,
    requestedBy,
    cancellation,
    timestamp,
    shouldAbort: preparedStop.abortSignalArmed,
  });
  const { containerId, containerStopped } = await stopTaskContainer({
    redisClient,
    taskId: context.taskId,
    containerId: trackedContainerId,
    shouldAbort: preparedStop.abortSignalArmed,
    containerStopTimeoutSeconds,
    stopContainer: deps.stopDockerContainer,
    requestedBy,
    cancellation,
  });
  await removeQueueJobAfterAbortIfNeeded({
    context,
    activity,
    preparedStop,
    queueRemovalShouldPrecedeAbort,
  });
  const effectiveQueueState = preparedStop.queueStateAfterFailure ?? context.queueState;
  const stopOutcome = mergeStopOutcomes(persistedStopOutcome, {
    containerId,
    containerStopped,
    jobRemoved: preparedStop.jobRemoved,
  });
  const resolvedQueueState = resolveCancellationQueueState(stopOutcome, preparedStop.queueStateAfterFailure ?? context.queueState);
  const stopVerified = isStopVerified({ stopOutcome, shouldAbort: preparedStop.abortSignalArmed });
  const cancellationRequested = preparedStop.abortSignalArmed && !stopVerified;
  assertStopApplied({
    activity,
    currentState: context.currentState,
    queueState: effectiveQueueState,
    containerId,
    stopOutcome,
    shouldAbort: preparedStop.abortSignalArmed,
    queueStateAfterFailure: preparedStop.queueStateAfterFailure,
    createError: (status, body) => new StopTaskExecutionError(status, body),
  });
  if (cancellationRequested) {
    await persistPendingCancellationRequest({
      redisClient,
      context,
      requestedBy,
      cancellation,
      resolvedQueueState,
      containerId: stopOutcome.containerId,
      abortSignalArmed: preparedStop.abortSignalArmed,
      timestamp,
      deps,
    });
  }
  if (requireVerifiedStop && !stopVerified) {
    throw new StopTaskExecutionError(409, {
      error: 'Task stop awaiting verification',
      message: 'The stop request was recorded, but the task is still active and must be rechecked before cancellation is complete.',
      currentState: context.currentState,
      queueState: resolvedQueueState,
      taskId: context.taskId,
      containerStopped: stopOutcome.containerStopped,
      jobRemoved: stopOutcome.jobRemoved,
      stopVerified,
      cancellationRequested,
      abortSignalArmed: preparedStop.abortSignalArmed,
    });
  }

  context = await ensureContextTaskStateAfterQueueRemoval({
    context,
    preparedStop,
    queueRemovalShouldPrecedeAbort,
    deps,
  });

  if (stopVerified) {
    await finalizeStopCancellation({
      redisClient,
      context,
      requestedBy,
      cancellation,
      resolvedQueueState,
      stopOutcome,
      stopVerified,
      abortSignalArmed: preparedStop.abortSignalArmed,
      hadPersistedStopOutcome,
      persistedStopOutcomeDuringStop: preparedStop.persistedStopOutcomeDuringStop,
      deps,
    });
  }
  return {
    success: true,
    message: getStopTaskSuccessMessage({
      jobRemoved: stopOutcome.jobRemoved,
      shouldAbort: preparedStop.abortSignalArmed,
      containerStopped: stopOutcome.containerStopped,
    }),
    taskId: context.taskId,
    containerStopped: stopOutcome.containerStopped,
    jobRemoved: stopOutcome.jobRemoved,
    stopVerified,
    cancellationRequested,
    abortSignalArmed: preparedStop.abortSignalArmed,
    currentState: context.currentState,
    queueState: resolvedQueueState,
    cancellation,
  };
}

async function finalizeStopCancellation(params: {
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

async function clearFinalizedStopState(params: {
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

async function setAbortSignalIfNeeded(params: {
  redisClient: RedisClientLike;
  taskIds: string[];
  requestedBy: string;
  cancellation: StopTaskCancellationReason;
  timestamp: string;
  shouldAbort: boolean;
}): Promise<void> {
  const { redisClient, taskIds, requestedBy, cancellation, timestamp, shouldAbort } = params;
  if (!shouldAbort) {
    return;
  }

  const abortPayload = JSON.stringify({
    timestamp,
    requestedBy,
    reasonCode: cancellation.code,
    reason: cancellation.message,
    source: cancellation.source ?? 'task_stop',
    ...(cancellation.requestId ? { requestId: cancellation.requestId } : {}),
  });

  for (const taskId of taskIds) {
    await redisClient.set(`worker:abort:${taskId}`, abortPayload, { EX: 3600 });
  }

  logger.info({ taskIds, requestedBy, reasonCode: cancellation.code }, 'Abort signal set for task execution');
}

async function clearAbortSignals(redisClient: RedisClientLike, taskIds: string[]): Promise<void> {
  for (const taskId of taskIds) {
    await redisClient.del(`worker:abort:${taskId}`);
  }
}
