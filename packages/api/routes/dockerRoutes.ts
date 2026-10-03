import type { Response } from 'express';
import type { FlatRequest } from '../requestTypes.js';
import { RedisClientType } from 'redis';
import { stopTaskExecution, normalizeTaskId } from '@propr/core';
export { stopTaskExecution, normalizeTaskId, type StopTaskQueue, type StopTaskRedisClient, type StopTaskExecutionOptions, type StopTaskExecutionResult } from '@propr/core';
import { validateTaskId, validateTailParam } from './validation.js';
import { getDockerContainerLogs, getDockerContainerStatus } from './dockerCommandSafety.js';

type StopTaskExecutor = typeof stopTaskExecution;

interface DockerRoutesDeps {
  redisClient: RedisClientType;
  stopTaskExecution?: StopTaskExecutor;
}

export function createDockerRoutes(deps: DockerRoutesDeps) {
  const { redisClient } = deps;
  const executeStopTask = deps.stopTaskExecution ?? stopTaskExecution;

  async function getDockerInfo(req: FlatRequest, res: Response): Promise<void> {
    try {
      // Validate taskId parameter
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
      const entry = state.history.findLast(h => h.state === 'claude_execution' && h.metadata?.containerId);
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

  async function getDockerLogs(req: FlatRequest, res: Response): Promise<void> {
    try {
      // Validate taskId parameter
      const taskIdValidation = validateTaskId(req.params.taskId);
      if (!taskIdValidation.valid) {
        res.status(400).json({ error: taskIdValidation.error });
        return;
      }

      // Validate tail parameter
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
      const entry = state.history.find(h => h.state === 'claude_execution' && h.metadata?.containerId);
      if (!entry?.metadata?.containerId) {
        res.status(404).json({ error: 'No Docker container info available for this task' });
        return;
      }
      try {
        const logsOutput = getDockerContainerLogs(entry.metadata.containerId, tail);
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

  async function stopTask(req: FlatRequest, res: Response): Promise<void> {
    try {
      // Validate taskId parameter
      const taskIdValidation = validateTaskId(req.params.taskId);
      if (!taskIdValidation.valid) {
        res.status(400).json({ error: taskIdValidation.error });
        return;
      }

      console.log(`[stop-execution] Attempting to stop task: ${req.params.taskId}`);
      const result = await executeStopTask(req.params.taskId, { redisClient, requestedBy: req.user?.username || 'user', ensureCancelled: true, cancellationReason: 'cancelled_by_user' });

      if (result.notFound) {
        res.status(404).json({ error: 'Task not found', message: result.message });
        return;
      }
      if (result.notRunning) {
        res.status(400).json({ error: 'Task is not running', message: result.message, currentState: result.currentState });
        return;
      }

      res.json({ success: true, message: result.message, taskId: result.taskId, containerStopped: result.containerStopped });
    } catch {
      console.error('Error in /api/task/:taskId/stop');
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  return { getDockerInfo, getDockerLogs, stopTask };
}

async function getContainerInfo(containerId: string, containerName?: string): Promise<Record<string, unknown>> {
  try {
    const statusOutput = getDockerContainerStatus(containerId);
    if (statusOutput) {
      return { id: containerId, name: containerName, status: statusOutput.includes('Up') ? 'running' : 'stopped', logsAvailable: true };
    }
    return { id: containerId, name: containerName, status: 'removed', logsAvailable: false };
  } catch (err) {
    console.error('Error checking container status:', err);
    return { id: containerId, name: containerName, status: 'error', logsAvailable: false, error: (err as Error).message };
  }
}
