import {
  getActiveTasksForPR,
  logger,
  markPullRequestMerged,
  TRACKED_PR_QUEUE_STATES,
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

interface MergeTaskCancellationFailure {
  taskId: string;
  status: number | null;
  message: string;
  currentState: string | null;
  queueState: string | null;
}

interface MergeTaskActivity {
  taskId: string;
  state: string;
}

interface MergeTaskCancellationPassResult {
  cancelledTaskIds: string[];
  pendingVerificationTaskIds: string[];
  inactiveTaskIds: string[];
  queuedTaskIds: string[];
  failures: MergeTaskCancellationFailure[];
}

const TRACKED_QUEUE_STATE_SET = new Set<string>(TRACKED_PR_QUEUE_STATES);

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
  const cancellation = {
    code: 'pull_request_merged',
    message: `Task cancelled because pull request #${prNumber} was merged.`,
    source: 'pull_request_merged',
  };

  await persistMergedState(deps.redisClient, repository, prNumber);

  const activeTasks = await loadActiveTasks(repository, prNumber, {
    log,
    stoppableOnly: true,
  });
  const dedupedActiveTasks = dedupeActiveTasks<MergeTaskActivity>(activeTasks);
  if (dedupedActiveTasks.length === 0) {
    log.info({ correlationId, repository, prNumber }, 'No active PR tasks to cancel after merge');
    return;
  }

  log.info({
    correlationId,
    repository,
    prNumber,
    activeTaskCount: dedupedActiveTasks.length,
    duplicatesRemoved: activeTasks.length - dedupedActiveTasks.length,
  }, 'Cancelling active PR tasks after merge');

  const initialPass = await cancelTaskSet({
    tasks: dedupedActiveTasks,
    correlationId,
    repository,
    prNumber,
    redisClient: deps.redisClient,
    stopTask,
    cancellation,
    log,
    allowInactiveRace: true,
    allowPendingVerification: true,
  });
  const failureByTaskId = new Map(initialPass.failures.map((failure) => [failure.taskId, failure]));
  const cancelledTaskIds = new Set(initialPass.cancelledTaskIds);
  const shouldForceQueueScan = initialPass.queuedTaskIds.length > 0;
  const shouldVerifyInactiveTasks = initialPass.inactiveTaskIds.length > 0;
  const shouldVerifyPendingTasks = initialPass.pendingVerificationTaskIds.length > 0;

  if (shouldForceQueueScan || shouldVerifyInactiveTasks || shouldVerifyPendingTasks) {
    log.info({
      correlationId,
      repository,
      prNumber,
      queuedTaskIds: initialPass.queuedTaskIds,
      inactiveStopResponses: initialPass.inactiveTaskIds,
      pendingVerificationTaskIds: initialPass.pendingVerificationTaskIds,
      forcedQueueScan: shouldForceQueueScan,
    }, 'Rechecking merged PR tasks after the initial merge cancellation pass');
    const recheckedActiveTasks = dedupeActiveTasks<MergeTaskActivity>(await loadActiveTasks(repository, prNumber, {
      log,
      ...(shouldForceQueueScan ? { forceQueueScan: true } : {}),
      stoppableOnly: true,
    }));
    const settledTaskIds = new Set(cancelledTaskIds);
    const retryTasks = recheckedActiveTasks.filter((task) => !settledTaskIds.has(task.taskId));

    if (retryTasks.length === 0) {
      log.info({
        correlationId,
        repository,
        prNumber,
        taskIds: [...new Set([
          ...initialPass.inactiveTaskIds,
          ...initialPass.queuedTaskIds,
          ...initialPass.pendingVerificationTaskIds,
        ])],
      }, 'Merged PR recheck confirmed no additional active tasks require cancellation');
    }

    if (retryTasks.length > 0) {
      const retryPass = await cancelTaskSet({
        tasks: retryTasks,
        correlationId,
        repository,
        prNumber,
        redisClient: deps.redisClient,
        stopTask,
        cancellation,
        log,
        allowInactiveRace: false,
        allowPendingVerification: false,
      });

      for (const taskId of retryPass.cancelledTaskIds) {
        cancelledTaskIds.add(taskId);
        failureByTaskId.delete(taskId);
      }
      for (const failure of retryPass.failures) {
        failureByTaskId.set(failure.taskId, failure);
      }
    }
  }

  const failures = [...failureByTaskId.values()];
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

async function cancelTaskSet(params: {
  tasks: MergeTaskActivity[];
  correlationId: string;
  repository: string;
  prNumber: number;
  redisClient: StopTaskExecutionOptions['redisClient'];
  stopTask: typeof stopTaskExecution;
  cancellation: StopTaskExecutionOptions['cancellation'];
  log: Pick<typeof logger, 'info' | 'warn' | 'error'>;
  allowInactiveRace: boolean;
  allowPendingVerification: boolean;
}): Promise<MergeTaskCancellationPassResult> {
  const {
    tasks,
    correlationId,
    repository,
    prNumber,
    redisClient,
    stopTask,
    cancellation,
    log,
    allowInactiveRace,
    allowPendingVerification,
  } = params;
  const queuedTaskIds = tasks
    .filter((task) => TRACKED_QUEUE_STATE_SET.has(task.state))
    .map((task) => task.taskId);
  const results = await Promise.all(tasks.map(async (task) => {
    try {
      const result = await stopTask(task.taskId, {
        redisClient,
        requestedBy: 'system',
        cancellation,
      });
      if (allowPendingVerification && !result.stopVerified) {
        log.info({
          correlationId,
          repository,
          prNumber,
          taskId: task.taskId,
          currentState: result.currentState,
          queueState: result.queueState,
        }, 'Merged PR task stop armed an abort signal but still requires activity verification');
        return { kind: 'pendingVerification' as const, taskId: task.taskId };
      }
      if (!allowPendingVerification && !result.stopVerified) {
        const failure = buildPendingVerificationFailure(task.taskId, result);
        log.warn({
          correlationId,
          repository,
          prNumber,
          taskId: task.taskId,
          status: failure.status,
          currentState: failure.currentState,
          queueState: failure.queueState,
          error: failure.message,
        }, 'Merged PR task remained active after cancellation verification');
        return { kind: 'failure' as const, failure };
      }
      return { kind: 'cancelled' as const, taskId: task.taskId };
    } catch (error) {
      if (allowInactiveRace && isAlreadyInactiveStopError(error)) {
        log.info({
          correlationId,
          repository,
          prNumber,
          taskId: task.taskId,
          status: error.status,
          currentState: getStopErrorState(error.body, 'currentState'),
          queueState: getStopErrorState(error.body, 'queueState'),
          error: (error as Error).message,
        }, 'Merged PR task stop returned an inactive response; verifying with forced queue scan');
        return { kind: 'inactive' as const, taskId: task.taskId };
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
      return { kind: 'failure' as const, failure };
    }
  }));

  return {
    cancelledTaskIds: results
      .filter((result): result is { kind: 'cancelled'; taskId: string } => result.kind === 'cancelled')
      .map((result) => result.taskId),
    pendingVerificationTaskIds: results
      .filter((result): result is { kind: 'pendingVerification'; taskId: string } => result.kind === 'pendingVerification')
      .map((result) => result.taskId),
    inactiveTaskIds: results
      .filter((result): result is { kind: 'inactive'; taskId: string } => result.kind === 'inactive')
      .map((result) => result.taskId),
    queuedTaskIds,
    failures: results
      .filter((result): result is { kind: 'failure'; failure: MergeTaskCancellationFailure } => result.kind === 'failure')
      .map((result) => result.failure),
  };
}

function buildPendingVerificationFailure(
  taskId: string,
  result: Awaited<ReturnType<typeof stopTaskExecution>>,
): MergeTaskCancellationFailure {
  return {
    taskId,
    status: 409,
    message: 'Cancellation was requested, but the task is still active after verification.',
    currentState: result.currentState,
    queueState: result.queueState,
  };
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
