import {
  getActiveTasksForPR,
  logger,
  markPullRequestMerged,
} from '@propr/core';
import {
  StopTaskExecutionError,
  stopTaskExecution,
  type StopTaskExecutionOptions,
} from './routes/stopTaskExecution.js';

interface MergedPullRequestPayload {
  action: 'closed';
  repository: { full_name: string };
  pull_request: { number: number; merged: true };
}

export interface MergeTaskCancellationDeps {
  redisClient: StopTaskExecutionOptions['redisClient'];
  getActiveTasksForPR?: typeof getActiveTasksForPR;
  markPullRequestMerged?: typeof markPullRequestMerged;
  stopTaskExecution?: typeof stopTaskExecution;
  sleep?: (durationMs: number) => Promise<void>;
  recheckDelayMs?: number;
  recheckDelaysMs?: readonly number[];
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

interface MergeTaskActivity {
  taskId: string;
}

interface MergeTaskCancellationFailure {
  taskId: string;
  status: number | null;
  message: string;
  currentState: string | null;
  queueState: string | null;
}

const MERGE_TASK_STOP_CONCURRENCY = 5;
const MERGE_TASK_CONTAINER_STOP_TIMEOUT_SECONDS = 30;
const MERGE_TASK_RECHECK_DELAYS_MS = [1000, 3000, 5000] as const;
const MERGE_CANCELLATION_REASON_CODE = 'pull_request_merged';
const MAX_FAILURE_DETAILS_IN_ERROR = 10;

export async function cancelMergedPullRequestTasks(
  payload: Record<string, unknown>,
  correlationId: string,
  deps: MergeTaskCancellationDeps,
): Promise<void> {
  if (!deps?.redisClient) {
    throw new Error('Merge task cancellation dependencies are required');
  }

  if (!isMergedPullRequestClose(payload)) {
    return;
  }

  const repository = payload.repository.full_name;
  const prNumber = payload.pull_request.number;
  const log = deps.log ?? logger;
  const loadActiveTasks = deps.getActiveTasksForPR ?? getActiveTasksForPR;
  const stopTask = deps.stopTaskExecution ?? stopTaskExecution;
  const persistMergedState = deps.markPullRequestMerged ?? markPullRequestMerged;
  const sleep = deps.sleep ?? delay;
  const recheckDelaysMs = getRecheckDelays(deps.recheckDelaysMs, deps.recheckDelayMs);
  const cancellation = {
    code: MERGE_CANCELLATION_REASON_CODE,
    message: `Task cancelled because pull request ${repository}#${prNumber} was merged.`,
    source: MERGE_CANCELLATION_REASON_CODE,
    requestId: `${correlationId}:${MERGE_CANCELLATION_REASON_CODE}:${repository}#${prNumber}`,
  };

  // Persist the merge gate before cancellation so no new PR work starts while
  // the existing task shutdown and rechecks are still in flight.
  await persistMergedState(deps.redisClient, repository, prNumber);

  const initialTasks = await loadStoppablePrTasks(loadActiveTasks, repository, prNumber, log);
  if (initialTasks.length === 0) {
    log.info({ correlationId, repository, prNumber }, 'No active PR tasks to cancel after merge');
    return;
  }

  log.info({
    correlationId,
    repository,
    prNumber,
    activeTaskCount: initialTasks.length,
  }, 'Cancelling active PR tasks after merge');

  let remainingTasks = initialTasks;
  const failuresByTaskId = new Map<string, MergeTaskCancellationFailure>();

  for (let attemptIndex = 0; attemptIndex < recheckDelaysMs.length; attemptIndex += 1) {
    const attempt = await stopMergeTasks({
      tasks: remainingTasks,
      redisClient: deps.redisClient,
      stopTask,
      cancellation,
      correlationId,
      repository,
      prNumber,
      log,
    });
    mergeFailures(failuresByTaskId, attempt.failures);

    if (attemptIndex < recheckDelaysMs.length - 1) {
      await sleep(recheckDelaysMs[attemptIndex]);
    }
    remainingTasks = await loadStoppablePrTasks(loadActiveTasks, repository, prNumber, log);
    if (remainingTasks.length === 0) {
      return;
    }

    if (attemptIndex < recheckDelaysMs.length - 1) {
      log.info({
        correlationId,
        repository,
        prNumber,
        taskIds: remainingTasks.map((task) => task.taskId),
      }, 'Retrying tasks that are still active after merged PR cancellation');
    }
  }

  const failures = buildFinalFailures(remainingTasks, failuresByTaskId);
  const errorMessage = formatMergedTaskCancellationError(failures);
  log.warn({
    correlationId,
    repository,
    prNumber,
    failures,
  }, errorMessage);
  throw new Error(errorMessage);
}

function getRecheckDelays(recheckDelaysMs?: readonly number[], recheckDelayMs?: number): readonly number[] {
  if (recheckDelaysMs !== undefined) {
    return recheckDelaysMs;
  }

  if (recheckDelayMs !== undefined) {
    return MERGE_TASK_RECHECK_DELAYS_MS.map(() => recheckDelayMs);
  }

  return MERGE_TASK_RECHECK_DELAYS_MS;
}

function mergeFailures(
  failuresByTaskId: Map<string, MergeTaskCancellationFailure>,
  nextFailures: Map<string, MergeTaskCancellationFailure>,
): void {
  for (const [taskId, failure] of nextFailures.entries()) {
    failuresByTaskId.set(taskId, failure);
  }
}

async function stopMergeTasks(params: {
  tasks: MergeTaskActivity[];
  redisClient: StopTaskExecutionOptions['redisClient'];
  stopTask: typeof stopTaskExecution;
  cancellation: StopTaskExecutionOptions['cancellation'];
  correlationId: string;
  repository: string;
  prNumber: number;
  log: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}): Promise<{
  failures: Map<string, MergeTaskCancellationFailure>;
}> {
  const {
    tasks,
    redisClient,
    stopTask,
    cancellation,
    correlationId,
    repository,
    prNumber,
    log,
  } = params;
  const failures = new Map<string, MergeTaskCancellationFailure>();

  for (let index = 0; index < tasks.length; index += MERGE_TASK_STOP_CONCURRENCY) {
    const taskBatch = tasks.slice(index, index + MERGE_TASK_STOP_CONCURRENCY);
    await Promise.all(taskBatch.map(async (task) => {
      try {
        const taskCancellation = buildTaskCancellation(cancellation, task.taskId);
        const result = await stopTask(task.taskId, {
          redisClient,
          requestedBy: 'system',
          cancellation: taskCancellation,
          containerStopTimeoutSeconds: MERGE_TASK_CONTAINER_STOP_TIMEOUT_SECONDS,
          forceQueueScan: true,
          requireVerifiedStop: false,
        });
        if (!result.stopVerified) {
          log.info({
            correlationId,
            repository,
            prNumber,
            taskId: task.taskId,
            currentState: result.currentState,
            queueState: result.queueState,
          }, 'Merged PR task stop request accepted and is awaiting worker or queue-state confirmation');
          failures.set(task.taskId, {
            taskId: task.taskId,
            status: 409,
            message: 'Task stop request was accepted but not yet verified.',
            currentState: result.currentState,
            queueState: result.queueState,
          });
        }
      } catch (error) {
        const failure = buildMergeTaskCancellationFailure(task.taskId, error);
        failures.set(task.taskId, failure);
        log.warn({
          correlationId,
          repository,
          prNumber,
          taskId: task.taskId,
          status: failure.status,
          currentState: failure.currentState,
          queueState: failure.queueState,
          error: failure.message,
        }, 'Failed to cancel merged PR task');
      }
    }));
  }

  return { failures };
}

export function isMergedPullRequestClose(payload: unknown): payload is MergedPullRequestPayload {
  const prPayload = payload as Partial<MergedPullRequestPayload> & {
    repository?: { full_name?: string };
    pull_request?: { number?: number; merged?: boolean };
  };

  return prPayload.action === 'closed'
    && typeof prPayload.repository?.full_name === 'string'
    && typeof prPayload.pull_request?.number === 'number'
    && prPayload.pull_request?.merged === true;
}

async function loadStoppablePrTasks(
  loadActiveTasks: typeof getActiveTasksForPR,
  repository: string,
  prNumber: number,
  log: Pick<typeof logger, 'info' | 'warn' | 'error'>,
): Promise<MergeTaskActivity[]> {
  try {
    return dedupeTasks(await loadActiveTasks(repository, prNumber, {
      forceQueueScan: true,
      log,
      stoppableOnly: true,
    }));
  } catch (error) {
    log.error({
      repository,
      prNumber,
      error: error instanceof Error ? error.message : String(error),
    }, 'Failed to load active PR tasks during merged PR cancellation');
    throw error;
  }
}

async function delay(durationMs: number): Promise<void> {
  if (durationMs <= 0) {
    return;
  }

  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function buildFinalFailures(
  finalActiveTasks: MergeTaskActivity[],
  failuresByTaskId: Map<string, MergeTaskCancellationFailure>,
): MergeTaskCancellationFailure[] {
  return finalActiveTasks.map((task) => failuresByTaskId.get(task.taskId)
    ?? buildUnverifiedStopFailure(task.taskId));
}

function dedupeTasks<T extends { taskId: string }>(tasks: T[]): T[] {
  return [...new Map(tasks.map((task) => [task.taskId, task])).values()];
}

function buildTaskCancellation(
  cancellation: StopTaskExecutionOptions['cancellation'],
  taskId: string,
): StopTaskExecutionOptions['cancellation'] {
  if (!cancellation?.requestId) {
    return cancellation;
  }

  return {
    ...cancellation,
    requestId: `${cancellation.requestId}:${taskId}`,
  };
}

function buildMergeTaskCancellationFailure(taskId: string, error: unknown): MergeTaskCancellationFailure {
  if (error instanceof StopTaskExecutionError) {
    return {
      taskId,
      status: error.status,
      message: error.message,
      currentState: getStopErrorState(error.body, 'currentState'),
      queueState: getStopErrorState(error.body, 'queueState'),
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

function buildUnverifiedStopFailure(taskId: string): MergeTaskCancellationFailure {
  return {
    taskId,
    status: 409,
    message: 'Task remained active after retrying the merge-time cancellation.',
    currentState: null,
    queueState: null,
  };
}

function formatMergedTaskCancellationError(failures: MergeTaskCancellationFailure[]): string {
  const visibleFailures = failures.slice(0, MAX_FAILURE_DETAILS_IN_ERROR);
  const hiddenFailureCount = failures.length - visibleFailures.length;
  const suffix = hiddenFailureCount > 0
    ? `; ...and ${hiddenFailureCount} more`
    : '';
  return `Failed to cancel ${failures.length} merged PR task(s): ${visibleFailures.map(formatMergeTaskCancellationFailure).join('; ')}${suffix}`;
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
