import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { execSync } from 'child_process';
import { normalizeTaskId } from './stopTaskExecutionContext.js';
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
}

export { StopTaskExecutionError, stopTaskExecution };
export type {
  StopTaskCancellationReason,
  StopTaskExecutionDeps,
  StopTaskExecutionOptions,
  StopTaskExecutionResult,
};

export function createDockerRoutes(deps: DockerRoutesDeps) {
  const { redisClient } = deps;

  async function getDockerInfo(req: Request, res: Response): Promise<void> {
    try {
      const taskIdValidation = validateTaskId(req.params.taskId);
      if (!taskIdValidation.valid) {
        res.status(400).json({ error: taskIdValidation.error });
        return;
      }

      const taskId = normalizeTaskId(req.params.taskId);
      const stateData = await redisClient.get(`worker:state:${taskId}`);
      if (!stateData) {
        res.status(404).json({ error: 'Task state not found' });
        return;
      }

      const state = JSON.parse(stateData) as { history: Array<{ state: string; metadata?: { containerId?: string; containerName?: string } }> };
      const entry = state.history.find((historyEntry) => historyEntry.state === 'claude_execution' && historyEntry.metadata?.containerId);
      if (!entry?.metadata?.containerId) {
        res.status(404).json({ error: 'No Docker container info available for this task' });
        return;
      }

      res.json(await getContainerInfo(entry.metadata.containerId, entry.metadata.containerName));
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

      const taskId = normalizeTaskId(req.params.taskId);
      const stateData = await redisClient.get(`worker:state:${taskId}`);
      if (!stateData) {
        res.status(404).json({ error: 'Task state not found' });
        return;
      }

      const state = JSON.parse(stateData) as { history: Array<{ state: string; metadata?: { containerId?: string } }> };
      const entry = state.history.find((historyEntry) => historyEntry.state === 'claude_execution' && historyEntry.metadata?.containerId);
      if (!entry?.metadata?.containerId) {
        res.status(404).json({ error: 'No Docker container info available for this task' });
        return;
      }

      try {
        const logsOutput = execSync(`docker logs --tail ${tail} ${entry.metadata.containerId}`, {
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 10 * 1024 * 1024,
        });
        res.setHeader('Content-Type', 'text/plain');
        res.send(logsOutput);
      } catch (err) {
        if ((err as Error).message.includes('No such container')) {
          res.status(404).json({ error: 'Container no longer exists', containerId: entry.metadata.containerId });
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

      const result = await stopTaskExecution(req.params.taskId, {
        redisClient,
        requestedBy: req.user?.username || 'user',
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

async function getContainerInfo(containerId: string, containerName?: string): Promise<Record<string, unknown>> {
  try {
    const statusOutput = execSync(`docker ps -a --filter "id=${containerId}" --format "{{.Status}}"`, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    if (statusOutput) {
      return {
        id: containerId,
        name: containerName,
        status: statusOutput.includes('Up') ? 'running' : 'stopped',
        logsAvailable: true,
      };
    }
    return { id: containerId, name: containerName, status: 'removed', logsAvailable: false };
  } catch (error) {
    console.error('Error getting container info:', error);
    throw new Error(`Failed to get container info: ${(error as Error).message}`);
  }
}
