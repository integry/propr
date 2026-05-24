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
  taskId: string;
  abortTaskIds: string[];
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

interface PersistedTaskRecord {
  taskId: string;
  jobId: string | null;
}

export interface StopTaskExecutionDeps {
  stopDockerContainer?: typeof stopDockerContainer;
  getStateManager?: typeof getStateManager;
  getIssueQueue?: typeof getIssueQueue;
  db?: typeof db;
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

export async function stopTaskExecution(
  taskReference: string,
  options: StopTaskExecutionOptions,
  deps: StopTaskExecutionDeps = {},
): Promise<StopTaskExecutionResult> {
  const { redisClient, requestedBy = 'user', cancellation = DEFAULT_STOP_REASON } = options;
  const context = await loadStopTaskContext(taskReference, redisClient, deps);
  const activity = getStopTaskActivity(context.currentState, context.queueState);
  const shouldAbort = shouldAbortTask(activity);

  assertTaskCanBeStopped(context, activity);
  await ensureTaskStateForCancellation(context.taskId, context.state, context.queueJob, deps);

  const timestamp = new Date().toISOString();
  await setAbortSignalIfNeeded({
    redisClient,
    taskIds: context.abortTaskIds,
    conversationTaskId: context.taskId,
    requestedBy,
    cancellation,
    timestamp,
    shouldAbort,
  });

  const { containerId, containerStopped } = await stopTaskContainer({
    redisClient,
    taskId: context.taskId,
    state: context.state,
    shouldAbort,
    stopContainer: deps.stopDockerContainer,
  });

  const jobRemoved = await removeQueueJobIfNeeded(context.queueJob, activity.isQueueRemovable);

  if (shouldClearAbortSignals(shouldAbort, containerStopped, jobRemoved)) {
    await clearAbortSignals(redisClient, context.abortTaskIds);
  }

  await markTaskCancelled({
    taskId: context.taskId,
    requestedBy,
    cancellation,
    queueState: context.queueState,
    containerId,
    containerStopped,
    deps,
  });

  await pushConversationMessage(redisClient, context.taskId, {
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
      shouldAbort,
      containerStopped,
    }),
    taskId: context.taskId,
    containerStopped,
    jobRemoved,
    currentState: context.currentState,
    queueState: context.queueState,
    cancellation,
  };
}

async function loadStopTaskContext(
  taskReference: string,
  redisClient: RedisClientLike,
  deps: StopTaskExecutionDeps,
): Promise<StopTaskContext> {
  const normalizedTaskId = normalizeTaskId(taskReference);
  const persistedTask = await findPersistedTaskRecord(taskReference, normalizedTaskId, deps.db ?? db);
  const stateLookup = await loadTaskState(redisClient, [persistedTask?.taskId, normalizedTaskId, taskReference]);
  const candidateTaskIds = [...new Set([
    taskReference,
    normalizedTaskId,
    persistedTask?.taskId,
    persistedTask?.jobId,
  ].filter((value): value is string => Boolean(value)))];

  console.log(`[stop-execution] Attempting to stop task: ${taskReference} (taskId: ${normalizedTaskId})`);

  const state = stateLookup.state;
  const currentState = state?.history[state.history.length - 1]?.state ?? null;
  const queueJob = await getQueueJob(candidateTaskIds, deps.getIssueQueue);
  const queueState = queueJob ? await queueJob.getState() : null;
  const taskId = resolveStopTaskId(normalizedTaskId, queueJob, persistedTask?.taskId ?? stateLookup.taskId);
  const abortTaskIds = buildAbortTaskIds(taskId, normalizedTaskId, queueJob, persistedTask?.jobId ?? null);

  return {
    normalizedTaskId,
    state,
    currentState,
    queueJob,
    queueState,
    taskId: stateLookup.taskId ?? taskId,
    abortTaskIds,
  };
}

async function findPersistedTaskRecord(
  taskReference: string,
  normalizedTaskId: string,
  database: typeof db,
): Promise<PersistedTaskRecord | null> {
  const lookupCandidates = [
    { column: 'task_id', value: taskReference },
    { column: 'task_id', value: normalizedTaskId },
    { column: 'job_id', value: taskReference },
    { column: 'job_id', value: normalizedTaskId },
  ];
  const seen = new Set<string>();

  for (const candidate of lookupCandidates) {
    const key = `${candidate.column}:${candidate.value}`;
    if (!candidate.value || seen.has(key)) {
      continue;
    }
    seen.add(key);

    const record = await database('tasks')
      .where({ [candidate.column]: candidate.value })
      .select('task_id', 'job_id')
      .first() as { task_id: string; job_id: string | null } | undefined;
    if (record) {
      return {
        taskId: record.task_id,
        jobId: record.job_id,
      };
    }
  }

  return null;
}

async function loadTaskState(
  redisClient: RedisClientLike,
  candidateTaskIds: Array<string | null | undefined>,
): Promise<{ state: TaskState | null; taskId: string | null }> {
  for (const candidateTaskId of candidateTaskIds) {
    if (!candidateTaskId) {
      continue;
    }

    const stateData = await redisClient.get(`worker:state:${candidateTaskId}`);
    if (!stateData) {
      continue;
    }

    return {
      state: JSON.parse(stateData) as TaskState,
      taskId: candidateTaskId,
    };
  }

  return { state: null, taskId: null };
}

function getStopTaskActivity(currentState: string | null, queueState: string | null): StopTaskActivity {
  return {
    isRunningTaskState: currentState !== null && RUNNING_TASK_STATES.has(currentState),
    isNonTerminalTaskState: currentState !== null && !TERMINAL_TASK_STATES.has(currentState),
    isQueueActive: queueState === 'active',
    isQueueRemovable: queueState !== null && REMOVABLE_QUEUE_STATES.has(queueState),
  };
}

function shouldAbortTask(activity: StopTaskActivity): boolean {
  return activity.isRunningTaskState || activity.isQueueActive || activity.isQueueRemovable;
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
  taskIds: string[];
  conversationTaskId: string;
  requestedBy: string;
  cancellation: StopTaskCancellationReason;
  timestamp: string;
  shouldAbort: boolean;
}): Promise<void> {
  const { redisClient, taskIds, conversationTaskId, requestedBy, cancellation, timestamp, shouldAbort } = params;
  if (!shouldAbort) {
    return;
  }

  const abortPayload = JSON.stringify({
    timestamp,
    requestedBy,
    reasonCode: cancellation.code,
    reason: cancellation.message,
  });

  for (const taskId of taskIds) {
    await redisClient.set(`worker:abort:${taskId}`, abortPayload, { EX: 3600 });
  }
  await pushConversationMessage(redisClient, conversationTaskId, {
    type: 'system',
    timestamp,
    content: cancellation.message,
    level: 'warning',
    metadata: { reasonCode: cancellation.code, requestedBy },
  });
  console.log(`[stop-execution] Abort signal set for task IDs: ${taskIds.join(', ')}`);
}

async function clearAbortSignals(redisClient: RedisClientLike, taskIds: string[]): Promise<void> {
  for (const taskId of taskIds) {
    await redisClient.del(`worker:abort:${taskId}`);
  }
}

function shouldClearAbortSignals(shouldAbort: boolean, containerStopped: boolean, jobRemoved: boolean): boolean {
  return shouldAbort && (containerStopped || jobRemoved);
}

async function stopTaskContainer(params: {
  redisClient: RedisClientLike;
  taskId: string;
  state: TaskState | null;
  shouldAbort: boolean;
  stopContainer?: typeof stopDockerContainer;
}): Promise<{ containerId?: string; containerStopped: boolean }> {
  const { redisClient, taskId, state, shouldAbort, stopContainer = stopDockerContainer } = params;
  const entry = state?.history.find(h => h.state === 'claude_execution' && h.metadata?.containerId);
  const containerId = entry?.metadata?.containerId;

  if (!containerId) {
    if (shouldAbort) {
      console.log(`[stop-execution] No container ID found for task ${taskId}, relying on abort signal`);
    }
    return { containerStopped: false };
  }

  console.log(`[stop-execution] Found container ID: ${containerId}, attempting to stop...`);
  const stopResult = await stopContainer(containerId, 10);

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

  try {
    await queueJob.remove();
    console.log(`[stop-execution] Removed queued job ${String(queueJob.id)} before it started`);
    return true;
  } catch (error) {
    const queueState = await reloadQueueStateAfterRemovalFailure(queueJob);
    if (queueState === 'active') {
      console.warn(`[stop-execution] Queue job ${String(queueJob.id)} became active during removal, relying on abort signal`);
      return false;
    }
    throw error;
  }
}

async function reloadQueueStateAfterRemovalFailure(queueJob: Job<QueueJobData>): Promise<string | null> {
  try {
    return await queueJob.getState();
  } catch (error) {
    console.warn(`[stop-execution] Failed to reload queue state for job ${String(queueJob.id)}: ${(error as Error).message}`);
    return null;
  }
}

async function ensureTaskStateForCancellation(
  taskId: string,
  state: TaskState | null,
  queueJob: Job<QueueJobData> | null,
  deps: Pick<StopTaskExecutionDeps, 'db' | 'getStateManager'>,
): Promise<void> {
  if (!state && queueJob) {
    await createTaskStateFromQueueJob(taskId, queueJob, deps);
  }
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

async function getQueueJob(
  candidateTaskIds: string[],
  loadQueue: typeof getIssueQueue = getIssueQueue,
): Promise<Job<QueueJobData> | null> {
  const queue = await loadQueue();
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
  queueState: string | null;
  containerId?: string;
  containerStopped: boolean;
  deps: StopTaskExecutionDeps;
}): Promise<void> {
  const { taskId, requestedBy, cancellation, queueState, containerId, containerStopped, deps } = params;
  const stateManager = (deps.getStateManager ?? getStateManager)();

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
}

async function createTaskStateFromQueueJob(
  taskId: string,
  queueJob: Job<QueueJobData>,
  deps: Pick<StopTaskExecutionDeps, 'db' | 'getStateManager'> = {},
): Promise<void> {
  const issueRef = buildIssueRefFromJobData(queueJob.data);
  if (!issueRef) {
    return;
  }

  const stateManager = (deps.getStateManager ?? getStateManager)();
  const correlationId = typeof queueJob.data.correlationId === 'string' ? queueJob.data.correlationId : null;
  await stateManager.createTaskState(taskId, issueRef, correlationId);

  const prNumber = extractPrNumber(queueJob.data);
  const initialJobData = JSON.stringify(queueJob.data);
  await (deps.db ?? db)('tasks')
    .where({ task_id: taskId })
    .update({
      job_id: String(queueJob.id ?? taskId),
      ...(prNumber !== null ? { pr_number: prNumber } : {}),
      initial_job_data: initialJobData,
    });
}

function buildIssueRefFromJobData(jobData: QueueJobData): IssueRef | null {
  const repoOwner = getRepoOwner(jobData);
  const repoName = getRepoName(jobData);
  const number = extractTaskNumber(jobData);
  const prNumber = extractPrNumber(jobData);

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
    ...(prNumber !== null ? { pullRequestNumber: prNumber, type: 'pr_followup' } : {}),
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
  const repository = getRepositoryValue(jobData);
  if (!repository) {
    return null;
  }
  return repository.split('/')[0] || null;
}

function getRepoName(jobData: QueueJobData): string | null {
  if (typeof jobData.repoName === 'string') {
    return jobData.repoName;
  }
  const repository = getRepositoryValue(jobData);
  if (!repository) {
    return null;
  }
  return repository.split('/')[1] || null;
}

function getRepositoryValue(jobData: QueueJobData): string | null {
  return typeof jobData.repository === 'string' ? jobData.repository : null;
}

function resolveStopTaskId(
  normalizedTaskId: string,
  queueJob: Job<QueueJobData> | null,
  persistedTaskId: string | null,
): string {
  if (persistedTaskId) {
    return persistedTaskId;
  }

  if (!queueJob) {
    return normalizedTaskId;
  }

  const queueTaskId = buildTaskIdFromQueueJob(queueJob);
  return queueTaskId ?? normalizedTaskId;
}

function buildAbortTaskIds(
  taskId: string,
  normalizedTaskId: string,
  queueJob: Job<QueueJobData> | null,
  persistedJobId: string | null,
): string[] {
  const queueJobId = queueJob?.id ? String(queueJob.id) : null;
  return [...new Set([taskId, normalizedTaskId, queueJobId, persistedJobId].filter((value): value is string => Boolean(value)))];
}

function buildTaskIdFromQueueJob(queueJob: Job<QueueJobData>): string | null {
  if (typeof queueJob.id === 'string' && isPullRequestQueueJob(queueJob.data)) {
    return queueJob.id;
  }

  if (
    typeof queueJob.data.repoOwner === 'string'
    && typeof queueJob.data.repoName === 'string'
    && typeof queueJob.data.number === 'number'
    && typeof queueJob.data.agentAlias === 'string'
    && typeof queueJob.data.modelName === 'string'
    && typeof queueJob.data.correlationId === 'string'
  ) {
    return `${queueJob.data.repoOwner}-${queueJob.data.repoName}-${queueJob.data.number}-${queueJob.data.agentAlias}-${queueJob.data.modelName}-${queueJob.data.correlationId}`;
  }

  return null;
}

function isPullRequestQueueJob(jobData: QueueJobData): boolean {
  return typeof jobData.pullRequestNumber === 'number' || typeof jobData.prNumber === 'number';
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
