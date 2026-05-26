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
  getStopTaskActivity,
  getTaskContainerId,
  isStopVerified,
  shouldAbortTask,
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
  removeQueuedJobAfterStateCreation,
  removeQueueJobIfNeeded,
  stopTaskContainer,
} from './stopTaskExecutionQueueing.js';
export { isBenignQueueRemovalRace } from './stopTaskExecutionQueueing.js';

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

  const timestamp = new Date().toISOString();
  const queueRemovalShouldPrecedeAbort = shouldRemoveQueueJobBeforeArmingAbort(activity);
  const preparedStop = await prepareContextForStop({
    context,
    deps,
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
  if (!queueRemovalShouldPrecedeAbort) {
    const removalResult = await removeQueueJobIfNeeded(context.queueJob, activity.isQueuePreStart);
    preparedStop.jobRemoved = removalResult.jobRemoved;
    preparedStop.queueStateAfterFailure = removalResult.queueStateAfterFailure;
  }
  const effectiveQueueState = preparedStop.queueStateAfterFailure ?? context.queueState;
  const stopOutcome = mergeStopOutcomes(persistedStopOutcome, {
    containerId,
    containerStopped,
    jobRemoved: preparedStop.jobRemoved,
  });
  const resolvedQueueState = resolveCancellationQueueState(stopOutcome, preparedStop.queueStateAfterFailure ?? context.queueState);
  const stopVerified = isStopVerified({ stopOutcome, shouldAbort: preparedStop.abortSignalArmed });
  const cancellationRequested = preparedStop.abortSignalArmed && !stopVerified;
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
  const shouldPersistCancelledState = stopVerified;
  if (shouldPersistCancelledState) {
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
        abortSignalArmed: preparedStop.abortSignalArmed,
        deps,
      });
    } catch (error) {
      await persistStopOutcome(redisClient, context.abortTaskIds, stopOutcome);
      throw error;
    }
    await pushStopConversationMessage(redisClient, context.taskId, {
      type: 'system',
      timestamp: new Date().toISOString(),
      content: 'Task cancelled successfully.',
      level: 'info',
      metadata: buildStopMessageMetadata(cancellation, requestedBy),
    });
    const shouldRetainAbortSignals = shouldKeepAbortSignalsAfterCancellation({
      shouldAbort: preparedStop.abortSignalArmed,
      stopVerified,
    });
    if (!shouldRetainAbortSignals) {
      await clearPendingStopRequest(redisClient, context.abortTaskIds);
      await clearAbortSignals(redisClient, context.abortTaskIds);
    }
    if (hadPersistedStopOutcome || preparedStop.persistedStopOutcomeDuringStop) {
      await clearPersistedStopOutcome(redisClient, context.abortTaskIds);
    }
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

function shouldRemoveQueueJobBeforeArmingAbort(activity: ReturnType<typeof getStopTaskActivity>): boolean {
  return activity.isQueuePreStart
    && !activity.isRunningTaskState
    && !activity.isQueueActive
    && !activity.hasContainerToStop;
}

async function prepareContextForStop(params: {
  context: StopTaskContext;
  deps: StopTaskExecutionDeps;
  redisClient: RedisClientLike;
  activity: ReturnType<typeof getStopTaskActivity>;
  shouldAbort: boolean;
  queueRemovalShouldPrecedeAbort: boolean;
}): Promise<{
  context: StopTaskContext;
  jobRemoved: boolean;
  queueStateAfterFailure: string | null;
  persistedStopOutcomeDuringStop: boolean;
  abortSignalArmed: boolean;
}> {
  const {
    deps,
    redisClient,
    activity,
    shouldAbort,
    queueRemovalShouldPrecedeAbort,
  } = params;
  let { context } = params;
  let jobRemoved = false;
  let queueStateAfterFailure: string | null = null;
  let persistedStopOutcomeDuringStop = false;

  if (queueRemovalShouldPrecedeAbort) {
    ({ jobRemoved, queueStateAfterFailure, persistedStopOutcomeDuringStop } = await removeQueuedJobAfterStateCreation({
      context,
      activity,
      redisClient,
    }));
  } else {
    context = await ensureContextTaskStateForCancellation(context, deps);
  }

  const abortSignalArmed = shouldArmAbortSignal({
    shouldAbort,
    queueRemovalShouldPrecedeAbort,
    jobRemoved,
    queueStateAfterFailure,
  });
  if (queueRemovalShouldPrecedeAbort && (jobRemoved || abortSignalArmed)) {
    context = await ensureContextTaskStateForCancellation(context, deps);
  }

  return {
    context,
    jobRemoved,
    queueStateAfterFailure,
    persistedStopOutcomeDuringStop,
    abortSignalArmed,
  };
}

async function ensureContextTaskStateForCancellation(
  context: StopTaskContext,
  deps: StopTaskExecutionDeps,
): Promise<StopTaskContext> {
  const ensuredState = await (deps.ensureTaskStateForCancellation ?? ensureTaskStateForCancellation)(
    context.taskId,
    context.state,
    context.queueJob,
    deps,
  );
  if (!ensuredState) {
    return context;
  }

  return {
    ...context,
    state: ensuredState,
    currentState: ensuredState.history[ensuredState.history.length - 1]?.state ?? context.currentState,
  };
}

function shouldArmAbortSignal(params: {
  shouldAbort: boolean;
  queueRemovalShouldPrecedeAbort: boolean;
  jobRemoved: boolean;
  queueStateAfterFailure: string | null;
}): boolean {
  const {
    shouldAbort,
    queueRemovalShouldPrecedeAbort,
    jobRemoved,
    queueStateAfterFailure,
  } = params;
  if (!shouldAbort) {
    return false;
  }

  if (!queueRemovalShouldPrecedeAbort) {
    return true;
  }

  return !jobRemoved && queueStateAfterFailure === 'active';
}

function buildStopMessageMetadata(cancellation: StopTaskCancellationReason, requestedBy: string): Record<string, string> {
  return {
    reasonCode: cancellation.code,
    requestedBy,
    ...(cancellation.requestId ? { cancellationRequestId: cancellation.requestId } : {}),
  };
}
