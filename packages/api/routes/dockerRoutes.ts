import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { execSync } from 'child_process';
import { stopDockerContainer, getStateManager, getIssueQueue } from '@propr/core';
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
  data?: unknown;
  remove(): Promise<unknown>;
}

export interface StopTaskQueue {
  getJobs(states: Array<'waiting' | 'delayed' | 'active'>): Promise<StoppableQueueJob[]>;
}

export interface StopTaskExecutionOptions {
  redisClient: StopTaskRedisClient;
  /** Who requested the stop (username or e.g. 'system'). Defaults to 'user'. */
  requestedBy?: string;
  /** Human-readable cancellation reason, surfaced in the conversation log and task history. */
  reason?: string;
  /** Machine-readable cancellation reason code (e.g. 'pr_merged'), stored in task history metadata. */
  cancellationReason?: string;
  /**
   * When true, the task is marked cancelled even if only the abort signal could
   * be set (no container ID, the container stop failed, or an active queue job
   * has not written worker state yet). Used by merge-triggered cancellation,
   * which must durably record the cancellation instead of relying on the worker
   * to observe the abort signal. The abort signal is left in place so the worker
   * still terminates; its own terminal-state update is skipped because the task
   * is already in a terminal state.
   */
  ensureCancelled?: boolean;
  /** Override the BullMQ queue lookup (used by tests). Defaults to getIssueQueue(). */
  getQueue?: () => Promise<StopTaskQueue>;
  /** Override marking the task cancelled (used by tests). Defaults to the shared state manager. */
  markCancelled?: (taskId: string, cancelledBy: string, metadata: { reason?: string; historyMetadata?: Record<string, unknown> }) => Promise<unknown>;
  /** Override task state creation for queued jobs that never started (used by tests). */
  createTaskState?: (taskId: string, issueRef: IssueRef) => Promise<unknown>;
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
  /** True when an abort signal is still pending for the worker to observe. */
  abortSignalled?: boolean;
  /** True when the task was marked cancelled in the state store. */
  cancellationRecorded?: boolean;
}

function jobMatchesTask(jobId: string, taskIdOrJobId: string, taskId: string): boolean {
  return jobId === taskIdOrJobId || jobId === taskId || normalizeTaskId(jobId) === taskId;
}

/**
 * Removes queued/delayed jobs belonging to a task before they start executing.
 * Returns the number of removed jobs plus the job data of the last removed job,
 * which is used to create a task state record for jobs that never started.
 *
 * This scans the pending queue rather than doing a direct job-ID lookup because
 * job IDs do not equal task IDs (queue producers add type prefixes and
 * uniqueness suffixes — see normalizeTaskId), so the matching job IDs cannot be
 * computed up front. The scan only runs for stops of non-running tasks, and the
 * waiting/delayed set is typically small; if stop latency becomes a problem on
 * large queues, a task-ID → job-ID index would remove the scan.
 */
async function removeQueuedJobsForTask(taskIdOrJobId: string, taskId: string, options: StopTaskExecutionOptions): Promise<{ removed: number; jobData: Record<string, unknown> | null }> {
  let removed = 0;
  let jobData: Record<string, unknown> | null = null;
  try {
    const queue = options.getQueue ? await options.getQueue() : await getIssueQueue();
    const jobs = await queue.getJobs(PENDING_QUEUE_STATES);
    for (const job of jobs) {
      const jobId = job.id != null ? String(job.id) : '';
      if (!jobId) continue;
      if (!jobMatchesTask(jobId, taskIdOrJobId, taskId)) continue;
      try {
        await job.remove();
        removed++;
        if (job.data && typeof job.data === 'object') jobData = job.data as Record<string, unknown>;
        console.log(`[stop-execution] Removed queued job ${jobId} for task ${taskId}`);
      } catch (removeError) {
        console.warn(`[stop-execution] Failed to remove queued job ${jobId}: ${(removeError as Error).message}`);
      }
    }
  } catch (queueError) {
    console.warn(`[stop-execution] Failed to inspect queue for task ${taskId}: ${(queueError as Error).message}`);
  }
  return { removed, jobData };
}

/** Finds a job currently being processed by a queue worker for the task, returning its data when present. */
async function findActiveQueueJob(taskIdOrJobId: string, taskId: string, options: StopTaskExecutionOptions): Promise<{ active: boolean; jobData: Record<string, unknown> | null }> {
  try {
    const queue = options.getQueue ? await options.getQueue() : await getIssueQueue();
    const jobs = await queue.getJobs(['active']);
    for (const job of jobs) {
      const jobId = job.id != null ? String(job.id) : '';
      if (jobId && jobMatchesTask(jobId, taskIdOrJobId, taskId)) {
        const jobData = job.data && typeof job.data === 'object' ? job.data as Record<string, unknown> : null;
        return { active: true, jobData };
      }
    }
  } catch (queueError) {
    console.warn(`[stop-execution] Failed to inspect active queue jobs for task ${taskId}: ${(queueError as Error).message}`);
  }
  return { active: false, jobData: null };
}

/**
 * Parses a worker state value defensively. A corrupt or partial `worker:state`
 * entry must not abort the stop operation — the task is treated as having no
 * state, so the abort-signal and queued-job paths still run.
 */
function parseTaskState(taskId: string, stateData: string | null): TaskState | null {
  if (!stateData) return null;
  try {
    const parsed = JSON.parse(stateData) as TaskState;
    if (!Array.isArray(parsed?.history)) {
      console.warn(`[stop-execution] Worker state for task ${taskId} has no history array; treating as missing`);
      return null;
    }
    return parsed;
  } catch (parseError) {
    console.warn(`[stop-execution] Malformed worker state for task ${taskId}; treating as missing: ${(parseError as Error).message}`);
    return null;
  }
}

async function setAbortSignal(taskId: string, options: StopTaskExecutionOptions): Promise<void> {
  await options.redisClient.set(`worker:abort:${taskId}`, JSON.stringify({
    timestamp: new Date().toISOString(),
    requestedBy: options.requestedBy ?? 'user',
    ...(options.cancellationReason ? { reason: options.cancellationReason } : {})
  }), { EX: 3600 });
}

/** Best-effort extraction of an issue ref from queue job data so a task state can be created. */
function deriveIssueRefFromJobData(jobData: Record<string, unknown> | null): IssueRef | null {
  if (!jobData) return null;
  let repoOwner = typeof jobData.repoOwner === 'string' ? jobData.repoOwner : undefined;
  let repoName = typeof jobData.repoName === 'string' ? jobData.repoName : undefined;
  if ((!repoOwner || !repoName) && typeof jobData.repository === 'string' && jobData.repository.includes('/')) {
    const [owner, ...rest] = jobData.repository.split('/');
    repoOwner = owner;
    repoName = rest.join('/');
  }
  if (!repoOwner || !repoName) return null;
  const number = typeof jobData.number === 'number' ? jobData.number
    : typeof jobData.issueNumber === 'number' ? jobData.issueNumber
    : typeof jobData.prNumber === 'number' ? jobData.prNumber
    : typeof jobData.pullRequestNumber === 'number' ? jobData.pullRequestNumber
    : null;
  // Without an issue/PR number the payload shape is unsupported — creating a
  // state record under a fabricated number (e.g. 0) would produce misleading
  // task history, so the caller treats this the same as missing job data.
  if (number === null || number <= 0) return null;
  return { number, repoOwner, repoName };
}

/**
 * Creates a task state record for a queued job that was removed before it ever
 * started. Without this, marking the task cancelled has nothing to attach the
 * cancellation reason to and the removal would leave no audit trail.
 *
 * Returns 'created' when a state record now exists, or a failure outcome so the
 * caller can skip marking the task cancelled (there is nothing to attach the
 * cancellation to) and report `cancellationRecorded: false` truthfully.
 */
async function ensureTaskStateForQueuedJob(taskId: string, jobData: Record<string, unknown> | null, options: StopTaskExecutionOptions): Promise<'created' | 'unsupported-payload' | 'create-failed'> {
  const issueRef = deriveIssueRefFromJobData(jobData);
  if (!issueRef) {
    // Operational gap: without a repository + number the cancellation reason
    // cannot be attached anywhere. Log the job-data shape so unsupported queue
    // payloads are visible and can be added to deriveIssueRefFromJobData().
    const jobDataKeys = jobData ? Object.keys(jobData).join(', ') || '(empty object)' : '(no job data)';
    console.warn(`[stop-execution] Cannot derive issue ref for queued task ${taskId}; cancellation reason will not be recorded. Job data keys: ${jobDataKeys}`);
    return 'unsupported-payload';
  }
  try {
    const create = options.createTaskState
      ?? ((id: string, ref: IssueRef) => getStateManager().createTaskState(id, ref));
    await create(taskId, issueRef);
    return 'created';
  } catch (createError) {
    console.warn(`[stop-execution] Failed to create task state for queued task ${taskId}: ${(createError as Error).message}`);
    return 'create-failed';
  }
}

/** Marks the task cancelled. Returns true when the cancellation was recorded. */
async function markTaskCancelledSafely(taskId: string, historyMetadata: Record<string, unknown>, options: StopTaskExecutionOptions): Promise<boolean> {
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
  } catch (stateError) {
    console.warn(`[stop-execution] Failed to mark task as cancelled: ${(stateError as Error).message}`);
    return false;
  }
  // The conversation append is informational; the cancellation is already
  // durably recorded above, so a failure here must not report it as unrecorded.
  try {
    await options.redisClient.rPush(`conversation:${taskId}`, JSON.stringify({ type: 'system', timestamp: new Date().toISOString(), content: 'Task cancelled successfully.', level: 'info' }));
  } catch (appendError) {
    console.warn(`[stop-execution] Failed to append cancellation note to conversation for task ${taskId}: ${(appendError as Error).message}`);
  }
  return true;
}

/**
 * Stops a task's execution: signals the worker to abort, terminates the Docker
 * container when one is running, and removes queued/delayed jobs that have not
 * started yet. Shared by the manual stop route and merge-triggered cancellation.
 *
 * Accepts either a task ID or a queue job ID (job IDs are normalized).
 */
export async function stopTaskExecution(taskIdOrJobId: string, options: StopTaskExecutionOptions): Promise<StopTaskExecutionResult> {
  const { redisClient } = options;
  const stopMessage = options.reason ?? 'Stop requested by user. Terminating execution...';
  const taskId = normalizeTaskId(taskIdOrJobId);

  const markCancelled = (historyMetadata: Record<string, unknown>): Promise<boolean> => markTaskCancelledSafely(taskId, historyMetadata, options);

  const stateData = await redisClient.get(`worker:state:${taskId}`);
  const state = parseTaskState(taskId, stateData);
  const currentState = state?.history[state.history.length - 1]?.state;
  const isRunning = !!currentState && ACTIVE_TASK_STATES.includes(currentState);

  if (!isRunning) {
    // No live container — the task may still have queued or delayed jobs that
    // have not started yet. Remove those before they begin executing.
    const { removed: removedQueuedJobs, jobData } = await removeQueuedJobsForTask(taskIdOrJobId, taskId, options);
    if (removedQueuedJobs > 0) {
      // The job never started, so no task state exists yet. Create one so the
      // cancellation and its reason are recorded instead of silently lost.
      // When no state exists and none could be created, marking the task
      // cancelled has nothing to attach the reason to — skip it and report
      // cancellationRecorded: false instead of pretending an audit trail exists.
      const stateAvailable = state
        ? true
        : (await ensureTaskStateForQueuedJob(taskId, jobData, options)) === 'created';
      const cancellationRecorded = stateAvailable && await markCancelled({ removedQueuedJobs });
      return {
        success: true,
        taskId,
        containerStopped: false,
        removedQueuedJobs,
        cancellationRecorded,
        message: cancellationRecorded
          ? `Removed ${removedQueuedJobs} queued job(s) before execution started.`
          : `Removed ${removedQueuedJobs} queued job(s) before execution started, but the cancellation could not be recorded in task state.`
      };
    }
    if (!state) {
      // A queue worker may have picked the job up without having written
      // worker:state yet. Set the abort signal so the worker terminates as soon
      // as it checks for it; the worker records the cancellation when it aborts.
      const activeJob = await findActiveQueueJob(taskIdOrJobId, taskId, options);
      if (activeJob.active) {
        await setAbortSignal(taskId, options);
        await redisClient.rPush(`conversation:${taskId}`, JSON.stringify({ type: 'system', timestamp: new Date().toISOString(), content: stopMessage, level: 'warning' }));
        console.log(`[stop-execution] Abort signal set for active queue job of task ${taskId} (no worker state yet)`);
        let cancellationRecorded = false;
        if (options.ensureCancelled) {
          // Durably record the cancellation instead of relying solely on the
          // worker to observe the abort signal. The worker may overwrite this
          // state when it starts (createTaskState), but the abort signal —
          // which carries the machine-readable reason — stays in place so the
          // worker still terminates and re-records the cancellation itself;
          // if the worker dies before writing state, this record remains as
          // the durable audit trail. When no state could be created there is
          // nothing to record the cancellation on — the abort signal is the
          // only cancellation mechanism, so cancellationRecorded stays false.
          const ensured = await ensureTaskStateForQueuedJob(taskId, activeJob.jobData, options);
          cancellationRecorded = ensured === 'created'
            && await markCancelled({ abortSignalled: true, activeQueueJob: true });
        }
        return {
          success: true,
          taskId,
          containerStopped: false,
          removedQueuedJobs: 0,
          abortSignalled: true,
          cancellationRecorded,
          message: 'Stop request sent to worker. The execution will be terminated shortly.'
        };
      }
      return { success: false, taskId, containerStopped: false, removedQueuedJobs: 0, notFound: true, message: 'The task may have already completed or does not exist.' };
    }
    return { success: false, taskId, containerStopped: false, removedQueuedJobs: 0, notRunning: true, currentState, message: 'The task has already completed or is not in an active state.' };
  }

  // Set abort signal for the worker to pick up
  await setAbortSignal(taskId, options);
  await redisClient.rPush(`conversation:${taskId}`, JSON.stringify({ type: 'system', timestamp: new Date().toISOString(), content: stopMessage, level: 'warning' }));
  console.log(`[stop-execution] Abort signal set for task: ${taskId}`);

  const containerId = await stopRunningTaskContainer(taskId, state!, options);
  const containerStopped = containerId !== null;

  // Remove any queued/delayed jobs for the same task (e.g. pending retries)
  const { removed: removedQueuedJobs } = await removeQueuedJobsForTask(taskIdOrJobId, taskId, options);

  let cancellationRecorded = false;
  if (containerStopped) {
    // Clear abort signal after direct container stop
    await redisClient.del(`worker:abort:${taskId}`);
    cancellationRecorded = await markCancelled({ containerId, stoppedAt: new Date().toISOString() });
  } else if (options.ensureCancelled) {
    // The container could not be stopped directly. Record the cancellation now
    // rather than relying on the worker to observe the abort signal. The signal
    // stays in place so the worker still terminates; its later terminal-state
    // update is skipped because the task is already cancelled.
    cancellationRecorded = await markCancelled({ abortSignalled: true });
  }

  return {
    success: true,
    taskId,
    containerStopped,
    removedQueuedJobs,
    abortSignalled: !containerStopped,
    cancellationRecorded,
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
