import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { execSync } from 'child_process';
import { stopDockerContainer, getStateManager, getIssueQueue } from '@propr/core';
import { validateTaskId, validateTailParam } from './validation.js';

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

/** Task states in which a worker is actively executing the task. */
const ACTIVE_TASK_STATES = ['processing', 'claude_execution', 'post_processing'];

/** Queue states for jobs that have not started executing yet. */
const PENDING_QUEUE_STATES: Array<'waiting' | 'delayed'> = ['waiting', 'delayed'];

/** Minimal Redis surface needed to stop a task — keeps the helper testable. */
export interface StopTaskRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  rPush(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

interface StoppableQueueJob {
  id?: string;
  remove(): Promise<unknown>;
}

export interface StopTaskQueue {
  getJobs(states: Array<'waiting' | 'delayed'>): Promise<StoppableQueueJob[]>;
}

export interface StopTaskExecutionOptions {
  redisClient: StopTaskRedisClient;
  /** Who requested the stop (username or e.g. 'system'). Defaults to 'user'. */
  requestedBy?: string;
  /** Human-readable cancellation reason, surfaced in the conversation log and task history. */
  reason?: string;
  /** Machine-readable cancellation reason code (e.g. 'pr_merged'), stored in task history metadata. */
  cancellationReason?: string;
  /** Override the BullMQ queue lookup (used by tests). Defaults to getIssueQueue(). */
  getQueue?: () => Promise<StopTaskQueue>;
  /** Override marking the task cancelled (used by tests). Defaults to the shared state manager. */
  markCancelled?: (taskId: string, cancelledBy: string, metadata: { reason?: string; historyMetadata?: Record<string, unknown> }) => Promise<unknown>;
  /** Override the container stop (used by tests). Defaults to stopDockerContainer(). */
  stopContainer?: (containerId: string, timeoutSeconds?: number) => Promise<{ success: boolean; error?: string }>;
}

export interface StopTaskExecutionResult {
  success: boolean;
  taskId: string;
  containerStopped: boolean;
  removedQueuedJobs: number;
  message: string;
  notFound?: boolean;
  notRunning?: boolean;
  currentState?: string;
}

/**
 * Stops a task's execution: signals the worker to abort, terminates the Docker
 * container when one is running, and removes queued/delayed jobs that have not
 * started yet. Shared by the manual stop route and merge-triggered cancellation.
 *
 * Accepts either a task ID or a queue job ID (job IDs are normalized).
 */
async function removeQueuedJobsForTask(taskIdOrJobId: string, taskId: string, options: StopTaskExecutionOptions): Promise<number> {
  let removed = 0;
  try {
    const queue = options.getQueue ? await options.getQueue() : await getIssueQueue();
    const jobs = await queue.getJobs(PENDING_QUEUE_STATES);
    for (const job of jobs) {
      const jobId = job.id != null ? String(job.id) : '';
      if (!jobId) continue;
      if (jobId !== taskIdOrJobId && jobId !== taskId && normalizeTaskId(jobId) !== taskId) continue;
      try {
        await job.remove();
        removed++;
        console.log(`[stop-execution] Removed queued job ${jobId} for task ${taskId}`);
      } catch (removeError) {
        console.warn(`[stop-execution] Failed to remove queued job ${jobId}: ${(removeError as Error).message}`);
      }
    }
  } catch (queueError) {
    console.warn(`[stop-execution] Failed to inspect queue for task ${taskId}: ${(queueError as Error).message}`);
  }
  return removed;
}

async function markTaskCancelledSafely(taskId: string, historyMetadata: Record<string, unknown>, options: StopTaskExecutionOptions): Promise<void> {
  try {
    const mark = options.markCancelled
      ?? ((id: string, by: string, metadata: { reason?: string; historyMetadata?: Record<string, unknown> }) =>
        getStateManager().markTaskCancelled(id, by, metadata));
    await mark(taskId, options.requestedBy ?? 'user', {
      ...(options.reason ? { reason: options.reason } : {}),
      historyMetadata: {
        ...(options.cancellationReason ? { cancellationReason: options.cancellationReason } : {}),
        ...historyMetadata
      }
    });
    console.log(`[stop-execution] Task ${taskId} marked as cancelled`);
    await options.redisClient.rPush(`conversation:${taskId}`, JSON.stringify({ type: 'system', timestamp: new Date().toISOString(), content: 'Task cancelled successfully.', level: 'info' }));
  } catch (stateError) {
    console.warn(`[stop-execution] Failed to mark task as cancelled: ${(stateError as Error).message}`);
  }
}

export async function stopTaskExecution(taskIdOrJobId: string, options: StopTaskExecutionOptions): Promise<StopTaskExecutionResult> {
  const { redisClient } = options;
  const requestedBy = options.requestedBy ?? 'user';
  const stopMessage = options.reason ?? 'Stop requested by user. Terminating execution...';
  const taskId = normalizeTaskId(taskIdOrJobId);

  const removeQueuedJobs = (): Promise<number> => removeQueuedJobsForTask(taskIdOrJobId, taskId, options);
  const markCancelled = (historyMetadata: Record<string, unknown>): Promise<void> => markTaskCancelledSafely(taskId, historyMetadata, options);

  const stateData = await redisClient.get(`worker:state:${taskId}`);
  const state = stateData ? (JSON.parse(stateData) as TaskState) : null;
  const currentState = state?.history[state.history.length - 1]?.state;
  const isRunning = !!currentState && ACTIVE_TASK_STATES.includes(currentState);

  if (!isRunning) {
    // No live container — the task may still have queued or delayed jobs that
    // have not started yet. Remove those before they begin executing.
    const removedQueuedJobs = await removeQueuedJobs();
    if (removedQueuedJobs > 0) {
      if (state) {
        await markCancelled({ removedQueuedJobs });
      }
      return {
        success: true,
        taskId,
        containerStopped: false,
        removedQueuedJobs,
        message: `Removed ${removedQueuedJobs} queued job(s) before execution started.`
      };
    }
    if (!state) {
      return { success: false, taskId, containerStopped: false, removedQueuedJobs: 0, notFound: true, message: 'The task may have already completed or does not exist.' };
    }
    return { success: false, taskId, containerStopped: false, removedQueuedJobs: 0, notRunning: true, currentState, message: 'The task has already completed or is not in an active state.' };
  }

  // Set abort signal for the worker to pick up
  await redisClient.set(`worker:abort:${taskId}`, JSON.stringify({
    timestamp: new Date().toISOString(),
    requestedBy,
    ...(options.cancellationReason ? { reason: options.cancellationReason } : {})
  }), { EX: 3600 });
  await redisClient.rPush(`conversation:${taskId}`, JSON.stringify({ type: 'system', timestamp: new Date().toISOString(), content: stopMessage, level: 'warning' }));
  console.log(`[stop-execution] Abort signal set for task: ${taskId}`);

  const containerId = await stopRunningTaskContainer(taskId, state!, options);
  const containerStopped = containerId !== null;

  // Remove any queued/delayed jobs for the same task (e.g. pending retries)
  const removedQueuedJobs = await removeQueuedJobs();

  // Clear abort signal after direct container stop
  if (containerStopped) {
    await redisClient.del(`worker:abort:${taskId}`);
    await markCancelled({ containerId, stoppedAt: new Date().toISOString() });
  }

  return {
    success: true,
    taskId,
    containerStopped,
    removedQueuedJobs,
    message: containerStopped
      ? 'Execution stopped. The Docker container has been terminated.'
      : 'Stop request sent to worker. The execution will be terminated shortly.'
  };
}

/**
 * Attempts to directly stop the Docker container of a running task.
 * Returns the container ID when the container was stopped, null otherwise.
 */
async function stopRunningTaskContainer(taskId: string, state: TaskState, options: StopTaskExecutionOptions): Promise<string | null> {
  const entry = state.history.find(h => h.state === 'claude_execution' && h.metadata?.containerId);
  const containerId = entry?.metadata?.containerId;
  if (!containerId) {
    console.log(`[stop-execution] No container ID found for task ${taskId}, relying on abort signal`);
    return null;
  }

  console.log(`[stop-execution] Found container ID: ${containerId}, attempting to stop...`);
  const stopContainer = options.stopContainer ?? stopDockerContainer;
  const stopResult = await stopContainer(containerId, 10);
  if (!stopResult.success) {
    console.warn(`[stop-execution] Failed to stop container ${containerId}: ${stopResult.error}`);
    return null;
  }

  console.log(`[stop-execution] Container ${containerId} stopped successfully`);
  await options.redisClient.rPush(`conversation:${taskId}`, JSON.stringify({ type: 'system', timestamp: new Date().toISOString(), content: 'Docker container terminated.', level: 'info' }));
  return containerId;
}

export function createDockerRoutes(deps: DockerRoutesDeps) {
  const { redisClient } = deps;

  async function getDockerInfo(req: Request, res: Response): Promise<void> {
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
        const logsOutput = execSync(`docker logs --tail ${tail} ${entry.metadata.containerId}`, { encoding: 'utf8', timeout: 10000, maxBuffer: 10 * 1024 * 1024 });
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
      // Validate taskId parameter
      const taskIdValidation = validateTaskId(req.params.taskId);
      if (!taskIdValidation.valid) {
        res.status(400).json({ error: taskIdValidation.error });
        return;
      }

      console.log(`[stop-execution] Attempting to stop task: ${req.params.taskId}`);
      const result = await stopTaskExecution(req.params.taskId, {
        redisClient,
        requestedBy: req.user?.username || 'user'
      });

      if (result.notFound) {
        res.status(404).json({ error: 'Task not found', message: result.message });
        return;
      }
      if (result.notRunning) {
        res.status(400).json({ error: 'Task is not running', message: result.message, currentState: result.currentState });
        return;
      }

      res.json({
        success: true,
        message: result.message,
        taskId: result.taskId,
        containerStopped: result.containerStopped
      });
    } catch (error) {
      console.error('Error in /api/task/:taskId/stop:', error);
      res.status(500).json({ error: 'Internal server error', message: (error as Error).message });
    }
  }

  return { getDockerInfo, getDockerLogs, stopTask };
}

export function normalizeTaskId(jobId: string): string {
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
