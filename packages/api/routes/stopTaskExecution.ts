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
  getStopTaskSuccessMessage,
  removeQueueJobIfNeeded,
  stopTaskContainer,
} from './stopTaskExecutionQueueing.js';
export { isBenignQueueRemovalRace } from './stopTaskExecutionQueueing.js';

export interface StopTaskCancellationReason {
  code: string;
  message: string;
  source?: string;
  requestId?: string;
  metadata?: Record<string, string>;
}

type RedisClientLike = Pick<RedisClientType, 'get' | 'set' | 'del' | 'rPush'>;

export interface StopTaskExecutionOptions {
  redisClient: RedisClientLike;
  requestedBy?: string;
  cancellation?: StopTaskCancellationReason;
  containerStopTimeoutSeconds?: number;
  forceQueueScan?: boolean;
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
  /** True once the container stopped, queued job was removed, or no async abort was needed. */
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

export function isStopTaskExecutionError(error: unknown): error is StopTaskExecutionError {
  if (error instanceof StopTaskExecutionError) {
    return true;
  }

  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as Record<string, unknown>;
  return candidate.name === 'StopTaskExecutionError'
    && typeof candidate.status === 'number'
    && Number.isInteger(candidate.status)
    && candidate.status >= 400
    && candidate.status < 600
    && !!candidate.body
    && typeof candidate.body === 'object'
    && !Array.isArray(candidate.body);
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
    forceQueueScan = false,
  } = options;
  let context = await (deps.loadStopTaskContext ?? loadStopTaskContext)(taskReference, redisClient, { ...deps, forceQueueScan });
  const persistedStopOutcome = await loadPersistedStopOutcome(redisClient, context.abortTaskIds);
  const hadPersistedStopOutcome = hasConcreteStopOutcome(persistedStopOutcome);

  let trackedContainerId = getTaskContainerId(context.state, context.currentState);
  let activity = getStopTaskActivity(context.currentState, context.queueState, trackedContainerId !== null);
  assertTaskCanBeStopped({
    state: context.state,
    queueJob: context.queueJob,
    currentState: context.currentState,
    queueState: context.queueState,
    activity,
    persistedStopOutcome,
    createError: (status, body) => new StopTaskExecutionError(status, body),
  });

  context = await ensureContextTaskStateForCancellation(context, deps);
  trackedContainerId = getTaskContainerId(context.state, context.currentState);
  activity = getStopTaskActivity(context.currentState, context.queueState, trackedContainerId !== null);

  const timestamp = new Date().toISOString();
  const queueRemovalFirst = shouldRemoveQueueJobBeforeAbort(activity);
  let queueRemoval = { jobRemoved: false, queueStateAfterFailure: null as string | null };
  if (queueRemovalFirst) {
    queueRemoval = await removeQueueJobIfNeeded(context.queueJob, activity.isQueuePreStart);
  }

  const shouldAbort = shouldAbortTask(activity)
    && (!queueRemovalFirst || (!queueRemoval.jobRemoved && queueRemoval.queueStateAfterFailure === 'active'));
  await setAbortSignalIfNeeded({
    redisClient,
    taskIds: context.abortTaskIds,
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
    requestedBy,
    cancellation,
  });
  if (!queueRemovalFirst) {
    queueRemoval = await removeQueueJobIfNeeded(context.queueJob, activity.isQueuePreStart);
  }

  const effectiveQueueState = queueRemoval.queueStateAfterFailure ?? context.queueState;
  const stopOutcome = mergeStopOutcomes(persistedStopOutcome, {
    containerId,
    containerStopped,
    jobRemoved: queueRemoval.jobRemoved,
  });
  const resolvedQueueState = resolveCancellationQueueState(stopOutcome, effectiveQueueState);
  const stopVerified = isStopVerified({ stopOutcome, shouldAbort });
  const cancellationRequested = shouldAbort && !stopVerified;
  const persistUnverifiedQueueCancellation = shouldPersistUnverifiedQueueCancellation({
    activity,
    queueRemovalFirst,
    queueStateAfterFailure: queueRemoval.queueStateAfterFailure,
    cancellationRequested,
  });
  assertStopApplied({
    activity,
    currentState: context.currentState,
    queueState: effectiveQueueState,
    containerId,
    stopOutcome,
    shouldAbort,
    queueStateAfterFailure: queueRemoval.queueStateAfterFailure,
    createError: (status, body) => new StopTaskExecutionError(status, body),
  });

  if (cancellationRequested) {
    await pushStopConversationMessage(redisClient, context.taskId, {
      type: 'system',
      timestamp: new Date().toISOString(),
      content: 'Cancellation requested. Worker shutdown is still in progress.',
      level: 'info',
      metadata: buildStopMessageMetadata(cancellation, requestedBy),
    });
    if (persistUnverifiedQueueCancellation) {
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
    }
  }

  if (stopVerified) {
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
        abortSignalArmed: shouldAbort,
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
    if (!shouldKeepAbortSignalsAfterCancellation({ shouldAbort, stopVerified })) {
      await clearAbortSignals(redisClient, context.abortTaskIds);
    }
    if (hadPersistedStopOutcome) {
      await clearPersistedStopOutcome(redisClient, context.abortTaskIds);
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
    cancellationRequested,
    abortSignalArmed: shouldAbort,
    currentState: context.currentState,
    queueState: resolvedQueueState,
    cancellation,
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
    ...(cancellation.metadata ? { metadata: cancellation.metadata } : {}),
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

function shouldRemoveQueueJobBeforeAbort(activity: ReturnType<typeof getStopTaskActivity>): boolean {
  return activity.isQueuePreStart
    && !activity.isRunningTaskState
    && !activity.isQueueActive
    && !activity.hasContainerToStop;
}

function shouldPersistUnverifiedQueueCancellation(params: {
  activity: ReturnType<typeof getStopTaskActivity>;
  queueRemovalFirst: boolean;
  queueStateAfterFailure: string | null;
  cancellationRequested: boolean;
}): boolean {
  return params.cancellationRequested
    && params.queueRemovalFirst
    && params.activity.isQueuePreStart
    && params.queueStateAfterFailure === 'active';
}

function buildStopMessageMetadata(
  cancellation: StopTaskCancellationReason,
  requestedBy: string,
): Record<string, string> {
  return {
    ...(cancellation.metadata ?? {}),
    reasonCode: cancellation.code,
    requestedBy,
    ...(cancellation.source ? { source: cancellation.source } : {}),
    ...(cancellation.requestId ? { requestId: cancellation.requestId } : {}),
  };
}
