import type { Job } from 'bullmq';
import { RedisClientType } from 'redis';
import { stopDockerContainer, getStateManager, logger } from '@propr/core';
import {
  ensureTaskStateForCancellation,
  loadStopTaskContext,
  type QueueJobData,
  type TaskState,
} from './stopTaskExecutionContext.js';

export interface StopTaskCancellationReason {
  code: string;
  message: string;
}

type RedisClientLike = Pick<RedisClientType, 'get' | 'set' | 'del' | 'rPush'>;

export interface StopTaskExecutionOptions {
  redisClient: RedisClientLike;
  requestedBy?: string;
  cancellation?: StopTaskCancellationReason;
}

export interface StopTaskExecutionDeps {
  stopDockerContainer?: typeof stopDockerContainer;
  getStateManager?: typeof getStateManager;
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
}

const RUNNING_TASK_STATES = new Set(['processing', 'claude_execution', 'post_processing']);
const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_QUEUE_STATES = new Set(['completed', 'failed']);
const PRE_START_QUEUE_STATES = new Set(['waiting', 'delayed', 'paused', 'prioritized', 'waiting-children']);
const DEFAULT_STOP_REASON: StopTaskCancellationReason = {
  code: 'user_requested_stop',
  message: 'Task cancelled by user request.',
};

export async function stopTaskExecution(
  taskReference: string,
  options: StopTaskExecutionOptions,
  deps: StopTaskExecutionDeps = {},
): Promise<StopTaskExecutionResult> {
  const { redisClient, requestedBy = 'user', cancellation = DEFAULT_STOP_REASON } = options;
  const context = await (deps.loadStopTaskContext ?? loadStopTaskContext)(taskReference, redisClient, deps);
  const activity = getStopTaskActivity(context.currentState, context.queueState);
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
    state: context.state,
    shouldAbort,
    stopContainer: deps.stopDockerContainer,
  });

  const jobRemoved = await removeQueueJobIfNeeded(context.queueJob, activity.isQueuePreStart);
  const shouldPersistCancelledState = shouldMarkTaskCancelled({
    containerStopped,
    jobRemoved,
  });

  if (shouldClearAbortSignals(shouldAbort, containerStopped, jobRemoved)) {
    await clearAbortSignals(redisClient, context.abortTaskIds);
  }

  if (shouldPersistCancelledState) {
    await markTaskCancelled({
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
    await pushConversationMessage(redisClient, context.taskId, {
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

function getStopTaskActivity(currentState: string | null, queueState: string | null): StopTaskActivity {
  return {
    isRunningTaskState: currentState !== null && RUNNING_TASK_STATES.has(currentState),
    isNonTerminalTaskState: currentState !== null && !TERMINAL_TASK_STATES.has(currentState),
    isQueueActive: queueState === 'active',
    isQueuePreStart: queueState !== null && PRE_START_QUEUE_STATES.has(queueState),
  };
}

function shouldAbortTask(activity: StopTaskActivity): boolean {
  return activity.isRunningTaskState || activity.isQueueActive || activity.isQueuePreStart;
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

  await pushConversationMessage(redisClient, conversationTaskId, {
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
  containerStopped: boolean;
  jobRemoved: boolean;
}): boolean {
  const { containerStopped, jobRemoved } = params;
  return containerStopped || jobRemoved;
}

async function stopTaskContainer(params: {
  redisClient: RedisClientLike;
  taskId: string;
  state: TaskState | null;
  shouldAbort: boolean;
  stopContainer?: typeof stopDockerContainer;
}): Promise<{ containerId?: string; containerStopped: boolean }> {
  const { redisClient, taskId, state, shouldAbort, stopContainer = stopDockerContainer } = params;
  const entry = state?.history.find((historyEntry) => historyEntry.state === 'claude_execution' && historyEntry.metadata?.containerId);
  const containerId = entry?.metadata?.containerId;

  if (!containerId) {
    if (shouldAbort) {
      logger.info({ taskId }, 'No container ID found for task stop; relying on abort signal');
    }
    return { containerStopped: false };
  }

  logger.info({ taskId, containerId }, 'Stopping task container');
  const stopResult = await stopContainer(containerId, 10);

  if (!stopResult.success) {
    logger.warn({ taskId, containerId, error: stopResult.error }, 'Failed to stop task container');
    return { containerId, containerStopped: false };
  }

  logger.info({ taskId, containerId }, 'Task container stopped successfully');
  await pushConversationMessage(redisClient, taskId, {
    type: 'system',
    timestamp: new Date().toISOString(),
    content: 'Docker container terminated.',
    level: 'info',
  });
  return { containerId, containerStopped: true };
}

async function removeQueueJobIfNeeded(queueJob: Job<QueueJobData> | null, isQueuePreStart: boolean): Promise<boolean> {
  if (!queueJob || !isQueuePreStart) {
    return false;
  }

  try {
    await queueJob.remove();
    logger.info({ jobId: String(queueJob.id) }, 'Removed queued job before execution started');
    return true;
  } catch (error) {
    const queueState = await reloadQueueStateAfterRemovalFailure(queueJob);
    if (isBenignQueueRemovalRace(queueState)) {
      logger.warn({ jobId: String(queueJob.id), queueState }, 'Queue job changed state during removal; relying on abort signal');
      return false;
    }
    throw error;
  }
}

export function isBenignQueueRemovalRace(queueState: string | null): boolean {
  return queueState === null || queueState === 'active' || queueState === 'unknown' || TERMINAL_QUEUE_STATES.has(queueState);
}

async function reloadQueueStateAfterRemovalFailure(queueJob: Job<QueueJobData>): Promise<string | null> {
  try {
    return await queueJob.getState();
  } catch (error) {
    logger.warn({ jobId: String(queueJob.id), error: (error as Error).message }, 'Failed to reload queue state after removal failure');
    return null;
  }
}

function getStopTaskSuccessMessage(params: {
  jobRemoved: boolean;
  shouldAbort: boolean;
  containerStopped: boolean;
}): string {
  const { jobRemoved, shouldAbort, containerStopped } = params;
  if (jobRemoved) {
    return 'Queued task cancelled before execution started.';
  }
  if (shouldAbort) {
    return containerStopped
      ? 'Execution stopped. The Docker container has been terminated.'
      : 'Stop request sent to worker. The execution will be terminated shortly.';
  }
  return 'Task cancelled.';
}

async function pushConversationMessage(
  redisClient: RedisClientLike,
  taskId: string,
  message: Record<string, unknown>,
): Promise<void> {
  await redisClient.rPush(`conversation:${taskId}`, JSON.stringify(message));
}

async function markTaskCancelled(params: {
  taskId: string;
  requestedBy: string;
  cancellation: StopTaskCancellationReason;
  queueState: string | null;
  containerId?: string;
  containerStopped: boolean;
  deps: StopTaskExecutionDeps;
}): Promise<void> {
  const { taskId, requestedBy, cancellation, queueState, containerId, containerStopped, deps } = params;
  const stateManager = (deps.getStateManager ?? getStateManager)();

  await stateManager.markTaskCancelled(taskId, requestedBy, {
    reason: cancellation.message,
    cancellation: {
      code: cancellation.code,
      message: cancellation.message,
      cancelledBy: requestedBy === 'system' ? 'system' : 'user',
      source: 'task_stop',
      containerStopped,
      ...(containerId ? { containerId } : {}),
    },
    historyMetadata: {
      cancellation: {
        code: cancellation.code,
        message: cancellation.message,
      },
      requestedBy,
      containerStopped,
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
  }, 'Task marked as cancelled');
}
