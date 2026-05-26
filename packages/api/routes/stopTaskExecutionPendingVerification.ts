import { TERMINAL_TASK_STATES } from '@propr/core';
import type {
  StopTaskCancellationReason,
  StopTaskExecutionResult,
} from './stopTaskExecution.js';
import type { StopTaskContext } from './stopTaskExecutionContext.js';

const TERMINAL_TASK_STATE_SET = new Set<string>(TERMINAL_TASK_STATES);
const TERMINAL_QUEUE_STATE_SET = new Set<string>(['completed', 'failed']);

export function isPendingStopNowVerified(context: StopTaskContext): boolean {
  if (context.currentState !== null && TERMINAL_TASK_STATE_SET.has(context.currentState)) {
    return true;
  }

  if (context.queueState !== null && TERMINAL_QUEUE_STATE_SET.has(context.queueState)) {
    return true;
  }

  return context.state === null && context.queueJob === null;
}

export function buildVerifiedPendingStopResult(
  context: StopTaskContext,
  cancellation: StopTaskCancellationReason,
): StopTaskExecutionResult {
  return {
    success: true,
    message: 'Task cancellation already verified.',
    taskId: context.taskId,
    containerStopped: false,
    jobRemoved: false,
    stopVerified: true,
    cancellationRequested: false,
    abortSignalArmed: true,
    currentState: context.currentState,
    queueState: context.queueState,
    cancellation,
  };
}

export function buildAwaitingVerificationErrorBody(params: {
  currentState: string | null;
  queueState: string | null;
  taskId: string;
  containerStopped: boolean;
  jobRemoved: boolean;
  stopVerified: boolean;
  cancellationRequested: boolean;
  abortSignalArmed: boolean;
}): Record<string, unknown> {
  return {
    error: 'Task stop awaiting verification',
    message: 'The stop request was recorded, but the task is still active and must be rechecked before cancellation is complete.',
    ...params,
  };
}
