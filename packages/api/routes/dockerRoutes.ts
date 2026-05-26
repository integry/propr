import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '@propr/core';
import { loadStopTaskContext, normalizeTaskId, type TaskState } from './stopTaskExecutionContext.js';
import { stopTaskExecution, isStopTaskExecutionError } from './stopTaskExecution.js';
import type { StopTaskExecutionResult } from './stopTaskExecution.js';
import { validateTaskId, validateTailParam } from './validation.js';

interface DockerRoutesDeps {
  redisClient: RedisClientType;
  loadStopTaskContext?: typeof loadStopTaskContext;
  stopTaskExecution?: typeof stopTaskExecution;
}

interface DockerContainerState {
  Status?: string;
  Running?: boolean;
  ExitCode?: number;
  Error?: string;
  StartedAt?: string;
  FinishedAt?: string;
}

const execFileAsync = promisify(execFile);

export function createDockerRoutes(deps: DockerRoutesDeps) {
  const { redisClient } = deps;

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
        deps.loadStopTaskContext,
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
      logger.error({ error: getErrorLogFields(error) }, 'Error in /api/task/:taskId/docker-info');
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
        deps.loadStopTaskContext,
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
        const { stdout, stderr } = await execFileAsync('docker', ['logs', '--tail', String(tail), containerMetadata.containerId], {
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 10 * 1024 * 1024,
        });
        res.setHeader('Content-Type', 'text/plain');
        res.send(`${stdout}${stderr}`);
      } catch (err) {
        if (isDockerNoSuchContainerError(err)) {
          res.status(404).json({ error: 'Container no longer exists', containerId: containerMetadata.containerId });
          return;
        }
        throw err;
      }
    } catch (error) {
      logger.error({ error: getErrorLogFields(error) }, 'Error in /api/task/:taskId/docker-logs');
      res.status(500).json({ error: 'Internal server error', message: 'Failed to retrieve Docker logs' });
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
      const executeStopTask = deps.stopTaskExecution ?? stopTaskExecution;
      const result = await executeStopTask(req.params.taskId, {
        redisClient,
        requestedBy,
        forceQueueScan: true,
      });
      if (result.cancellationRequested && !result.stopVerified) {
        res.status(202);
      }
      res.json(formatStopTaskRouteResponse(result));
    } catch (error) {
      if (isStopTaskExecutionError(error)) {
        res.status(error.status).json(error.body);
        return;
      }
      logger.error({ error: getErrorLogFields(error) }, 'Error in /api/task/:taskId/stop');
      res.status(500).json({ error: 'Internal server error', message: 'Failed to stop task' });
    }
  }

  return { getDockerInfo, getDockerLogs, stopTask };
}

async function loadDockerContainerMetadata(
  taskReference: string,
  redisClient: Pick<RedisClientType, 'get'>,
  loadContext: typeof loadStopTaskContext = loadStopTaskContext,
): Promise<{ containerId: string | null; containerName: string | null } | null> {
  const directState = await loadDockerTaskStateFromRedis(taskReference, redisClient);
  if (directState) {
    const directMetadata = getDockerContainerMetadata(directState);
    if (directMetadata.containerId) {
      return directMetadata;
    }

    const contextState = await loadDockerTaskStateFromStopContext(taskReference, redisClient, loadContext);
    if (contextState) {
      const contextMetadata = getDockerContainerMetadata(contextState);
      if (contextMetadata.containerId) {
        return contextMetadata;
      }
    }

    return directMetadata;
  }

  const contextState = await loadDockerTaskStateFromStopContext(taskReference, redisClient, loadContext);
  if (contextState) {
    return getDockerContainerMetadata(contextState);
  }
  return null;
}

async function loadDockerTaskStateFromStopContext(
  taskReference: string,
  redisClient: Pick<RedisClientType, 'get'>,
  loadContext: typeof loadStopTaskContext,
): Promise<TaskState | null> {
  try {
    const context = await loadContext(taskReference, redisClient, { forceQueueScan: false });
    return context.state;
  } catch (error) {
    logger.warn({
      taskReference,
      error: getErrorLogFields(error),
    }, 'Unable to resolve extended task context for Docker metadata lookup');
    return null;
  }
}

async function loadDockerTaskStateFromRedis(
  taskReference: string,
  redisClient: Pick<RedisClientType, 'get'>,
): Promise<TaskState | null> {
  for (const candidateTaskId of [...new Set([taskReference, normalizeTaskId(taskReference)])]) {
    const stateData = await redisClient.get(`worker:state:${candidateTaskId}`);
    if (!stateData) {
      continue;
    }

    try {
      return JSON.parse(stateData) as TaskState;
    } catch (error) {
      logger.warn({ taskId: candidateTaskId, error: getErrorLogFields(error) }, 'Ignoring malformed worker task state for Docker metadata lookup');
    }
  }

  return null;
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
    const { stdout } = await execFileAsync('docker', ['inspect', '--format', '{{json .State}}', containerId], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const state = parseDockerContainerState(stdout);
    if (!state) {
      logger.error({ containerId }, 'Docker inspect returned malformed container state');
      return {
        id: containerId,
        name: containerName ?? null,
        status: 'error',
        stateStatus: null,
        stateDescription: 'Unable to parse container state.',
        state: null,
        logsAvailable: false,
        error: 'Failed to parse container info.',
      };
    }
    return {
      id: containerId,
      name: containerName ?? null,
      status: formatDockerContainerStatus(state),
      stateStatus: state.Status ?? null,
      stateDescription: formatDockerContainerStateDescription(state),
      state,
      logsAvailable: true,
    };
  } catch (error) {
    if (isDockerNoSuchContainerError(error)) {
      return { id: containerId, name: containerName ?? null, status: 'removed', logsAvailable: false };
    }
    logger.error({ containerId, error: getErrorLogFields(error) }, 'Error getting container info');
    return {
      id: containerId,
      name: containerName ?? null,
      status: 'error',
      logsAvailable: false,
      error: 'Failed to get container info.',
    };
  }
}

function parseDockerContainerState(stdout: string): DockerContainerState | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as DockerContainerState;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function formatDockerContainerStatus(state: DockerContainerState): string {
  if (state.Running === true) {
    return 'running';
  }

  return 'stopped';
}

function formatDockerContainerStateDescription(state: DockerContainerState): string {
  const status = typeof state.Status === 'string' && state.Status.length > 0 ? state.Status : formatDockerContainerStatus(state);
  if (typeof state.ExitCode === 'number' && status === 'exited') {
    return `${status} (code ${state.ExitCode})`;
  }

  return status;
}

function getErrorLogFields(error: unknown): {
  message: string;
  stack?: string;
  name?: string;
  code?: unknown;
  signal?: unknown;
  stdout?: string;
  stderr?: string;
} {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  const record = error as Error & Record<string, unknown>;
  return {
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(error.name ? { name: error.name } : {}),
    ...(record.code !== undefined ? { code: record.code } : {}),
    ...(record.signal !== undefined ? { signal: record.signal } : {}),
    ...(typeof record.stdout === 'string' ? { stdout: record.stdout } : {}),
    ...(typeof record.stderr === 'string' ? { stderr: record.stderr } : {}),
  };
}

function formatStopTaskRouteResponse(result: StopTaskExecutionResult): {
  success: true;
  message: string;
  taskId: string;
  containerStopped: boolean;
  jobRemoved: boolean;
  stopVerified: boolean;
  cancellationRequested: boolean;
  abortSignalArmed: boolean;
  currentState: string | null;
  queueState: string | null;
  cancellation: StopTaskExecutionResult['cancellation'];
} {
  return {
    success: true,
    message: result.message,
    taskId: result.taskId,
    containerStopped: result.containerStopped,
    jobRemoved: result.jobRemoved,
    stopVerified: result.stopVerified,
    cancellationRequested: result.cancellationRequested,
    abortSignalArmed: result.abortSignalArmed,
    currentState: result.currentState,
    queueState: result.queueState,
    cancellation: result.cancellation,
  };
}

function isDockerNoSuchContainerError(error: unknown): boolean {
  return getDockerCommandErrorDetails(error).includes('No such container');
}

function getDockerCommandErrorDetails(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return String(error);
  }

  const record = error as Record<string, unknown>;
  return [
    typeof record.stderr === 'string' ? record.stderr : null,
    typeof record.stdout === 'string' ? record.stdout : null,
    error instanceof Error ? error.message : null,
  ].filter((detail): detail is string => detail !== null).join('\n');
}
