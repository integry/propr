import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { execFileSync } from 'child_process';
import { loadStopTaskContext, type TaskState } from './stopTaskExecutionContext.js';
import { stopTaskExecution, StopTaskExecutionError } from './stopTaskExecution.js';
import type {
  StopTaskCancellationReason,
  StopTaskExecutionDeps,
  StopTaskExecutionOptions,
  StopTaskExecutionResult,
} from './stopTaskExecution.js';
import { validateTaskId, validateTailParam } from './validation.js';

interface DockerRoutesDeps {
  redisClient: RedisClientType;
  loadStopTaskContext?: typeof loadStopTaskContext;
}

export { StopTaskExecutionError, stopTaskExecution };
export type {
  StopTaskCancellationReason,
  StopTaskExecutionDeps,
  StopTaskExecutionOptions,
  StopTaskExecutionResult,
};

export function createDockerRoutes(deps: DockerRoutesDeps) {
  const { redisClient, loadStopTaskContext: loadStopTaskContextOverride } = deps;

  async function getDockerInfo(req: Request, res: Response): Promise<void> {
    try {
      const taskIdValidation = validateTaskId(req.params.taskId);
      if (!taskIdValidation.valid) {
        res.status(400).json({ error: taskIdValidation.error });
        return;
      }

      const containerMetadata = await loadDockerContainerMetadata(
        req.params.taskId,
        redisClient,
        loadStopTaskContextOverride,
      );
      if (!containerMetadata) {
        res.status(404).json({ error: 'Task state not found' });
        return;
      }
      if (!containerMetadata.containerId) {
        res.status(404).json({ error: 'No Docker container info available for this task' });
        return;
      }

      res.json(await getContainerInfo(containerMetadata.containerId, containerMetadata.containerName ?? undefined));
    } catch (error) {
      console.error('Error in /api/task/:taskId/docker-info:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async function getDockerLogs(req: Request, res: Response): Promise<void> {
    try {
      const taskIdValidation = validateTaskId(req.params.taskId);
      if (!taskIdValidation.valid) {
        res.status(400).json({ error: taskIdValidation.error });
        return;
      }

      const tailValidation = validateTailParam(req.query.tail);
      if (!tailValidation.valid) {
        res.status(400).json({ error: tailValidation.error });
        return;
      }
      const tail = tailValidation.value!;

      const containerMetadata = await loadDockerContainerMetadata(
        req.params.taskId,
        redisClient,
        loadStopTaskContextOverride,
      );
      if (!containerMetadata) {
        res.status(404).json({ error: 'Task state not found' });
        return;
      }
      if (!containerMetadata.containerId) {
        res.status(404).json({ error: 'No Docker container info available for this task' });
        return;
      }

      try {
        const logsOutput = execFileSync('docker', ['logs', '--tail', String(tail), containerMetadata.containerId], {
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 10 * 1024 * 1024,
        });
        res.setHeader('Content-Type', 'text/plain');
        res.send(logsOutput);
      } catch (err) {
        if ((err as Error).message.includes('No such container')) {
          res.status(404).json({ error: 'Container no longer exists', containerId: containerMetadata.containerId });
          return;
        }
        throw err;
      }
    } catch (error) {
      console.error('Error in /api/task/:taskId/docker-logs:', error);
      res.status(500).json({ error: 'Internal server error', message: (error as Error).message });
    }
  }

  async function stopTask(req: Request, res: Response): Promise<void> {
    try {
      const taskIdValidation = validateTaskId(req.params.taskId);
      if (!taskIdValidation.valid) {
        res.status(400).json({ error: taskIdValidation.error });
        return;
      }

      const requestedBy = typeof req.user === 'object' && req.user !== null && 'username' in req.user && typeof req.user.username === 'string'
        ? req.user.username
        : 'user';
      const result = await stopTaskExecution(req.params.taskId, {
        redisClient,
        requestedBy,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof StopTaskExecutionError) {
        res.status(error.status).json(error.body);
        return;
      }
      console.error('Error in /api/task/:taskId/stop:', error);
      res.status(500).json({ error: 'Internal server error', message: (error as Error).message });
    }
  }

  return { getDockerInfo, getDockerLogs, stopTask };
}

async function loadDockerContainerMetadata(
  taskReference: string,
  redisClient: Pick<RedisClientType, 'get'>,
  loadContext: typeof loadStopTaskContext = loadStopTaskContext,
): Promise<{ containerId: string | null; containerName: string | null } | null> {
  const context = await loadContext(taskReference, redisClient, {});
  if (!context.state) {
    return null;
  }

  return getDockerContainerMetadata(context.state);
}

function getDockerContainerMetadata(
  state: TaskState,
): { containerId: string | null; containerName: string | null } {
  const entry = [...state.history].reverse().find(
    (historyEntry) => historyEntry.state === 'claude_execution' && historyEntry.metadata?.containerId,
  );
  return {
    containerId: entry?.metadata?.containerId ?? null,
    containerName: entry?.metadata?.containerName ?? null,
  };
}

async function getContainerInfo(containerId: string, containerName?: string): Promise<Record<string, unknown>> {
  try {
    const statusOutput = execFileSync('docker', ['ps', '-a', '--filter', `id=${containerId}`, '--format', '{{.Status}}'], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    if (statusOutput) {
      return {
        id: containerId,
        name: containerName ?? null,
        status: statusOutput.includes('Up') ? 'running' : 'stopped',
        logsAvailable: true,
      };
    }
    return { id: containerId, name: containerName ?? null, status: 'removed', logsAvailable: false };
  } catch (error) {
    console.error('Error getting container info:', error);
    return {
      id: containerId,
      name: containerName ?? null,
      status: 'error',
      logsAvailable: false,
      error: `Failed to get container info: ${(error as Error).message}`,
    };
  }
}
