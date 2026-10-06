import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import {
  TaskSteerLimitError,
  createTaskSteer,
  listTaskSteers,
  type TaskSteerAuthorSource,
} from '@propr/core';
import {
  TASK_STEER_MAX_LENGTH,
  TASK_STEER_MAX_PER_RUN,
  taskSteeringCapability,
  taskSteeringRedisKey,
  validateTaskSteerMessage,
  type TaskSteeringCapability,
  type TaskSteeringRunAnnouncement,
} from '@propr/shared';
import { isDemoMode } from '../demoMode.js';
import { validateTaskId } from './validation.js';

interface TaskSteeringRedis {
  get(key: string): Promise<string | null>;
}

interface TaskSteeringRoutesDeps {
  db: Knex;
  redisClient: TaskSteeringRedis;
}

interface SteeringStatus {
  running: boolean;
  capability: TaskSteeringCapability;
  agentAlias: string | null;
  agentType: string | null;
}

/** Same attribution sources goal inputs distinguish: browser session, bearer token, MCP. */
export function steerAuthorSource(req: Request): TaskSteerAuthorSource {
  if (req.authenticationMethod === 'mcp') return 'mcp';
  if (req.authenticationMethod === 'instance_token' || req.authenticationMethod === 'github_bearer') return 'token';
  return 'session';
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

const limits = { maxMessageLength: TASK_STEER_MAX_LENGTH, maxSteersPerRun: TASK_STEER_MAX_PER_RUN };

/**
 * A task is steerable while its worker announces a running agent
 * (`taskSteeringRedisKey`). The announcement carries the capability the
 * running agent declared, so the API never guesses which agent runs.
 */
export function createTaskSteeringRoutes(deps: TaskSteeringRoutesDeps) {
  const { db, redisClient } = deps;

  /** The steering status of a task, and the announced run's key while it runs. */
  async function steeringStatus(taskId: string): Promise<{ status: SteeringStatus; runKey: string | null }> {
    const announcement = parseJson<TaskSteeringRunAnnouncement>(await redisClient.get(taskSteeringRedisKey(taskId)));
    if (announcement) {
      const { capability, agentAlias, agentType, runKey } = announcement;
      return { status: { running: true, capability, agentAlias, agentType }, runKey };
    }
    // Not running: report the agent type's capability when the task names its agent.
    const state = parseJson<{ issueRef?: { agentAlias?: string; agentType?: string } }>(await redisClient.get(`worker:state:${taskId}`));
    const agentType = state?.issueRef?.agentType ?? null;
    return {
      status: { running: false, capability: taskSteeringCapability(agentType), agentAlias: state?.issueRef?.agentAlias ?? null, agentType },
      runKey: null,
    };
  }

  async function loadTask(req: Request, res: Response): Promise<string | null> {
    const taskId = String(req.params.taskId ?? '');
    const validation = validateTaskId(taskId);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return null;
    }
    const task = await db('tasks').where({ task_id: taskId }).first('task_id');
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return null;
    }
    return taskId;
  }

  /** POST /api/tasks/:taskId/steer — queue operator input for the running agent. */
  async function steer(req: Request, res: Response): Promise<void> {
    try {
      const author = req.user?.login || req.user?.username;
      if (!req.user?.id || !author) {
        res.status(401).json({ error: 'Unable to determine requesting user' });
        return;
      }
      if (isDemoMode()) {
        res.status(403).json({ error: 'Demo mode is read-only' });
        return;
      }
      const messageError = validateTaskSteerMessage(req.body?.message);
      if (messageError) {
        res.status(400).json({ error: messageError, ...limits });
        return;
      }
      const taskId = await loadTask(req, res);
      if (!taskId) return;
      const { status, runKey } = await steeringStatus(taskId);
      if (!status.running || !runKey) {
        res.status(409).json({
          error: 'Task is not running: steering is accepted only while its agent runs. Send a follow-up instead.',
          code: 'TASK_NOT_RUNNING', ...status,
        });
        return;
      }
      if (status.capability === 'none') {
        res.status(409).json({
          error: `The running ${status.agentType ?? 'unknown'} agent (${status.agentAlias ?? 'unknown'}) cannot receive input during a task run. Wait for the run to finish and send a follow-up, or stop it.`,
          code: 'STEERING_UNSUPPORTED', ...status,
        });
        return;
      }
      const created = await createTaskSteer(db, {
        taskId,
        runKey,
        author,
        authorSource: steerAuthorSource(req),
        message: req.body.message,
      });
      res.status(202).json({ steer: created, ...status, ...limits });
    } catch (error) {
      if (error instanceof TaskSteerLimitError) {
        res.status(409).json({ error: error.message, code: 'STEER_LIMIT_REACHED', ...limits });
        return;
      }
      console.error('Error steering task:', error);
      res.status(500).json({ error: 'Failed to steer task' });
    }
  }

  /** GET /api/tasks/:taskId/steers — steering history and whether the task can be steered now. */
  async function list(req: Request, res: Response): Promise<void> {
    try {
      const taskId = await loadTask(req, res);
      if (!taskId) return;
      const { status } = await steeringStatus(taskId);
      res.json({ steers: await listTaskSteers(db, taskId), ...status, ...limits });
    } catch (error) {
      console.error('Error listing task steers:', error);
      res.status(500).json({ error: 'Failed to list task steers' });
    }
  }

  return { steer, list };
}
