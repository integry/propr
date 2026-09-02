import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import type { Queue } from 'bullmq';
import {
  AgentRegistry,
  CODEX_GOAL_OBJECTIVE_MAX_LENGTH,
  GOAL_CONTINUE_INPUT,
  GOAL_LAUNCH_STRATEGIES,
  buildNativeGoalCommand,
  getAuthenticatedOctokit,
  goalJobId,
  type GoalCapability,
  type GoalJobData,
  type GoalLaunchStrategy,
  type Agent,
} from '@propr/core';
import type { RedisClientType } from 'redis';
import { stopTaskExecution, type StopTaskExecutionResult } from './dockerRoutes.js';
import { serializeGoal, type GoalProjectionRow as GoalRow } from '../services/goalProjection.js';

interface GoalRoutesDeps {
  db: Knex;
  taskQueue: Queue;
  redisClient: RedisClientType;
  getCapabilities?: () => Promise<GoalCapability[]>;
  stopExecution?: (taskId: string, options: Parameters<typeof stopTaskExecution>[1]) => Promise<StopTaskExecutionResult>;
}

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const cannedInputs = {
  done: "What's done?",
  left: "What's left?",
} as const;

function currentOwnerId(req: Request): string | null {
  return req.user?.id ? String(req.user.id) : null;
}

function requestIdempotencyKey(req: Request): string | null {
  const value = req.get('Idempotency-Key');
  return value && value.length <= 255 ? value : null;
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
  if (!GOAL_LAUNCH_STRATEGIES.includes(body.launchStrategy as GoalLaunchStrategy)) return 'launchStrategy must be direct or orchestrate';
  if (typeof body.agentId !== 'string' || !body.agentId) return 'agentId is required';
  if (typeof body.model !== 'string' || !body.model) return 'model is required';
  if (body.baseBranch != null && (typeof body.baseBranch !== 'string' || body.baseBranch.length > 255)) return 'baseBranch is invalid';
  if (body.maxParallelTasks != null && (!Number.isSafeInteger(body.maxParallelTasks) || Number(body.maxParallelTasks) < 1 || Number(body.maxParallelTasks) > 32)) return 'maxParallelTasks must be an integer from 1 to 32';
  if (body.ultrafix != null && typeof body.ultrafix !== 'boolean') return 'ultrafix must be a boolean';
  return null;
}

type AgentSelection = { agent: Agent } | { error: string; status: number };

async function resolveCreationAgent(
  body: Record<string, unknown>,
  getCapabilities: () => Promise<GoalCapability[]>,
): Promise<AgentSelection> {
  const registry = AgentRegistry.getInstance();
  await registry.ensureInitialized();
  const agent = registry.getAgentById(body.agentId as string) || registry.getAgentByAlias(body.agentId as string);
  if (!agent) return { error: 'Selected agent was not found', status: 400 };
  if (agent.config.type === 'codex' && (body.objective as string).length > CODEX_GOAL_OBJECTIVE_MAX_LENGTH) {
    return { error: `Codex goal objectives must be at most ${CODEX_GOAL_OBJECTIVE_MAX_LENGTH} characters`, status: 400 };
  }
  if (!agent.config.supportedModels.includes(body.model as string) && agent.config.defaultModel !== body.model) {
    return { error: 'Selected model is not supported by this agent', status: 400 };
  }
  const capability = (await getCapabilities()).find(item => item.agentId === agent.config.id);
  if (!capability?.goalCapable) {
    return { error: capability?.reason || 'Selected agent does not support native /goal', status: 409 };
  }
  return { agent };
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
    if (taskId) {
      goal = await deps.db('goals').select('goal_id', 'owner_id').where({ current_task_id: taskId }).first() as Pick<GoalRow, 'goal_id' | 'owner_id'> | undefined;
    } else if (sessionId) {
      goal = await deps.db('goals')
        .select('goal_id', 'owner_id')
        .where({ session_id: sessionId })
        .orWhere({ conversation_id: sessionId })
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
    res.json({ goals: await Promise.all(rows.map(row => serializeGoal(deps.db, deps.redisClient, row))) });
  };

  const get = async (req: Request, res: Response) => {
    const row = await findOwnedGoal(deps.db, req, res);
    if (row) res.json({ goal: await serializeGoal(deps.db, deps.redisClient, row) });
  };

  const create = async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const validationError = validateCreateBody(body);
    if (validationError) return void res.status(400).json({ error: validationError });
    const ownerId = currentOwnerId(req);
    if (!ownerId) return void res.status(401).json({ error: 'Authentication required' });
    const createKey = requestIdempotencyKey(req) ?? randomUUID();
    const existing = await deps.db<GoalRow>('goals').where({
      owner_id: ownerId,
      create_idempotency_key: createKey,
    }).first();
    if (existing) return void res.json({ goal: await serializeGoal(deps.db, deps.redisClient, existing) });

    const selection = await resolveCreationAgent(body, getCapabilities);
    if ('error' in selection) return void res.status(selection.status).json({ error: selection.error });
    const { agent } = selection;

    const [repoOwner, repoName] = (body.repository as string).split('/');
    try {
      const octokit = await getAuthenticatedOctokit();
      await octokit.request('GET /repos/{owner}/{repo}', { owner: repoOwner, repo: repoName });
    } catch {
      return void res.status(403).json({ error: 'Repository is not accessible to this ProPR installation' });
    }

    const goalId = randomUUID();
    const claimId = randomUUID();
    const taskId = `goal-${goalId}`;
    const now = new Date().toISOString();
    const launchStrategy = body.launchStrategy as GoalLaunchStrategy;
    const initialPrompt = buildNativeGoalCommand({
      objective: body.objective as string,
      launchStrategy,
      maxParallelTasks: body.maxParallelTasks as number | null | undefined,
      ultrafix: body.ultrafix === true,
    });
    const row = {
      goal_id: goalId,
      owner_id: ownerId,
      owner_login: req.user!.username,
      repository: body.repository,
      objective: body.objective as string,
      launch_strategy: launchStrategy,
      initial_prompt: initialPrompt,
      base_branch: body.baseBranch || null,
      agent_id: agent.config.id,
      agent_alias: agent.config.alias,
      agent_type: agent.config.type,
      requested_model: body.model,
      max_parallel_tasks: body.maxParallelTasks || null,
      ultrafix: body.ultrafix === true,
      desired_state: 'running',
      current_task_id: taskId,
      run_generation: 0,
      run_claim: claimId,
      create_idempotency_key: createKey,
      artifact_refs: JSON.stringify([]),
      artifact_stats: JSON.stringify({ issues: 0, openIssues: 0, pullRequests: 0, openPullRequests: 0 }),
      created_at: now,
      updated_at: now,
    };
    try {
      await deps.db('goals').insert(row);
    } catch (error) {
      const raced = await deps.db<GoalRow>('goals').where({
        owner_id: ownerId,
        create_idempotency_key: createKey,
      }).first();
      if (raced) return void res.json({ goal: await serializeGoal(deps.db, deps.redisClient, raced) });
      throw error;
    }
    const data: GoalJobData = {
      goalId, taskId, repoOwner, repoName, generation: 0, claimId,
      input: initialPrompt,
    };
    try {
      await deps.taskQueue.add('processGoal', data, { jobId: goalJobId(goalId, 0), attempts: 1 });
    } catch {
      return void res.status(503).json({
        error: 'Goal was saved but its first attempt could not be queued; recovery will retry it safely',
        goalId,
      });
    }
    const inserted = await deps.db('goals').where({ goal_id: goalId }).first() as GoalRow;
    res.status(201).json({ goal: await serializeGoal(deps.db, deps.redisClient, inserted) });
  };

  const pause = async (req: Request, res: Response) => {
    const row = await findOwnedGoal(deps.db, req, res);
    if (!row) return;
    if (row.result_state || row.desired_state === 'cancelled') return void res.status(409).json({ error: 'Goal is terminal' });
    if (row.desired_state === 'paused') return void res.json({ goal: await serializeGoal(deps.db, deps.redisClient, row) });
    const changed = await deps.db('goals').where({
      goal_id: row.goal_id,
      owner_id: row.owner_id,
      run_generation: row.run_generation,
      run_claim: row.run_claim,
      desired_state: 'running',
    }).whereNull('result_state').update({
      desired_state: 'paused',
      paused_at: deps.db.fn.now(),
      pause_confirmed_at: row.claimed_at ? null : deps.db.fn.now(),
      updated_at: deps.db.fn.now(),
    });
    if (changed !== 1) return void res.status(409).json({ error: 'Goal state changed before pause could be claimed' });
    // Codex pauses through native turn/interrupt. Other proven providers stop
    // their resumable noninteractive invocation and resume the exact session.
    if (row.agent_type !== 'codex' && row.claimed_at) {
      await stop(row.current_task_id, {
        redisClient: deps.redisClient,
        requestedBy: req.user!.username,
        reason: 'Goal pause requested at the provider boundary.',
        cancellationReason: 'goal_paused',
        markCancelled: async () => undefined,
      });
    }
    const updated = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id }).first();
    res.json({ goal: await serializeGoal(deps.db, deps.redisClient, updated!) });
  };

  async function addGoalInput(row: GoalRow, req: Request, message: string, kind: 'input' | 'resume'): Promise<void> {
    const key = requestIdempotencyKey(req) ?? randomUUID();
    const existing = await deps.db('goal_inputs').where({
      goal_id: row.goal_id, owner_id: row.owner_id, idempotency_key: key,
    }).first('input_id');
    if (existing) return;
    try {
      await deps.db('goal_inputs').insert({
        input_id: randomUUID(),
        goal_id: row.goal_id,
        owner_id: row.owner_id,
        idempotency_key: key,
        kind,
        message,
        state: 'pending',
        created_at: deps.db.fn.now(),
      });
    } catch (error) {
      const raced = await deps.db('goal_inputs').where({
        goal_id: row.goal_id, owner_id: row.owner_id, idempotency_key: key,
      }).first('input_id');
      if (!raced) throw error;
    }
  }

  async function beginPausedContinuation(row: GoalRow): Promise<boolean> {
    const generation = row.run_generation + 1;
    const claimId = randomUUID();
    const completedPauseMs = row.paused_at ? Math.max(0, Date.now() - new Date(row.paused_at).getTime()) : 0;
    const changed = await deps.db('goals')
      .where({
        goal_id: row.goal_id, owner_id: row.owner_id, run_generation: row.run_generation,
        run_claim: row.run_claim, desired_state: 'paused',
      })
      .whereNull('result_state')
      .whereNotNull('pause_confirmed_at')
      .update({
        desired_state: 'running', paused_at: null,
        paused_ms: Number(row.paused_ms || 0) + completedPauseMs,
        run_generation: generation, run_claim: claimId, claimed_at: null,
        attempt_heartbeat_at: null, active_turn_id: null, pause_confirmed_at: null,
        resume_requested: false, updated_at: deps.db.fn.now(),
      });
    if (changed !== 1) return false;
    await deps.redisClient.del(`worker:abort:${row.current_task_id}`);
    const [repoOwner, repoName] = row.repository.split('/');
    await deps.taskQueue.add('processGoal', {
      goalId: row.goal_id, taskId: row.current_task_id, repoOwner, repoName,
      generation, claimId, recovery: false,
    } satisfies GoalJobData, { jobId: goalJobId(row.goal_id, generation), attempts: 1 });
    return true;
  }

  const resume = async (req: Request, res: Response) => {
    const row = await findOwnedGoal(deps.db, req, res);
    if (!row) return;
    const idempotencyKey = requestIdempotencyKey(req);
    if (idempotencyKey) {
      const prior = await deps.db('goal_inputs').where({
        goal_id: row.goal_id,
        owner_id: row.owner_id,
        idempotency_key: idempotencyKey,
        kind: 'resume',
      }).first('input_id');
      if (prior) return void res.json({ goal: await serializeGoal(deps.db, deps.redisClient, row) });
    }
    if (row.result_state || row.desired_state === 'cancelled') return void res.status(409).json({ error: 'Goal is terminal' });
    if (row.desired_state !== 'paused') return void res.status(409).json({ error: 'Goal is not paused' });
    await addGoalInput(row, req, row.session_id ? GOAL_CONTINUE_INPUT : row.initial_prompt, 'resume');
    await deps.db('goals').where({
      goal_id: row.goal_id, owner_id: row.owner_id, run_generation: row.run_generation,
      run_claim: row.run_claim, desired_state: 'paused',
    }).whereNull('result_state').update({ resume_requested: true, updated_at: deps.db.fn.now() });
    const latest = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id }).first();
    if (latest?.pause_confirmed_at) await beginPausedContinuation(latest);
    const updated = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id }).first();
    res.json({ goal: await serializeGoal(deps.db, deps.redisClient, updated!) });
  };

  const cancel = async (req: Request, res: Response) => {
    const row = await findOwnedGoal(deps.db, req, res);
    if (!row) return;
    if (row.result_state === 'cancelled') return void res.json({ goal: await serializeGoal(deps.db, deps.redisClient, row) });
    if (row.result_state) return void res.status(409).json({ error: 'Goal is already complete' });
    const finalPauseMs = row.paused_at ? Math.max(0, Date.now() - new Date(row.paused_at).getTime()) : 0;
    const changed = await deps.db('goals').where({
      goal_id: row.goal_id, owner_id: row.owner_id,
      run_generation: row.run_generation, run_claim: row.run_claim,
    }).whereNull('result_state').update({
      desired_state: 'cancelled', result_state: 'cancelled', paused_at: null,
      paused_ms: Number(row.paused_ms || 0) + finalPauseMs,
      completed_at: deps.db.fn.now(), updated_at: deps.db.fn.now(),
    });
    if (changed !== 1) return void res.status(409).json({ error: 'Goal state changed before cancellation could be claimed' });
    await stop(row.current_task_id, {
      redisClient: deps.redisClient,
      requestedBy: req.user!.username,
      reason: 'Goal cancelled by user.',
      cancellationReason: 'goal_cancelled',
      ensureCancelled: true,
    });
    const updated = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id }).first();
    res.json({ goal: await serializeGoal(deps.db, deps.redisClient, updated!) });
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
    const changed = await deps.db('goals').where({
      goal_id: row.goal_id, owner_id: row.owner_id,
      run_generation: row.run_generation, run_claim: row.run_claim,
    }).whereNull('result_state').update({ requested_model: model, updated_at: deps.db.fn.now() });
    if (changed !== 1) return void res.status(409).json({ error: 'Goal state changed before the model request was saved' });
    const updated = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id }).first();
    res.json({ goal: await serializeGoal(deps.db, deps.redisClient, updated!) });
  };

  const input = async (req: Request, res: Response) => {
    const row = await findOwnedGoal(deps.db, req, res);
    if (!row) return;
    if (row.result_state || row.desired_state === 'cancelled') return void res.status(409).json({ error: 'Goal is terminal' });
    const canned = req.body?.canned as keyof typeof cannedInputs | undefined;
    const message = canned ? cannedInputs[canned] : req.body?.message;
    if (typeof message !== 'string' || !message.trim() || message.length > 65_536) return void res.status(400).json({ error: 'A valid message or canned status request is required' });
    await addGoalInput(row, req, message.trim(), 'input');
    if (row.desired_state === 'paused') {
      await deps.db('goals').where({
        goal_id: row.goal_id, owner_id: row.owner_id,
        run_generation: row.run_generation, run_claim: row.run_claim,
        desired_state: 'paused',
      }).whereNull('result_state').update({ resume_requested: true, updated_at: deps.db.fn.now() });
      const latest = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id }).first();
      if (latest?.pause_confirmed_at) await beginPausedContinuation(latest);
    }
    const updated = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id }).first();
    res.json({ goal: await serializeGoal(deps.db, deps.redisClient, updated!) });
  };

  return { capabilities, list, get, create, pause, resume, cancel, requestModel, input, requireGoalTaskOwnership };
}
