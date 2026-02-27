import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { execSync } from 'child_process';
import { stopDockerContainer, getStateManager } from '@propr/core';

interface DockerRoutesDeps {
  redisClient: RedisClientType;
}

interface TaskStateHistory {
  state: string;
  metadata?: {
    containerId?: string;
    containerName?: string;
  };
}

interface TaskState {
  history: TaskStateHistory[];
}

export function createDockerRoutes(deps: DockerRoutesDeps) {
  const { redisClient } = deps;

  async function getDockerInfo(req: Request, res: Response): Promise<void> {
    try {
      const taskId = normalizeTaskId(req.params.taskId);
      const stateData = await redisClient.get(`worker:state:${taskId}`);
      if (!stateData) {
        res.status(404).json({ error: 'Task state not found' });
        return;
      }
      const state = JSON.parse(stateData) as { history: Array<{ state: string; metadata?: { containerId?: string; containerName?: string } }> };
      const entry = state.history.find(h => h.state === 'claude_execution' && h.metadata?.containerId);
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
      const taskId = normalizeTaskId(req.params.taskId);
      const { tail = '100' } = req.query;
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
        const logsOutput = execSync(`docker logs --tail ${parseInt(tail as string) || 100} ${entry.metadata.containerId}`, { encoding: 'utf8', timeout: 10000, maxBuffer: 10 * 1024 * 1024 });
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
      const taskId = normalizeTaskId(req.params.taskId);
      console.log(`[stop-execution] Attempting to stop task: ${req.params.taskId} (taskId: ${taskId})`);
      const stateData = await redisClient.get(`worker:state:${taskId}`);
      if (!stateData) {
        res.status(404).json({ error: 'Task not found', message: 'The task may have already completed or does not exist.' });
        return;
      }
      const state = JSON.parse(stateData) as TaskState;
      const currentState = state.history[state.history.length - 1]?.state;
      if (!['processing', 'claude_execution', 'post_processing'].includes(currentState)) {
        res.status(400).json({ error: 'Task is not running', message: 'The task has already completed or is not in an active state.', currentState });
        return;
      }

      // Set abort signal for the worker to pick up
      await redisClient.set(`worker:abort:${taskId}`, JSON.stringify({ timestamp: new Date().toISOString(), requestedBy: req.user?.username || 'user' }), { EX: 3600 });
      await redisClient.rPush(`conversation:${taskId}`, JSON.stringify({ type: 'system', timestamp: new Date().toISOString(), content: 'Stop requested by user. Terminating execution...', level: 'warning' }));
      console.log(`[stop-execution] Abort signal set for task: ${taskId}`);

      // Attempt to directly stop the Docker container if available
      let containerStopped = false;
      const entry = state.history.find(h => h.state === 'claude_execution' && h.metadata?.containerId);
      if (entry?.metadata?.containerId) {
        console.log(`[stop-execution] Found container ID: ${entry.metadata.containerId}, attempting to stop...`);
        const stopResult = await stopDockerContainer(entry.metadata.containerId, 10);
        containerStopped = stopResult.success;
        if (stopResult.success) {
          console.log(`[stop-execution] Container ${entry.metadata.containerId} stopped successfully`);
          await redisClient.rPush(`conversation:${taskId}`, JSON.stringify({ type: 'system', timestamp: new Date().toISOString(), content: 'Docker container terminated.', level: 'info' }));
        } else {
          console.warn(`[stop-execution] Failed to stop container ${entry.metadata.containerId}: ${stopResult.error}`);
        }
      } else {
        console.log(`[stop-execution] No container ID found for task ${taskId}, relying on abort signal`);
      }

      // Clear abort signal after direct container stop
      if (containerStopped) {
        await redisClient.del(`worker:abort:${taskId}`);

        // Mark task as cancelled in state manager
        try {
          const stateManager = getStateManager();
          const cancelledBy = req.user?.username || 'user';
          await stateManager.markTaskCancelled(taskId, cancelledBy, {
            historyMetadata: {
              containerId: entry?.metadata?.containerId,
              stoppedAt: new Date().toISOString()
            }
          });
          console.log(`[stop-execution] Task ${taskId} marked as cancelled`);
          await redisClient.rPush(`conversation:${taskId}`, JSON.stringify({ type: 'system', timestamp: new Date().toISOString(), content: 'Task cancelled successfully.', level: 'info' }));
        } catch (stateError) {
          console.warn(`[stop-execution] Failed to mark task as cancelled: ${(stateError as Error).message}`);
        }
      }

      res.json({
        success: true,
        message: containerStopped
          ? 'Execution stopped. The Docker container has been terminated.'
          : 'Stop request sent to worker. The execution will be terminated shortly.',
        taskId,
        containerStopped
      });
    } catch (error) {
      console.error('Error in /api/task/:taskId/stop:', error);
      res.status(500).json({ error: 'Internal server error', message: (error as Error).message });
    }
  }

  return { getDockerInfo, getDockerLogs, stopTask };
}

function normalizeTaskId(jobId: string): string {
  if (jobId.startsWith('issue-')) {
    const parts = jobId.replace(/^issue-/, '').split('-');
    parts.pop();
    return parts.join('-');
  }
  return jobId;
}

async function getContainerInfo(containerId: string, containerName?: string): Promise<Record<string, unknown>> {
  try {
    const statusOutput = execSync(`docker ps -a --filter "id=${containerId}" --format "{{.Status}}"`, { encoding: 'utf8', timeout: 5000 }).trim();
    if (statusOutput) {
      return { id: containerId, name: containerName, status: statusOutput.includes('Up') ? 'running' : 'stopped', logsAvailable: true };
    }
    return { id: containerId, name: containerName, status: 'removed', logsAvailable: false };
  } catch (err) {
    console.error('Error checking container status:', err);
    return { id: containerId, name: containerName, status: 'error', logsAvailable: false, error: (err as Error).message };
  }
}
