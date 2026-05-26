import {
  getActiveTasksForPR,
  logger,
  markPullRequestMerged,
} from '@propr/core';
import { stopTaskExecution, type StopTaskExecutionOptions } from './routes/stopTaskExecution.js';
import { persistMergedCancellationFailures } from './mergedPullRequestCancellationPersistence.js';
import {
  buildMergeTaskCancellationFailure,
  buildUnverifiedStopFailure,
  formatMergedTaskCancellationWarning,
} from './mergedPullRequestCancellationFailures.js';
import {
  buildMergeCancellationRequestId,
  buildTaskCancellation,
} from './mergedPullRequestCancellationRequest.js';

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
  state?: string;
}

export interface MergeTaskCancellationFailure {
  taskId: string;
  status: number | null;
  message: string;
  currentState: string | null;
  queueState: string | null;
  abortRequestedOnly?: boolean;
}

const MERGE_TASK_STOP_CONCURRENCY = 5;
const MERGE_TASK_CONTAINER_STOP_TIMEOUT_SECONDS = 30;
const MERGE_TASK_RECHECK_DELAYS_MS = [500, 1500, 3000] as const;
const MERGE_CANCELLATION_REASON_CODE = 'pull_request_merged';

export async function cancelMergedPullRequestTasks(
  payload: Record<string, unknown>,
  correlationId: string,
  deps: MergeTaskCancellationDeps,
): Promise<void> {
  if (!isMergedPullRequestClose(payload)) {
    return;
  }

  if (!deps?.redisClient) {
    throw new Error('Merge task cancellation dependencies are required');
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
    requestId: buildMergeCancellationRequestId(repository, prNumber),
  };

  // Try to persist the merge gate before cancellation so no new PR work starts
  // while shutdown and rechecks are still in flight. Cancellation still runs if
  // this write fails, because the existing active work is already stale.
  const mergedStateError = await persistMergedStateBestEffort({
    persistMergedState,
    redisClient: deps.redisClient,
    repository,
    prNumber,
    correlationId,
    log,
  });

  const initialTasks = await loadStoppablePrTasks({
    loadActiveTasks,
    repository,
    prNumber,
    log,
    forceQueueScan: true,
  });
  if (initialTasks.length === 0) {
    logMergedStatePersistenceWarning(mergedStateError, {
      correlationId,
      repository,
      prNumber,
      log,
    });
    throwMergedStatePersistenceErrorIfAny(mergedStateError);
    log.info({ correlationId, repository, prNumber }, 'No active PR tasks to cancel after merge');
    return;
  }

  log.info({
    correlationId,
    repository,
    prNumber,
    activeTaskCount: initialTasks.length,
  }, 'Cancelling active PR tasks after merge');

  const failuresByTaskId = new Map<string, MergeTaskCancellationFailure>();

  const attempt = await stopMergeTasks({
    tasks: initialTasks,
    redisClient: deps.redisClient,
    stopTask,
    cancellation,
    correlationId,
    repository,
    prNumber,
    log,
  });
  mergeFailures(failuresByTaskId, attempt.failures);

  let remainingTasks = initialTasks;
  for (const recheckDelayMs of recheckDelaysMs) {
    await sleep(recheckDelayMs);
    remainingTasks = await loadStoppablePrTasks({
      loadActiveTasks,
      repository,
      prNumber,
      log,
      forceQueueScan: false,
    });
    clearResolvedFailures(failuresByTaskId, remainingTasks);
    if (remainingTasks.length === 0) {
      logMergedStatePersistenceWarning(mergedStateError, {
        correlationId,
        repository,
        prNumber,
        log,
      });
      throwMergedStatePersistenceErrorIfAny(mergedStateError);
      return;
    }
  }

  const failures = buildFinalFailures(remainingTasks, failuresByTaskId);
  const errorMessage = formatMergedTaskCancellationWarning(failures);
  log.warn({
    correlationId,
    repository,
    prNumber,
    failures,
  }, errorMessage);
  await persistMergedCancellationFailures({
    redisClient: deps.redisClient,
    repository,
    prNumber,
    correlationId,
    failures,
    log,
  });
  logMergedStatePersistenceWarning(mergedStateError, {
    correlationId,
    repository,
    prNumber,
    log,
  });
  throwMergedStatePersistenceErrorIfAny(mergedStateError);
  throw new Error(`Failed to cancel ${failures.length} merged PR task(s): ${formatMergedTaskCancellationWarning(failures)}`);
}

function getRecheckDelays(recheckDelaysMs?: readonly number[], recheckDelayMs?: number): readonly number[] {
  if (recheckDelaysMs !== undefined) {
    return recheckDelaysMs;
  }

  if (recheckDelayMs !== undefined) {
    return [recheckDelayMs];
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

function clearResolvedFailures(
  failuresByTaskId: Map<string, MergeTaskCancellationFailure>,
  remainingTasks: MergeTaskActivity[],
): void {
  const remainingTaskIds = new Set(remainingTasks.map((task) => task.taskId));
  for (const taskId of failuresByTaskId.keys()) {
    if (!remainingTaskIds.has(taskId)) {
      failuresByTaskId.delete(taskId);
    }
  }
}

async function persistMergedStateBestEffort(params: {
  persistMergedState: typeof markPullRequestMerged;
  redisClient: StopTaskExecutionOptions['redisClient'];
  repository: string;
  prNumber: number;
  correlationId: string;
  log: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}): Promise<Error | null> {
  const {
    persistMergedState,
    redisClient,
    repository,
    prNumber,
    correlationId,
    log,
  } = params;

  try {
    await persistMergedState(redisClient, repository, prNumber);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({
      correlationId,
      repository,
      prNumber,
      error: message,
    }, 'Failed to persist merged PR gate before cancellation');
    return new Error(`failed to persist merged PR gate: ${message}`);
  }
}

function logMergedStatePersistenceWarning(error: Error | null, params: {
  correlationId: string;
  repository: string;
  prNumber: number;
  log: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}): void {
  if (!error) {
    return;
  }

  params.log.warn({
    correlationId: params.correlationId,
    repository: params.repository,
    prNumber: params.prNumber,
    error: error.message,
  }, 'Merged PR gate persistence failed; cancellation webhook will fail after best-effort task cancellation');
}

function throwMergedStatePersistenceErrorIfAny(error: Error | null): void {
  if (error) {
    throw error;
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
          forceQueueScan: shouldForceQueueScanForMergeTask(task),
          requireVerifiedStop: true,
        }, {
          cancellationTarget: { repository, prNumber },
        });
        if (!result.stopVerified) {
          const failure = buildUnverifiedStopFailure(task.taskId, result.currentState, result.queueState);
          failures.set(task.taskId, failure);
          log.warn({
            correlationId,
            repository,
            prNumber,
            taskId: task.taskId,
            currentState: result.currentState,
            queueState: result.queueState,
          }, 'Merged PR task stop request is still awaiting worker or queue-state confirmation');
          return;
        }
        log.info({
          correlationId,
          repository,
          prNumber,
          taskId: task.taskId,
          currentState: result.currentState,
          queueState: result.queueState,
        }, 'Merged PR task stop verified');
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

async function loadStoppablePrTasks(params: {
  loadActiveTasks: typeof getActiveTasksForPR;
  repository: string;
  prNumber: number;
  log: Pick<typeof logger, 'info' | 'warn' | 'error'>;
  forceQueueScan: boolean;
}): Promise<MergeTaskActivity[]> {
  const {
    loadActiveTasks,
    repository,
    prNumber,
    log,
    forceQueueScan,
  } = params;
  try {
    return dedupeTasks(await loadActiveTasks(repository, prNumber, {
      forceQueueScan,
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
    ?? buildUnverifiedStopFailure(task.taskId, null, null));
}

function dedupeTasks<T extends { taskId: string }>(tasks: T[]): T[] {
  return [...new Map(tasks.map((task) => [task.taskId, task])).values()];
}

function shouldForceQueueScanForMergeTask(task: MergeTaskActivity): boolean {
  return task.state !== undefined && [
    'waiting',
    'active',
    'delayed',
    'paused',
    'prioritized',
    'waiting-children',
  ].includes(task.state);
}
