/* eslint-disable max-lines */
import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import type { Job } from 'bullmq';
import { execSync } from 'child_process';
import { stopDockerContainer, getStateManager, getIssueQueue, db } from '@propr/core';
import type { IssueRef } from '@propr/core';
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

type RedisClientLike = Pick<RedisClientType, 'get' | 'set' | 'del' | 'rPush'>;

type QueueJobData = Record<string, unknown>;

interface StopTaskContext {
  normalizedTaskId: string;
  state: TaskState | null;
  currentState: string | null;
  queueJob: Job<QueueJobData> | null;
  queueState: string | null;
  stateTaskId: string;
}

interface StopTaskActivity {
  isRunningTaskState: boolean;
  isNonTerminalTaskState: boolean;
  isQueueActive: boolean;
  isQueueRemovable: boolean;
}

export interface StopTaskCancellationReason {
  code: string;
  message: string;
}

export interface StopTaskExecutionOptions {
  redisClient: RedisClientLike;
  requestedBy?: string;
  cancellation?: StopTaskCancellationReason;
}

export interface StopTaskExecutionResult {
  success: true;
  message: string;
  taskId: string;
  containerStopped: boolean;
  jobRemoved: boolean;
  currentState: string | null;
  queueState: string | null;
  cancellation: StopTaskCancellationReason;
}

export class StopTaskExecutionError extends Error {
  status: number;
  body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : 'Task stop failed');
    this.name = 'StopTaskExecutionError';
    this.status = status;
    this.body = body;
  }
}

const RUNNING_TASK_STATES = new Set(['processing', 'claude_execution', 'post_processing']);
const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'cancelled']);
const REMOVABLE_QUEUE_STATES = new Set(['waiting', 'delayed']);
const DEFAULT_STOP_REASON: StopTaskCancellationReason = {
  code: 'user_requested_stop',
  message: 'Task cancelled by user request.',
};

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

function normalizeTaskId(jobId: string): string {
  if (jobId.startsWith('issue-')) {
    const parts = jobId.replace(/^issue-/, '').split('-');
    parts.pop();
    return parts.join('-');
  }
  return jobId;
}

export async function stopTaskExecution(taskReference: string, options: StopTaskExecutionOptions): Promise<StopTaskExecutionResult> {
  const { redisClient, requestedBy = 'user', cancellation = DEFAULT_STOP_REASON } = options;
  const context = await loadStopTaskContext(taskReference, redisClient);
  const activity = getStopTaskActivity(context.currentState, context.queueState);

  assertTaskCanBeStopped(context, activity);

  const timestamp = new Date().toISOString();
  await setAbortSignalIfNeeded({
    redisClient,
    taskId: context.stateTaskId,
    requestedBy,
    cancellation,
    timestamp,
    shouldAbort: activity.isRunningTaskState || activity.isQueueActive,
  });

  const { containerId, containerStopped } = await stopTaskContainer({
    redisClient,
    taskId: context.stateTaskId,
    state: context.state,
    shouldAbort: activity.isRunningTaskState || activity.isQueueActive,
  });

  const jobRemoved = await removeQueueJobIfNeeded(context.queueJob, activity.isQueueRemovable);

  if (containerStopped) {
    await redisClient.del(`worker:abort:${context.stateTaskId}`);
  }

  await markTaskCancelled({
    taskId: context.stateTaskId,
    requestedBy,
    cancellation,
    state: context.state,
    queueJob: context.queueJob,
    queueState: context.queueState,
    containerId,
    containerStopped,
  });

  await pushConversationMessage(redisClient, context.stateTaskId, {
    type: 'system',
    timestamp: new Date().toISOString(),
    content: 'Task cancelled successfully.',
    level: 'info',
    metadata: { reasonCode: cancellation.code, requestedBy },
  });

  return {
    success: true,
    message: getStopTaskSuccessMessage({
      jobRemoved,
      shouldAbort: activity.isRunningTaskState || activity.isQueueActive,
      containerStopped,
    }),
    taskId: context.stateTaskId,
    containerStopped,
    jobRemoved,
    currentState: context.currentState,
    queueState: context.queueState,
    cancellation,
  };
}

async function loadStopTaskContext(taskReference: string, redisClient: RedisClientLike): Promise<StopTaskContext> {
  const normalizedTaskId = normalizeTaskId(taskReference);
  const candidateTaskIds = [...new Set([taskReference, normalizedTaskId])];

  console.log(`[stop-execution] Attempting to stop task: ${taskReference} (taskId: ${normalizedTaskId})`);

  const stateData = await redisClient.get(`worker:state:${normalizedTaskId}`);
  const state = stateData ? JSON.parse(stateData) as TaskState : null;
  const currentState = state?.history[state.history.length - 1]?.state ?? null;
  const queueJob = await getQueueJob(candidateTaskIds);
  const queueState = queueJob ? await queueJob.getState() : null;

  return {
    normalizedTaskId,
    state,
    currentState,
    queueJob,
    queueState,
    stateTaskId: state ? normalizedTaskId : String(queueJob?.id ?? normalizedTaskId),
  };
}

function getStopTaskActivity(currentState: string | null, queueState: string | null): StopTaskActivity {
  return {
    isRunningTaskState: currentState !== null && RUNNING_TASK_STATES.has(currentState),
    isNonTerminalTaskState: currentState !== null && !TERMINAL_TASK_STATES.has(currentState),
    isQueueActive: queueState === 'active',
    isQueueRemovable: queueState !== null && REMOVABLE_QUEUE_STATES.has(queueState),
  };
}

function assertTaskCanBeStopped(context: StopTaskContext, activity: StopTaskActivity): void {
  if (!context.state && !context.queueJob) {
    throw new StopTaskExecutionError(404, {
      error: 'Task not found',
      message: 'The task may have already completed or does not exist.',
    });
  }

  if (activity.isRunningTaskState || activity.isNonTerminalTaskState || activity.isQueueActive || activity.isQueueRemovable) {
    return;
  }

  throw new StopTaskExecutionError(400, {
    error: 'Task is not running',
    message: 'The task has already completed or is not in an active state.',
    currentState: context.currentState,
    queueState: context.queueState,
  });
}

async function setAbortSignalIfNeeded(params: {
  redisClient: RedisClientLike;
  taskId: string;
  requestedBy: string;
  cancellation: StopTaskCancellationReason;
  timestamp: string;
  shouldAbort: boolean;
}): Promise<void> {
  const { redisClient, taskId, requestedBy, cancellation, timestamp, shouldAbort } = params;
  if (!shouldAbort) {
    return;
  }

  const abortPayload = JSON.stringify({
    timestamp,
    requestedBy,
    reasonCode: cancellation.code,
    reason: cancellation.message,
  });

  await redisClient.set(`worker:abort:${taskId}`, abortPayload, { EX: 3600 });
  await pushConversationMessage(redisClient, taskId, {
    type: 'system',
    timestamp,
    content: cancellation.message,
    level: 'warning',
    metadata: { reasonCode: cancellation.code, requestedBy },
  });
  console.log(`[stop-execution] Abort signal set for task: ${taskId}`);
}

async function stopTaskContainer(params: {
  redisClient: RedisClientLike;
  taskId: string;
  state: TaskState | null;
  shouldAbort: boolean;
}): Promise<{ containerId?: string; containerStopped: boolean }> {
  const { redisClient, taskId, state, shouldAbort } = params;
  const entry = state?.history.find(h => h.state === 'claude_execution' && h.metadata?.containerId);
  const containerId = entry?.metadata?.containerId;

  if (!containerId) {
    if (shouldAbort) {
      console.log(`[stop-execution] No container ID found for task ${taskId}, relying on abort signal`);
    }
    return { containerStopped: false };
  }

  console.log(`[stop-execution] Found container ID: ${containerId}, attempting to stop...`);
  const stopResult = await stopDockerContainer(containerId, 10);

  if (!stopResult.success) {
    console.warn(`[stop-execution] Failed to stop container ${containerId}: ${stopResult.error}`);
    return { containerId, containerStopped: false };
  }

  console.log(`[stop-execution] Container ${containerId} stopped successfully`);
  await pushConversationMessage(redisClient, taskId, {
    type: 'system',
    timestamp: new Date().toISOString(),
    content: 'Docker container terminated.',
    level: 'info',
  });
  return { containerId, containerStopped: true };
}

async function removeQueueJobIfNeeded(queueJob: Job<QueueJobData> | null, isQueueRemovable: boolean): Promise<boolean> {
  if (!queueJob || !isQueueRemovable) {
    return false;
  }

  await queueJob.remove();
  console.log(`[stop-execution] Removed queued job ${String(queueJob.id)} before it started`);
  return true;
}

function getStopTaskSuccessMessage(params: {
  jobRemoved: boolean;
  shouldAbort: boolean;
  containerStopped: boolean;
}): string {
  const { jobRemoved, shouldAbort, containerStopped } = params;
  if (jobRemoved) {
    return 'Queued task cancelled before execution started.';
  }
  if (shouldAbort) {
    return containerStopped
      ? 'Execution stopped. The Docker container has been terminated.'
      : 'Stop request sent to worker. The execution will be terminated shortly.';
  }
  return 'Task cancelled.';
}

async function pushConversationMessage(
  redisClient: RedisClientLike,
  taskId: string,
  message: Record<string, unknown>,
): Promise<void> {
  await redisClient.rPush(`conversation:${taskId}`, JSON.stringify(message));
}

async function getQueueJob(candidateTaskIds: string[]): Promise<Job<QueueJobData> | null> {
  const queue = await getIssueQueue();
  for (const candidateTaskId of candidateTaskIds) {
    const job = await queue.getJob(candidateTaskId) as Job<QueueJobData> | undefined;
    if (job) {
      return job;
    }
  }
  return null;
}

async function markTaskCancelled(params: {
  taskId: string;
  requestedBy: string;
  cancellation: StopTaskCancellationReason;
  state: TaskState | null;
  queueJob: Job<QueueJobData> | null;
  queueState: string | null;
  containerId?: string;
  containerStopped: boolean;
}): Promise<void> {
  const { taskId, requestedBy, cancellation, state, queueJob, queueState, containerId, containerStopped } = params;
  const stateManager = getStateManager();

  try {
    if (!state && queueJob) {
      await createTaskStateFromQueueJob(taskId, queueJob);
    }

    await stateManager.markTaskCancelled(taskId, requestedBy, {
      reason: cancellation.message,
      cancellation: {
        code: cancellation.code,
        message: cancellation.message,
        cancelledBy: requestedBy === 'system' ? 'system' : 'user',
        source: 'task_stop',
        containerStopped,
        ...(containerId ? { containerId } : {}),
      },
      historyMetadata: {
        cancellation: {
          code: cancellation.code,
          message: cancellation.message,
        },
        requestedBy,
        containerStopped,
        ...(containerId ? { containerId } : {}),
        ...(queueState ? { queueState } : {}),
      },
    });
    console.log(`[stop-execution] Task ${taskId} marked as cancelled`);
  } catch (stateError) {
    console.warn(`[stop-execution] Failed to mark task as cancelled: ${(stateError as Error).message}`);
  }
}

async function createTaskStateFromQueueJob(taskId: string, queueJob: Job<QueueJobData>): Promise<void> {
  const issueRef = buildIssueRefFromJobData(queueJob.data);
  if (!issueRef) {
    return;
  }

  const stateManager = getStateManager();
  const correlationId = typeof queueJob.data.correlationId === 'string' ? queueJob.data.correlationId : null;
  await stateManager.createTaskState(taskId, issueRef, correlationId);

  const prNumber = extractPrNumber(queueJob.data);
  const initialJobData = JSON.stringify(queueJob.data);
  await db('tasks')
    .where({ task_id: taskId })
    .update({
      job_id: String(queueJob.id ?? taskId),
      ...(prNumber !== null ? { pr_number: prNumber } : {}),
      initial_job_data: initialJobData,
    });
}

function buildIssueRefFromJobData(jobData: QueueJobData): IssueRef | null {
  const repoOwner = getRepoOwner(jobData);
  const repoName = typeof jobData.repoName === 'string' ? jobData.repoName : null;
  const number = extractTaskNumber(jobData);

  if (!repoOwner || !repoName || number === null) {
    return null;
  }

  return {
    number,
    repoOwner,
    repoName,
    ...(typeof jobData.modelName === 'string' ? { modelName: jobData.modelName } : {}),
    ...(typeof jobData.title === 'string' ? { title: jobData.title } : {}),
    ...(typeof jobData.subtitle === 'string' ? { subtitle: jobData.subtitle } : {}),
    ...(typeof jobData.pullRequestNumber === 'number' ? { pullRequestNumber: jobData.pullRequestNumber, type: 'pr_followup' } : {}),
  };
}

function extractTaskNumber(jobData: QueueJobData): number | null {
  if (typeof jobData.pullRequestNumber === 'number') {
    return jobData.pullRequestNumber;
  }
  if (typeof jobData.prNumber === 'number') {
    return jobData.prNumber;
  }
  if (typeof jobData.number === 'number') {
    return jobData.number;
  }
  return null;
}

function extractPrNumber(jobData: QueueJobData): number | null {
  if (typeof jobData.pullRequestNumber === 'number') {
    return jobData.pullRequestNumber;
  }
  if (typeof jobData.prNumber === 'number') {
    return jobData.prNumber;
  }
  return null;
}

function getRepoOwner(jobData: QueueJobData): string | null {
  if (typeof jobData.repoOwner === 'string') {
    return jobData.repoOwner;
  }
  if (typeof jobData.owner === 'string') {
    return jobData.owner;
  }
  return null;
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
