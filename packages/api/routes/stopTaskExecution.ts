import { RedisClientType } from 'redis';
import {
  logger,
  stopDockerContainer,
} from '@propr/core';
import {
  ensureTaskStateForCancellation,
  loadStopTaskContext,
} from './stopTaskExecutionContext.js';
import {
  assertStopApplied,
  assertTaskCanBeStopped,
  getStopTaskActivity,
  getTaskContainerId,
  isStopVerified,
  shouldAbortTask,
  shouldKeepAbortSignalsAfterCancellation,
} from './stopTaskExecutionGuards.js';
import { persistTaskCancellation, pushStopConversationMessage } from './stopTaskExecutionPersistence.js';
import {
  clearPersistedStopOutcome,
  loadPersistedStopOutcome,
  mergeStopOutcomes,
  persistStopOutcome,
  resolveCancellationQueueState,
  hasConcreteStopOutcome,
} from './stopTaskExecutionOutcome.js';
import {
  clearPrQueueJobIndexEntriesIfNeeded,
  getStopTaskSuccessMessage,
  removeQueueJobIfNeeded,
  stopTaskContainer,
} from './stopTaskExecutionQueueing.js';
export { isBenignQueueRemovalRace } from './stopTaskExecutionQueueing.js';

export interface StopTaskCancellationReason {
  code: string;
  message: string;
  source?: string;
}

type RedisClientLike = Pick<RedisClientType, 'get' | 'set' | 'del' | 'rPush'>;

export interface StopTaskExecutionOptions {
  redisClient: RedisClientLike;
  requestedBy?: string;
  cancellation?: StopTaskCancellationReason;
  containerStopTimeoutSeconds?: number;
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
  stopVerified: boolean;
  abortSignalArmed: boolean;
  currentState: string | null;
  queueState: string | null;
  cancellation: StopTaskCancellationReason;
}

export class StopTaskExecutionError extends Error {
  status: number;
  body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : 'Task stop failed');
    this.name = 'StopTaskExecutionError';
    this.status = status;
    this.body = body;
  }
}

const DEFAULT_STOP_REASON: StopTaskCancellationReason = {
  code: 'user_requested_stop',
  message: 'Task cancelled by user request.',
  source: 'task_stop',
};

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
  } = options;
  const context = await (deps.loadStopTaskContext ?? loadStopTaskContext)(taskReference, redisClient, deps);
  const persistedStopOutcome = await loadPersistedStopOutcome(redisClient, context.taskId);
  const hadPersistedStopOutcome = hasConcreteStopOutcome(persistedStopOutcome);
  const trackedContainerId = getTaskContainerId(context.state, context.currentState);
  const activity = getStopTaskActivity(context.currentState, context.queueState, trackedContainerId !== null);
  const shouldAbort = shouldAbortTask(activity);
  assertTaskCanBeStopped({
    state: context.state,
    queueJob: context.queueJob,
    currentState: context.currentState,
    queueState: context.queueState,
    activity,
    persistedStopOutcome,
    createError: (status, body) => new StopTaskExecutionError(status, body),
  });
  await (deps.ensureTaskStateForCancellation ?? ensureTaskStateForCancellation)(context.taskId, context.state, context.queueJob, deps);

  const timestamp = new Date().toISOString();
  await setAbortSignalIfNeeded({
    redisClient,
    taskIds: context.abortTaskIds,
    conversationTaskId: context.taskId,
    requestedBy,
    cancellation,
    timestamp,
    shouldAbort,
  });
  const { containerId, containerStopped } = await stopTaskContainer({
    redisClient,
    taskId: context.taskId,
    containerId: trackedContainerId,
    shouldAbort,
    containerStopTimeoutSeconds,
    stopContainer: deps.stopDockerContainer,
  });
  const { jobRemoved, queueStateAfterFailure } = await removeQueueJobIfNeeded(context.queueJob, activity.isQueuePreStart);
  const effectiveQueueState = queueStateAfterFailure ?? context.queueState;
  if (jobRemoved) await clearPrQueueJobIndexEntriesIfNeeded(context.queueJob, deps);
  const stopOutcome = mergeStopOutcomes(persistedStopOutcome, {
    containerId,
    containerStopped,
    jobRemoved,
  });
  const resolvedQueueState = resolveCancellationQueueState(stopOutcome, queueStateAfterFailure ?? context.queueState);
  const stopVerified = isStopVerified({ stopOutcome, shouldAbort });
  assertStopApplied({
    activity,
    currentState: context.currentState,
    queueState: effectiveQueueState,
    containerId,
    stopOutcome,
    shouldAbort,
    queueStateAfterFailure,
    createError: (status, body) => new StopTaskExecutionError(status, body),
  });
  const shouldPersistCancelledState = stopVerified;
  if (!shouldPersistCancelledState && shouldAbort) {
    await pushStopConversationMessage(redisClient, context.taskId, {
      type: 'system',
      timestamp: new Date().toISOString(),
      content: 'Cancellation requested. Worker shutdown is still in progress.',
      level: 'info',
      metadata: { reasonCode: cancellation.code, requestedBy },
    });
  }
  if (shouldPersistCancelledState) {
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
        abortSignalArmed: shouldAbort,
        deps,
      });
    } catch (error) {
      await persistStopOutcome(redisClient, context.taskId, stopOutcome);
      throw error;
    }
    await pushStopConversationMessage(redisClient, context.taskId, {
      type: 'system',
      timestamp: new Date().toISOString(),
      content: 'Task cancelled successfully.',
      level: 'info',
      metadata: { reasonCode: cancellation.code, requestedBy },
    });
    const shouldRetainAbortSignals = shouldKeepAbortSignalsAfterCancellation({
      shouldAbort,
      stopVerified,
    });
    if (!shouldRetainAbortSignals) {
      await clearAbortSignals(redisClient, context.abortTaskIds);
    }
    if (hadPersistedStopOutcome) {
      await clearPersistedStopOutcome(redisClient, context.taskId);
    }
  }
  return {
    success: true,
    message: getStopTaskSuccessMessage({
      jobRemoved: stopOutcome.jobRemoved,
      shouldAbort,
      containerStopped: stopOutcome.containerStopped,
    }),
    taskId: context.taskId,
    containerStopped: stopOutcome.containerStopped,
    jobRemoved: stopOutcome.jobRemoved,
    stopVerified,
    abortSignalArmed: shouldAbort,
    currentState: context.currentState,
    queueState: resolvedQueueState,
    cancellation,
  };
}

async function setAbortSignalIfNeeded(params: {
  redisClient: RedisClientLike;
  taskIds: string[];
  conversationTaskId: string;
  requestedBy: string;
  cancellation: StopTaskCancellationReason;
  timestamp: string;
  shouldAbort: boolean;
}): Promise<void> {
  const { redisClient, taskIds, conversationTaskId, requestedBy, cancellation, timestamp, shouldAbort } = params;
  if (!shouldAbort) {
    return;
  }

  const abortPayload = JSON.stringify({
    timestamp,
    requestedBy,
    reasonCode: cancellation.code,
    reason: cancellation.message,
  });

  for (const taskId of taskIds) {
    await redisClient.set(`worker:abort:${taskId}`, abortPayload, { EX: 3600 });
  }

  await pushStopConversationMessage(redisClient, conversationTaskId, {
    type: 'system',
    timestamp,
    content: cancellation.message,
    level: 'warning',
    metadata: { reasonCode: cancellation.code, requestedBy },
  });
  logger.info({ taskIds, conversationTaskId, requestedBy, reasonCode: cancellation.code }, 'Abort signal set for task execution');
}

async function clearAbortSignals(redisClient: RedisClientLike, taskIds: string[]): Promise<void> {
  for (const taskId of taskIds) {
    await redisClient.del(`worker:abort:${taskId}`);
  }
}
