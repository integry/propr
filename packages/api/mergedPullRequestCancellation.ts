import { getActiveTasksForPR, logger, markPullRequestMerged } from '@propr/core';
import {
  StopTaskExecutionError,
  stopTaskExecution,
  type StopTaskExecutionOptions,
} from './routes/dockerRoutes.js';

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
  log?: Pick<typeof logger, 'info' | 'warn'>;
}

export async function cancelMergedPullRequestTasks(
  payload: Record<string, unknown>,
  correlationId: string,
  deps?: MergeTaskCancellationDeps,
): Promise<void> {
  if (!deps || !isMergedPullRequestClose(payload)) {
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
  };

  await persistMergedState(deps.redisClient, repository, prNumber);
  const activeTasks = await loadActiveTasks(repository, prNumber);
  if (activeTasks.length === 0) {
    log.info({ correlationId, repository, prNumber }, 'No active PR tasks to cancel after merge');
    return;
  }

  log.info({ correlationId, repository, prNumber, activeTaskCount: activeTasks.length }, 'Cancelling active PR tasks after merge');

  const failures = (await Promise.all(activeTasks.map(async (task) => {
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
          error: (error as Error).message,
        }, 'Merged PR task was already inactive during cancellation');
        return null;
      }

      log.warn({
        correlationId,
        repository,
        prNumber,
        taskId: task.taskId,
        error: (error as Error).message,
      }, 'Failed to cancel merged PR task');
      return task.taskId;
    }
  }))).filter((taskId): taskId is string => taskId !== null);

  if (failures.length > 0) {
    throw new Error(`Failed to cancel ${failures.length} merged PR task(s): ${failures.join(', ')}`);
  }
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

function isAlreadyInactiveStopError(error: unknown): boolean {
  return error instanceof StopTaskExecutionError
    && (error.status === 400 || error.status === 404);
}
