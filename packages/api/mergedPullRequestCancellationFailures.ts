import { isStopTaskExecutionError } from './routes/stopTaskExecution.js';
import type { MergeTaskCancellationFailure } from './mergedPullRequestCancellation.js';

const MAX_FAILURE_DETAILS_IN_ERROR = 10;

export function buildMergeTaskCancellationFailure(taskId: string, error: unknown): MergeTaskCancellationFailure {
  const stopError = getStopTaskExecutionError(error);
  if (stopError) {
    return {
      taskId,
      status: stopError.status,
      message: stopError.message,
      currentState: getStopErrorState(stopError.body, 'currentState'),
      queueState: getStopErrorState(stopError.body, 'queueState'),
    };
  }

  return {
    taskId,
    status: null,
    message: error instanceof Error ? error.message : String(error),
    currentState: null,
    queueState: null,
  };
}

export function buildUnverifiedStopFailure(
  taskId: string,
  currentState: string | null,
  queueState: string | null,
): MergeTaskCancellationFailure {
  return {
    taskId,
    status: 202,
    message: 'Stop request was recorded; worker or queue-state confirmation is still pending.',
    currentState,
    queueState,
    stopRequested: true,
  };
}

export function formatMergedTaskCancellationWarning(failures: MergeTaskCancellationFailure[]): string {
  if (failures.length === 0) {
    return 'Merged PR task cancellation completed with no remaining unverified tasks.';
  }

  const visibleFailures = failures.slice(0, MAX_FAILURE_DETAILS_IN_ERROR);
  const hiddenFailureCount = failures.length - visibleFailures.length;
  const suffix = hiddenFailureCount > 0
    ? `; ...and ${hiddenFailureCount} more`
    : '';
  return `Merged PR task cancellation is awaiting verification for ${failures.length} task(s): ${visibleFailures.map(formatMergeTaskCancellationFailure).join('; ')}${suffix}`;
}

function getStopTaskExecutionError(error: unknown): {
  status: number;
  body: Record<string, unknown>;
  message: string;
} | null {
  if (isStopTaskExecutionError(error)) {
    return {
      status: error.status,
      body: error.body,
      message: typeof error.message === 'string' ? error.message : 'Task stop failed',
    };
  }
  return null;
}

function formatMergeTaskCancellationFailure(failure: MergeTaskCancellationFailure): string {
  const status = failure.status === null ? 'unknown' : String(failure.status);
  const stateDetails = [
    failure.currentState ? `currentState=${failure.currentState}` : null,
    failure.queueState ? `queueState=${failure.queueState}` : null,
  ].filter((detail): detail is string => detail !== null);

  if (stateDetails.length > 0) {
    return `${failure.taskId} (status ${status}, ${stateDetails.join(', ')}: ${failure.message})`;
  }

  return `${failure.taskId} (status ${status}: ${failure.message})`;
}

function getStopErrorState(body: Record<string, unknown>, key: 'currentState' | 'queueState'): string | null {
  return typeof body[key] === 'string' ? body[key] : null;
}
