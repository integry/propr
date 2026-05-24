import type { Job } from 'bullmq';
import { RedisClientType } from 'redis';
import { logger, stopDockerContainer } from '@propr/core';
import {
  ensureTaskStateForCancellation,
  loadStopTaskContext,
  type QueueJobData,
  type TaskState,
} from './stopTaskExecutionContext.js';
import { persistTaskCancellation, pushStopConversationMessage } from './stopTaskExecutionPersistence.js';
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

const RUNNING_TASK_STATES = new Set(['processing', 'claude_execution', 'post_processing']);
const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'cancelled']);
const PRE_START_QUEUE_STATES = new Set(['waiting', 'delayed', 'paused', 'prioritized', 'waiting-children']);
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
  const trackedContainerId = getTaskContainerId(context.state);
  const activity = getStopTaskActivity(context.currentState, context.queueState, trackedContainerId !== null);
  const shouldAbort = shouldAbortTask(activity);
  assertTaskCanBeStopped({
    state: context.state,
    queueJob: context.queueJob,
    currentState: context.currentState,
    queueState: context.queueState,
    activity,
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
  const { jobRemoved } = await removeQueueJobIfNeeded(context.queueJob, activity.isQueuePreStart);
  if (jobRemoved) await clearPrQueueJobIndexEntriesIfNeeded(context.queueJob, deps);
  const shouldPersistCancelledState = shouldMarkTaskCancelled({
    activity,
    shouldAbort,
    containerStopped,
    jobRemoved,
  });
  assertStopApplied({
    activity,
    currentState: context.currentState,
    queueState: context.queueState,
    containerId,
    containerStopped,
    jobRemoved,
  });
  if (shouldClearAbortSignals(shouldAbort, containerStopped, jobRemoved)) {
    await clearAbortSignals(redisClient, context.abortTaskIds);
  }
  if (shouldPersistCancelledState) {
    await persistTaskCancellation({
      taskId: context.taskId,
      requestedBy,
      cancellation,
      queueState: context.queueState,
      containerId,
      containerStopped,
      deps,
    });
  }
  if (shouldPersistCancelledState) {
    await pushStopConversationMessage(redisClient, context.taskId, {
      type: 'system',
      timestamp: new Date().toISOString(),
      content: 'Task cancelled successfully.',
      level: 'info',
      metadata: { reasonCode: cancellation.code, requestedBy },
    });
  }
  return {
    success: true,
    message: getStopTaskSuccessMessage({
      jobRemoved,
      shouldAbort,
      containerStopped,
    }),
    taskId: context.taskId,
    containerStopped,
    jobRemoved,
    currentState: context.currentState,
    queueState: context.queueState,
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
    isNonTerminalTaskState: currentState !== null && !TERMINAL_TASK_STATES.has(currentState),
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
}): void {
  const { state, queueJob, currentState, queueState, activity } = params;
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

function getTaskContainerId(state: TaskState | null): string | null {
  const entry = state?.history.find((historyEntry) => historyEntry.state === 'claude_execution' && historyEntry.metadata?.containerId);
  return typeof entry?.metadata?.containerId === 'string' ? entry.metadata.containerId : null;
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

function shouldClearAbortSignals(shouldAbort: boolean, containerStopped: boolean, jobRemoved: boolean): boolean {
  return shouldAbort && (containerStopped || jobRemoved);
}

function shouldMarkTaskCancelled(params: {
  activity: StopTaskActivity;
  shouldAbort: boolean;
  containerStopped: boolean;
  jobRemoved: boolean;
}): boolean {
  if (params.containerStopped || params.jobRemoved) {
    return true;
  }

  if (!params.shouldAbort) {
    return false;
  }

  if (params.activity.hasContainerToStop) {
    return false;
  }

  return params.activity.isRunningTaskState;
}

function assertStopApplied(params: {
  activity: StopTaskActivity;
  currentState: string | null;
  queueState: string | null;
  containerId: string | null;
  containerStopped: boolean;
  jobRemoved: boolean;
}): void {
  const { activity, currentState, queueState, containerId, containerStopped, jobRemoved } = params;
  if (jobRemoved || containerStopped) {
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
