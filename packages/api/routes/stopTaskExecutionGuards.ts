import { logger, STOPPABLE_TASK_STATES, TERMINAL_TASK_STATES } from '@propr/core';
import type { Job } from 'bullmq';
import type { QueueJobData, TaskState } from './stopTaskExecutionContext.js';
import { hasConcreteStopOutcome, type PersistedStopOutcome } from './stopTaskExecutionOutcome.js';

export interface StopTaskActivity {
  isRunningTaskState: boolean;
  isNonTerminalTaskState: boolean;
  isQueueActive: boolean;
  isQueuePreStart: boolean;
  hasContainerToStop: boolean;
}

type StopTaskErrorFactory = (status: number, body: Record<string, unknown>) => Error;

const RUNNING_TASK_STATES = new Set<string>(STOPPABLE_TASK_STATES);
const TERMINAL_TASK_STATE_SET = new Set<string>(TERMINAL_TASK_STATES);
const TERMINAL_QUEUE_STATES = new Set(['completed', 'failed']);
const PRE_START_QUEUE_STATES = new Set(['waiting', 'delayed', 'paused', 'prioritized', 'waiting-children']);

export function getStopTaskActivity(
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

export function shouldAbortTask(activity: StopTaskActivity): boolean {
  return activity.isRunningTaskState || activity.isQueueActive || activity.isQueuePreStart || activity.hasContainerToStop;
}

export function assertTaskCanBeStopped(params: {
  state: TaskState | null;
  queueJob: Job<QueueJobData> | null;
  currentState: string | null;
  queueState: string | null;
  activity: StopTaskActivity;
  persistedStopOutcome: PersistedStopOutcome;
  createError: StopTaskErrorFactory;
}): void {
  const {
    state,
    queueJob,
    currentState,
    queueState,
    activity,
    persistedStopOutcome,
    createError,
  } = params;
  if (hasConcreteStopOutcome(persistedStopOutcome)) {
    // A concrete Redis stop outcome means an earlier stop removed the queued job
    // or stopped the container but failed while persisting final task state. Let
    // the retry finish persistence even if the live queue/worker state is gone.
    return;
  }
  if (!state && !queueJob) {
    throw createError(404, {
      error: 'Task not found',
      message: 'The task may have already completed or does not exist.',
    });
  }
  if (activity.isRunningTaskState || activity.isQueueActive || activity.isQueuePreStart || activity.hasContainerToStop) {
    return;
  }
  if (activity.isNonTerminalTaskState) {
    throw createError(409, {
      error: 'Task is not stoppable',
      message: 'The task is not in a stoppable worker or queue state.',
      currentState,
      queueState,
    });
  }

  throw createError(400, {
    error: 'Task is not running',
    message: 'The task has already completed or is not in an active state.',
    currentState,
    queueState,
  });
}

export function getTaskContainerId(state: TaskState | null, currentState: string | null): string | null {
  if (!state || (currentState !== null && TERMINAL_TASK_STATE_SET.has(currentState))) {
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

export function shouldKeepAbortSignalsAfterCancellation(params: {
  shouldAbort: boolean;
  stopVerified: boolean;
}): boolean {
  return params.shouldAbort;
}

export function isStopVerified(params: {
  stopOutcome: PersistedStopOutcome;
  shouldAbort: boolean;
}): boolean {
  return hasConcreteStopOutcome(params.stopOutcome) || !params.shouldAbort;
}

export function assertStopApplied(params: {
  activity: StopTaskActivity;
  currentState: string | null;
  queueState: string | null;
  containerId: string | null;
  stopOutcome: PersistedStopOutcome;
  shouldAbort: boolean;
  queueStateAfterFailure: string | null;
  createError: StopTaskErrorFactory;
}): void {
  const {
    activity,
    currentState,
    queueState,
    containerId,
    stopOutcome,
    shouldAbort,
    queueStateAfterFailure,
    createError,
  } = params;
  if (hasConcreteStopOutcome(stopOutcome)) {
    return;
  }

  if (queueStateAfterFailure !== null && TERMINAL_QUEUE_STATES.has(queueStateAfterFailure)) {
    throw createError(409, {
      error: 'Task stop missed queued execution',
      message: 'The queued task reached a terminal state before cancellation was applied.',
      currentState,
      queueState: queueStateAfterFailure,
    });
  }

  if (activity.isQueuePreStart && queueStateAfterFailure !== 'active') {
    throw createError(409, {
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
    throw createError(409, {
      error: 'Task stop incomplete',
      message: 'The task container could not be stopped, so cancellation was not persisted.',
      currentState,
      queueState,
      containerId,
    });
  }
}
