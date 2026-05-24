import { getActiveTasksForPR, logger, markPullRequestMerged } from '@propr/core';
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

interface MergeTaskCancellationFailure {
  taskId: string;
  status: number | null;
  message: string;
  currentState: string | null;
  queueState: string | null;
}

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
  const persistMergedState = deps.markPullRequestMerged ?? markPullRequestMerged;
  const stopTask = deps.stopTaskExecution ?? stopTaskExecution;
  type ActiveTask = Awaited<ReturnType<typeof loadActiveTasks>>[number];
  const cancellation = {
    code: 'pull_request_merged',
    message: `Task cancelled because pull request #${prNumber} was merged.`,
    source: 'pull_request_merged',
  };

  await persistMergedState(deps.redisClient, repository, prNumber);
  const activeTasks = await loadActiveTasks(repository, prNumber, {
    log,
    forceQueueScan: true,
  });
  const dedupedActiveTasks = dedupeActiveTasks(activeTasks);
  if (dedupedActiveTasks.length === 0) {
    log.info({ correlationId, repository, prNumber }, 'No active PR tasks to cancel after merge');
    return;
  }

  log.info({
    correlationId,
    repository,
    prNumber,
    activeTaskCount: dedupedActiveTasks.length,
    dedupedTaskCount: activeTasks.length - dedupedActiveTasks.length,
  }, 'Cancelling active PR tasks after merge');

  const failures = (await Promise.all(dedupedActiveTasks.map(async (task: ActiveTask) => {
    try {
      await stopTask(task.taskId, {
        redisClient: deps.redisClient,
        requestedBy: 'system',
        cancellation,
      });
      return null;
    } catch (error) {
      if (isAlreadyInactiveStopError(error)) {
        log.info({
          correlationId,
          repository,
          prNumber,
          taskId: task.taskId,
          status: error.status,
          currentState: getStopErrorState(error.body, 'currentState'),
          queueState: getStopErrorState(error.body, 'queueState'),
          error: (error as Error).message,
        }, 'Merged PR task was already inactive during cancellation');
        return null;
      }

      const failure = buildMergeTaskCancellationFailure(task.taskId, error);
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
      return failure;
    }
  }))).filter((failure: MergeTaskCancellationFailure | null): failure is MergeTaskCancellationFailure => failure !== null);

  if (failures.length > 0) {
    throw new Error(`Failed to cancel ${failures.length} merged PR task(s): ${failures.map(formatMergeTaskCancellationFailure).join('; ')}`);
  }
}

function dedupeActiveTasks<T extends { taskId: string }>(tasks: T[]): T[] {
  const dedupedTasks = new Map<string, T>();

  for (const task of tasks) {
    if (!dedupedTasks.has(task.taskId)) {
      dedupedTasks.set(task.taskId, task);
    }
  }

  return [...dedupedTasks.values()];
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

function isAlreadyInactiveStopError(error: unknown): error is StopTaskExecutionError {
  return error instanceof StopTaskExecutionError
    && (error.status === 400 || error.status === 404);
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
