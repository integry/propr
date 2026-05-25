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
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

interface MergeTaskActivity {
  taskId: string;
  state: string;
}

interface MergeTaskCancellationFailure {
  taskId: string;
  status: number | null;
  message: string;
  currentState: string | null;
  queueState: string | null;
}

const MERGE_TASK_STOP_CONCURRENCY = 5;
const MERGE_CANCELLATION_REASON_CODE = 'pull_request_merged';

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
  const cancellation = {
    code: MERGE_CANCELLATION_REASON_CODE,
    message: `Task cancelled because pull request ${repository}#${prNumber} was merged.`,
    source: MERGE_CANCELLATION_REASON_CODE,
  };
  const persistMergedState = deps.markPullRequestMerged ?? markPullRequestMerged;

  const initialTasks = await loadStoppablePrTasks(loadActiveTasks, repository, prNumber, log);
  if (initialTasks.length === 0) {
    await persistMergedState(deps.redisClient, repository, prNumber);
    log.info({ correlationId, repository, prNumber }, 'No active PR tasks to cancel after merge');
    return;
  }

  log.info({
    correlationId,
    repository,
    prNumber,
    activeTaskCount: initialTasks.length,
  }, 'Cancelling active PR tasks after merge');

  const firstAttempt = await stopMergeTasks({
    tasks: initialTasks,
    redisClient: deps.redisClient,
    stopTask,
    cancellation,
    correlationId,
    repository,
    prNumber,
    log,
  });

  const remainingAfterFirstAttempt = await loadBlockingMergeCancellationTasks({
    loadActiveTasks,
    repository,
    prNumber,
    log,
    ignoredTaskIds: firstAttempt.verifiedTaskIds,
  });
  if (remainingAfterFirstAttempt.length === 0) {
    await persistMergedState(deps.redisClient, repository, prNumber);
    return;
  }

  log.info({
    correlationId,
    repository,
    prNumber,
    taskIds: remainingAfterFirstAttempt.map((task) => task.taskId),
  }, 'Retrying tasks that are still active after merged PR cancellation');

  const retryAttempt = await stopMergeTasks({
    tasks: remainingAfterFirstAttempt,
    redisClient: deps.redisClient,
    stopTask,
    cancellation,
    correlationId,
    repository,
    prNumber,
    log,
  });
  const finalActiveTasks = await loadBlockingMergeCancellationTasks({
    loadActiveTasks,
    repository,
    prNumber,
    log,
    ignoredTaskIds: new Set([
      ...firstAttempt.verifiedTaskIds,
      ...retryAttempt.verifiedTaskIds,
    ]),
  });
  if (finalActiveTasks.length === 0) {
    await persistMergedState(deps.redisClient, repository, prNumber);
    return;
  }

  const failures = buildFinalFailures(finalActiveTasks, retryAttempt.failures, firstAttempt.failures);
  throw new Error(`Failed to cancel ${failures.length} merged PR task(s): ${failures.map(formatMergeTaskCancellationFailure).join('; ')}`);
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
  return dedupeTasks(await loadActiveTasks(repository, prNumber, {
    forceQueueScan: true,
    log,
    stoppableOnly: true,
  }));
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
  verifiedTaskIds: Set<string>;
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
  const verifiedTaskIds = new Set<string>();

  for (let index = 0; index < tasks.length; index += MERGE_TASK_STOP_CONCURRENCY) {
    const taskBatch = tasks.slice(index, index + MERGE_TASK_STOP_CONCURRENCY);
    await Promise.all(taskBatch.map(async (task) => {
      try {
        const result = await stopTask(task.taskId, {
          redisClient,
          requestedBy: 'system',
          cancellation,
        });
        if (result.stopVerified) {
          verifiedTaskIds.add(task.taskId);
          verifiedTaskIds.add(result.taskId);
        }
        if (!result.stopVerified) {
          log.info({
            correlationId,
            repository,
            prNumber,
            taskId: task.taskId,
            currentState: result.currentState,
            queueState: result.queueState,
        }, 'Merged PR task stop request accepted and is awaiting worker or queue-state confirmation');
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

  return { failures, verifiedTaskIds };
}

async function loadBlockingMergeCancellationTasks(params: {
  loadActiveTasks: typeof getActiveTasksForPR;
  repository: string;
  prNumber: number;
  log: Pick<typeof logger, 'info' | 'warn' | 'error'>;
  ignoredTaskIds?: ReadonlySet<string>;
}): Promise<MergeTaskActivity[]> {
  const {
    loadActiveTasks,
    repository,
    prNumber,
    log,
    ignoredTaskIds = new Set<string>(),
  } = params;
  return (await loadStoppablePrTasks(loadActiveTasks, repository, prNumber, log))
    .filter((task) => !ignoredTaskIds.has(task.taskId));
}

function buildFinalFailures(
  finalActiveTasks: MergeTaskActivity[],
  retryFailures: Map<string, MergeTaskCancellationFailure>,
  initialFailures: Map<string, MergeTaskCancellationFailure>,
): MergeTaskCancellationFailure[] {
  return finalActiveTasks.map((task) => retryFailures.get(task.taskId)
    ?? initialFailures.get(task.taskId)
    ?? buildUnverifiedStopFailure(task.taskId));
}

function dedupeTasks<T extends { taskId: string }>(tasks: T[]): T[] {
  return [...new Map(tasks.map((task) => [task.taskId, task])).values()];
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
