/* eslint-disable max-lines */
import type { Job } from 'bullmq';
import { RedisClientType } from 'redis';
import {
  logger,
  STOPPABLE_TASK_STATES,
  stopDockerContainer,
  TERMINAL_TASK_STATES,
  TRACKED_PR_QUEUE_STATES,
} from '@propr/core';
import {
  ensureTaskStateForCancellation,
  loadStopTaskContext,
  type QueueJobData,
  type TaskState,
} from './stopTaskExecutionContext.js';
import { persistTaskCancellation, pushStopConversationMessage } from './stopTaskExecutionPersistence.js';
import {
  clearPersistedStopOutcome,
  hasConcreteStopOutcome,
  loadPersistedStopOutcome,
  mergeStopOutcomes,
  persistStopOutcome,
  type PersistedStopOutcome,
  resolveCancellationQueueState,
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

interface StopTaskActivity {
  isRunningTaskState: boolean;
  isNonTerminalTaskState: boolean;
  isQueueActive: boolean;
  isQueuePreStart: boolean;
  hasContainerToStop: boolean;
}

const RUNNING_TASK_STATES = new Set<string>(STOPPABLE_TASK_STATES);
const CONTAINER_TASK_STATES = new Set(['claude_execution', 'post_processing']);
const TERMINAL_TASK_STATE_SET = new Set<string>(TERMINAL_TASK_STATES);
const TERMINAL_QUEUE_STATES = new Set(['completed', 'failed']);
const PRE_START_QUEUE_STATES = new Set<string>(TRACKED_PR_QUEUE_STATES.filter((state) => state !== 'active'));
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
  });
  const shouldPersistCancelledState = shouldMarkTaskCancelled({
    shouldAbort,
    containerStopped: stopOutcome.containerStopped,
    jobRemoved: stopOutcome.jobRemoved,
  });
  const shouldRetainAbortSignals = shouldKeepAbortSignalsAfterCancellation({
    shouldAbort,
    stopVerified,
  });
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
      content: stopVerified
        ? 'Task cancelled successfully.'
        : 'Cancellation requested. Worker shutdown is still in progress.',
      level: 'info',
      metadata: { reasonCode: cancellation.code, requestedBy },
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

function getStopTaskActivity(
  currentState: string | null,
  queueState: string | null,
  hasContainerToStop: boolean,
): StopTaskActivity {
  return {
    isRunningTaskState: currentState !== null && RUNNING_TASK_STATES.has(currentState),
    isNonTerminalTaskState: currentState !== null && !TERMINAL_TASK_STATE_SET.has(currentState),
    isQueueActive: queueState === 'active',
    isQueuePreStart: queueState !== null && PRE_START_QUEUE_STATES.has(queueState),
    hasContainerToStop,
  };
}

function shouldAbortTask(activity: StopTaskActivity): boolean {
  return activity.isRunningTaskState || activity.isQueueActive || activity.isQueuePreStart || activity.hasContainerToStop;
}

function assertTaskCanBeStopped(params: {
  state: TaskState | null;
  queueJob: Job<QueueJobData> | null;
  currentState: string | null;
  queueState: string | null;
  activity: StopTaskActivity;
  persistedStopOutcome: PersistedStopOutcome;
}): void {
  const {
    state,
    queueJob,
    currentState,
    queueState,
    activity,
    persistedStopOutcome,
  } = params;
  if (hasConcreteStopOutcome(persistedStopOutcome)) {
    return;
  }
  if (!state && !queueJob) {
    throw new StopTaskExecutionError(404, {
      error: 'Task not found',
      message: 'The task may have already completed or does not exist.',
    });
  }
  if (activity.isRunningTaskState) {
    return;
  }
  if (activity.isQueueActive || activity.isQueuePreStart) {
    return;
  }
  if (activity.hasContainerToStop) {
    return;
  }
  if (activity.isNonTerminalTaskState) {
    throw new StopTaskExecutionError(409, {
      error: 'Task is not stoppable',
      message: 'The task is not in a stoppable worker or queue state.',
      currentState,
      queueState,
    });
  }

  throw new StopTaskExecutionError(400, {
    error: 'Task is not running',
    message: 'The task has already completed or is not in an active state.',
    currentState,
    queueState,
  });
}

function getTaskContainerId(state: TaskState | null, currentState: string | null): string | null {
  if (!currentState || !CONTAINER_TASK_STATES.has(currentState)) {
    return null;
  }

  if (!state) {
    return null;
  }

  for (let index = state.history.length - 1; index >= 0; index -= 1) {
    const entry = state.history[index];
    if (entry.state === 'claude_execution' && typeof entry.metadata?.containerId === 'string') {
      return entry.metadata.containerId;
    }
  }

  return null;
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

function shouldMarkTaskCancelled(params: {
  shouldAbort: boolean;
  containerStopped: boolean;
  jobRemoved: boolean;
}): boolean {
  return params.containerStopped || params.jobRemoved || params.shouldAbort;
}

function shouldKeepAbortSignalsAfterCancellation(params: {
  shouldAbort: boolean;
  stopVerified: boolean;
}): boolean {
  return params.shouldAbort && !params.stopVerified;
}

function isStopVerified(params: {
  stopOutcome: PersistedStopOutcome;
  shouldAbort: boolean;
}): boolean {
  return hasConcreteStopOutcome(params.stopOutcome) || !params.shouldAbort;
}

function assertStopApplied(params: {
  activity: StopTaskActivity;
  currentState: string | null;
  queueState: string | null;
  containerId: string | null;
  stopOutcome: PersistedStopOutcome;
  shouldAbort: boolean;
  queueStateAfterFailure: string | null;
}): void {
  const {
    activity,
    currentState,
    queueState,
    containerId,
    stopOutcome,
    shouldAbort,
    queueStateAfterFailure,
  } = params;
  if (hasConcreteStopOutcome(stopOutcome)) {
    return;
  }

  if (queueStateAfterFailure !== null && TERMINAL_QUEUE_STATES.has(queueStateAfterFailure)) {
    throw new StopTaskExecutionError(409, {
      error: 'Task stop missed queued execution',
      message: 'The queued task reached a terminal state before cancellation was applied.',
      currentState,
      queueState: queueStateAfterFailure,
    });
  }

  if (activity.isQueuePreStart && queueStateAfterFailure !== 'active') {
    throw new StopTaskExecutionError(409, {
      error: 'Task stop incomplete',
      message: 'The queued task could not be removed before execution started, so cancellation was not verified.',
      currentState,
      queueState,
      containerId,
    });
  }

  if (shouldAbort) {
    logger.info({
      currentState,
      queueState,
      containerId,
      hasContainerToStop: activity.hasContainerToStop,
    }, 'Stop request armed via worker abort signal; awaiting worker or queue-state confirmation');
    return;
  }

  if (activity.hasContainerToStop) {
    throw new StopTaskExecutionError(409, {
      error: 'Task stop incomplete',
      message: 'The task container could not be stopped, so cancellation was not persisted.',
      currentState,
      queueState,
      containerId,
    });
  }
}
