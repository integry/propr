import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import type { Queue } from 'bullmq';
import {
  AgentRegistry,
  GOAL_CONTINUE_INPUT,
  buildNativeGoalCommand,
  getAuthenticatedOctokit,
  goalJobId,
  type GoalCapability,
  type GoalJobData,
} from '@propr/core';
import type { RedisClientType } from 'redis';
import { stopTaskExecution, type StopTaskExecutionResult } from './dockerRoutes.js';

interface GoalRoutesDeps {
  db: Knex;
  taskQueue: Queue;
  redisClient: RedisClientType;
  getCapabilities?: () => Promise<GoalCapability[]>;
  stopExecution?: (taskId: string, options: Parameters<typeof stopTaskExecution>[1]) => Promise<StopTaskExecutionResult>;
}

interface GoalRow {
  goal_id: string;
  owner_id: string;
  owner_login: string;
  repository: string;
  objective: string;
  base_branch: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  agent_id: string;
  agent_alias: string;
  agent_type: string;
  requested_model: string;
  effective_model: string | null;
  max_parallel_tasks: number | null;
  ultrafix: number | boolean | null;
  desired_state: 'running' | 'paused' | 'cancelled';
  result_state: 'completed' | 'failed' | 'cancelled' | null;
  current_task_id: string;
  session_id: string | null;
  conversation_id: string | null;
  run_generation: number;
  final_pr_number: number | null;
  final_pr_url: string | null;
  artifact_refs: string | unknown[] | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  paused_at: string | null;
  paused_ms: number;
  completed_at: string | null;
}

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const cannedInputs = {
  done: "What's done?",
  left: "What's left?",
} as const;

function currentOwnerId(req: Request): string | null {
  return req.user?.id ? String(req.user.id) : null;
}

function parseArtifacts(value: GoalRow['artifact_refs']): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try { return JSON.parse(value) as unknown[]; } catch { return []; }
}

async function serializeGoal(db: Knex, row: GoalRow) {
  const latestHistory = await db('task_history')
    .where({ task_id: row.current_task_id })
    .orderBy('timestamp', 'desc')
    .first();
  const endMs = row.completed_at ? new Date(row.completed_at).getTime() : Date.now();
  const startMs = row.started_at ? new Date(row.started_at).getTime() : new Date(row.created_at).getTime();
  const currentPauseMs = row.desired_state === 'paused' && row.paused_at
    ? Math.max(0, Date.now() - new Date(row.paused_at).getTime())
    : 0;
  const pausedMs = Number(row.paused_ms || 0) + currentPauseMs;
  const elapsedMs = Math.max(0, endMs - startMs);
  return {
    id: row.goal_id,
    owner: row.owner_login,
    repository: row.repository,
    objective: row.objective,
    baseBranch: row.base_branch,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    agent: { id: row.agent_id, alias: row.agent_alias, type: row.agent_type },
    requestedModel: row.requested_model,
    effectiveModel: row.effective_model,
    maxParallelTasks: row.max_parallel_tasks,
    ultrafix: row.ultrafix == null ? null : Boolean(row.ultrafix),
    desiredState: row.desired_state,
    resultState: row.result_state,
    taskId: row.current_task_id,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    finalPr: row.final_pr_url ? { number: row.final_pr_number, url: row.final_pr_url } : null,
    artifacts: parseArtifacts(row.artifact_refs),
    taskState: latestHistory?.state ?? 'pending',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    pausedAt: row.paused_at,
    completedAt: row.completed_at,
    elapsedMs,
    pausedMs,
    activeMs: Math.max(0, elapsedMs - pausedMs),
  };
}

async function findOwnedGoal(db: Knex, req: Request, res: Response): Promise<GoalRow | null> {
  const ownerId = currentOwnerId(req);
  if (!ownerId) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  const goalId = Array.isArray(req.params.goalId) ? req.params.goalId[0] : req.params.goalId;
  const row = await db('goals').where({ goal_id: goalId, owner_id: ownerId }).first() as GoalRow | undefined;
  if (!row) res.status(404).json({ error: 'Goal not found' });
  return row ?? null;
}

function validateCreateBody(body: Record<string, unknown>): string | null {
  if (typeof body.repository !== 'string' || !repositoryPattern.test(body.repository)) return 'repository must be in owner/repo format';
  if (typeof body.objective !== 'string' || body.objective.trim().length < 1 || body.objective.length > 65_536) return 'objective is required';
  if (typeof body.agentId !== 'string' || !body.agentId) return 'agentId is required';
  if (typeof body.model !== 'string' || !body.model) return 'model is required';
  if (body.baseBranch != null && (typeof body.baseBranch !== 'string' || body.baseBranch.length > 255)) return 'baseBranch is invalid';
  if (body.maxParallelTasks != null && (!Number.isSafeInteger(body.maxParallelTasks) || Number(body.maxParallelTasks) < 1 || Number(body.maxParallelTasks) > 32)) return 'maxParallelTasks must be an integer from 1 to 32';
  if (body.ultrafix != null && typeof body.ultrafix !== 'boolean') return 'ultrafix must be a boolean';
  return null;
}

export function createGoalRoutes(deps: GoalRoutesDeps) {
  const getCapabilities = deps.getCapabilities ?? (async () => {
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();
    return registry.getGoalCapabilities();
  });
  const stop = deps.stopExecution ?? stopTaskExecution;

  /** Protect existing task/log surfaces when their authoritative task belongs to a goal. */
  const requireGoalTaskOwnership = async (req: Request, res: Response, next: () => void) => {
    const taskId = Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId;
    const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
    const correlationId = Array.isArray(req.params.correlationId) ? req.params.correlationId[0] : req.params.correlationId;
    let goal: Pick<GoalRow, 'goal_id' | 'owner_id'> | undefined;
    if (taskId?.startsWith('goal-')) {
      goal = await deps.db('goals').select('goal_id', 'owner_id').where({ current_task_id: taskId }).first() as Pick<GoalRow, 'goal_id' | 'owner_id'> | undefined;
    } else if (sessionId) {
      goal = await deps.db('goals')
        .select('goals.goal_id', 'goals.owner_id')
        .join('llm_executions', 'llm_executions.task_id', 'goals.current_task_id')
        .where('llm_executions.session_id', sessionId)
        .first() as Pick<GoalRow, 'goal_id' | 'owner_id'> | undefined;
    } else if (correlationId) {
      goal = await deps.db('goals').select('goal_id', 'owner_id').where({ goal_id: correlationId }).first() as Pick<GoalRow, 'goal_id' | 'owner_id'> | undefined;
    }
    if (goal && goal.owner_id !== currentOwnerId(req)) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (goal && !['GET', 'HEAD'].includes(req.method)) {
      res.status(409).json({ error: 'Use the goal controls to mutate a native goal task' });
      return;
    }
    next();
  };

  const capabilities = async (_req: Request, res: Response) => {
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();
    const detected = await getCapabilities();
    const agents = detected.map(capability => {
      const agent = registry.getAgentById(capability.agentId);
      return {
        ...capability,
        models: agent?.config.supportedModels ?? [],
        defaultModel: agent?.config.defaultModel ?? null,
      };
    });
    res.json({ agents });
  };

  const list = async (req: Request, res: Response) => {
    const ownerId = currentOwnerId(req);
    if (!ownerId) return void res.status(401).json({ error: 'Authentication required' });
    const rows = await deps.db<GoalRow>('goals').where({ owner_id: ownerId }).orderBy('updated_at', 'desc').limit(200);
    res.json({ goals: await Promise.all(rows.map(row => serializeGoal(deps.db, row))) });
  };

  const get = async (req: Request, res: Response) => {
    const row = await findOwnedGoal(deps.db, req, res);
    if (row) res.json({ goal: await serializeGoal(deps.db, row) });
  };

  const create = async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const validationError = validateCreateBody(body);
    if (validationError) return void res.status(400).json({ error: validationError });
    const ownerId = currentOwnerId(req);
    if (!ownerId) return void res.status(401).json({ error: 'Authentication required' });

    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();
    const agent = registry.getAgentById(body.agentId as string) || registry.getAgentByAlias(body.agentId as string);
    if (!agent) return void res.status(400).json({ error: 'Selected agent was not found' });
    if (!agent.config.supportedModels.includes(body.model as string) && agent.config.defaultModel !== body.model) {
      return void res.status(400).json({ error: 'Selected model is not supported by this agent' });
    }
    const capability = (await getCapabilities()).find(item => item.agentId === agent.config.id);
    if (!capability?.goalCapable) return void res.status(409).json({ error: capability?.reason || 'Selected agent does not support native /goal' });

    const [repoOwner, repoName] = (body.repository as string).split('/');
    try {
      const octokit = await getAuthenticatedOctokit();
      await octokit.request('GET /repos/{owner}/{repo}', { owner: repoOwner, repo: repoName });
    } catch {
      return void res.status(403).json({ error: 'Repository is not accessible to this ProPR installation' });
    }

    const goalId = randomUUID();
    const taskId = `goal-${goalId}`;
    const now = new Date().toISOString();
    const row = {
      goal_id: goalId,
      owner_id: ownerId,
      owner_login: req.user!.username,
      repository: body.repository,
      objective: body.objective as string,
      base_branch: body.baseBranch || null,
      agent_id: agent.config.id,
      agent_alias: agent.config.alias,
      agent_type: agent.config.type,
      requested_model: body.model,
      max_parallel_tasks: body.maxParallelTasks || null,
      ultrafix: body.ultrafix == null ? null : body.ultrafix,
      desired_state: 'running',
      current_task_id: taskId,
      run_generation: 0,
      artifact_refs: JSON.stringify([]),
      created_at: now,
      updated_at: now,
    };
    await deps.db('goals').insert(row);
    const data: GoalJobData = {
      goalId, taskId, repoOwner, repoName, generation: 0,
      input: buildNativeGoalCommand(row.objective),
    };
    try {
      await deps.taskQueue.add('processGoal', data, { jobId: goalJobId(goalId, 0) });
    } catch (error) {
      await deps.db('goals').where({ goal_id: goalId }).delete();
      throw error;
    }
    const inserted = await deps.db('goals').where({ goal_id: goalId }).first() as GoalRow;
    res.status(201).json({ goal: await serializeGoal(deps.db, inserted) });
  };

  const pause = async (req: Request, res: Response) => {
    const row = await findOwnedGoal(deps.db, req, res);
    if (!row) return;
    if (row.result_state || row.desired_state === 'cancelled') return void res.status(409).json({ error: 'Goal is terminal' });
    if (row.desired_state === 'paused') return void res.json({ goal: await serializeGoal(deps.db, row) });
    if (!row.session_id) {
      const activeJobs = await deps.taskQueue.getJobs(['active']);
      if (activeJobs.some(job => (job.data as Partial<GoalJobData>)?.taskId === row.current_task_id)) {
        return void res.status(409).json({ error: 'The provider session is still initializing; retry pause after its identity is persisted' });
      }
    }
    await deps.db('goals').where({ goal_id: row.goal_id, owner_id: row.owner_id }).update({ desired_state: 'paused', paused_at: deps.db.fn.now(), updated_at: deps.db.fn.now() });
    await stop(row.current_task_id, {
      redisClient: deps.redisClient,
      requestedBy: req.user!.username,
      reason: 'Goal pause requested. Stop at the current provider boundary.',
      cancellationReason: 'goal_paused',
      markCancelled: async () => undefined,
    });
    const updated = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id }).first();
    res.json({ goal: await serializeGoal(deps.db, updated!) });
  };

  async function enqueueContinuation(row: GoalRow, input: string, res: Response, continuationKind: 'run' | 'input' = 'run'): Promise<void> {
    if (row.session_id && !row.worktree_path) return void res.status(409).json({ error: 'Goal session has no saved worktree' });
    if (!row.session_id && row.started_at) return void res.status(409).json({ error: 'Goal has not persisted a resumable provider session yet' });
    const activeJobs = await deps.taskQueue.getJobs(['active']);
    if (activeJobs.some(job => (job.data as Partial<GoalJobData>)?.taskId === row.current_task_id)) {
      return void res.status(409).json({ error: 'Goal is still reaching a safe provider boundary; retry shortly' });
    }
    const generation = row.run_generation + 1;
    const completedPauseMs = row.paused_at ? Math.max(0, Date.now() - new Date(row.paused_at).getTime()) : 0;
    const changed = await deps.db('goals')
      .where({ goal_id: row.goal_id, owner_id: row.owner_id, run_generation: row.run_generation })
      .update({ desired_state: 'running', paused_at: null, paused_ms: Number(row.paused_ms || 0) + completedPauseMs, run_generation: generation, updated_at: deps.db.fn.now() });
    if (changed !== 1) return void res.status(409).json({ error: 'Goal continuation was already queued' });
    await deps.redisClient.del(`worker:abort:${row.current_task_id}`);
    const [repoOwner, repoName] = row.repository.split('/');
    try {
      await deps.taskQueue.add('processGoal', {
        goalId: row.goal_id, taskId: row.current_task_id, repoOwner, repoName, generation, input, continuationKind,
      } satisfies GoalJobData, { jobId: goalJobId(row.goal_id, generation) });
    } catch (error) {
      await deps.db('goals').where({ goal_id: row.goal_id, run_generation: generation }).update({
        desired_state: 'paused', paused_at: row.paused_at || deps.db.fn.now(), paused_ms: row.paused_ms || 0,
        run_generation: row.run_generation, updated_at: deps.db.fn.now(),
      });
      throw error;
    }
    const updated = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id }).first();
    res.json({ goal: await serializeGoal(deps.db, updated!) });
  }

  const resume = async (req: Request, res: Response) => {
    const row = await findOwnedGoal(deps.db, req, res);
    if (!row) return;
    if (row.result_state || row.desired_state === 'cancelled') return void res.status(409).json({ error: 'Goal is terminal' });
    if (row.desired_state !== 'paused') return void res.status(409).json({ error: 'Goal is not paused' });
    await enqueueContinuation(row, row.session_id ? GOAL_CONTINUE_INPUT : buildNativeGoalCommand(row.objective), res);
  };

  const cancel = async (req: Request, res: Response) => {
    const row = await findOwnedGoal(deps.db, req, res);
    if (!row) return;
    if (row.result_state === 'cancelled') return void res.json({ goal: await serializeGoal(deps.db, row) });
    if (row.result_state) return void res.status(409).json({ error: 'Goal is already complete' });
    const finalPauseMs = row.paused_at ? Math.max(0, Date.now() - new Date(row.paused_at).getTime()) : 0;
    await deps.db('goals').where({ goal_id: row.goal_id, owner_id: row.owner_id }).update({
      desired_state: 'cancelled', result_state: 'cancelled', paused_at: null,
      paused_ms: Number(row.paused_ms || 0) + finalPauseMs,
      completed_at: deps.db.fn.now(), updated_at: deps.db.fn.now(),
    });
    await stop(row.current_task_id, {
      redisClient: deps.redisClient,
      requestedBy: req.user!.username,
      reason: 'Goal cancelled by user.',
      cancellationReason: 'goal_cancelled',
      ensureCancelled: true,
    });
    const updated = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id }).first();
    res.json({ goal: await serializeGoal(deps.db, updated!) });
  };

  const requestModel = async (req: Request, res: Response) => {
    const row = await findOwnedGoal(deps.db, req, res);
    if (!row) return;
    if (row.result_state) return void res.status(409).json({ error: 'Goal is terminal' });
    const model = req.body?.model;
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();
    const agent = registry.getAgentById(row.agent_id);
    if (typeof model !== 'string' || !agent || (!agent.config.supportedModels.includes(model) && agent.config.defaultModel !== model)) return void res.status(400).json({ error: 'Unsupported model' });
    await deps.db('goals').where({ goal_id: row.goal_id, owner_id: row.owner_id }).update({ requested_model: model, updated_at: deps.db.fn.now() });
    const updated = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id }).first();
    res.json({ goal: await serializeGoal(deps.db, updated!) });
  };

  const input = async (req: Request, res: Response) => {
    const row = await findOwnedGoal(deps.db, req, res);
    if (!row) return;
    if (row.result_state || row.desired_state === 'cancelled') return void res.status(409).json({ error: 'Goal is terminal' });
    if (row.desired_state !== 'paused') return void res.status(409).json({ error: 'Pause the goal before sending a continuation' });
    const canned = req.body?.canned as keyof typeof cannedInputs | undefined;
    const message = canned ? cannedInputs[canned] : req.body?.message;
    if (typeof message !== 'string' || !message.trim() || message.length > 65_536) return void res.status(400).json({ error: 'A valid message or canned status request is required' });
    await enqueueContinuation(row, message.trim(), res, 'input');
  };

  return { capabilities, list, get, create, pause, resume, cancel, requestModel, input, requireGoalTaskOwnership };
}
