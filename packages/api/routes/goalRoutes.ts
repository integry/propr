import { goalPreviewSource, previewMediaReader } from '../services/previewMediaProjection.js';
/* eslint-disable max-lines -- goal creation and lifecycle controls share one owner-scoped HTTP boundary */
import { createHash, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import type { Queue } from 'bullmq';
import {
  AgentRegistry,
  GOAL_CONTINUE_INPUT,
  GOAL_KINDS,
  DEFAULT_GOAL_CHECKPOINT_INTERVAL_MINUTES,
  GOAL_LAUNCH_STRATEGIES,
  MAX_GOAL_CHECKPOINT_INTERVAL_MINUTES,
  MIN_GOAL_CHECKPOINT_INTERVAL_MINUTES,
  buildNativeGoalCommand,
  buildNativeGoalContext,
  hasNativeGoalControl,
  nativeGoalObjectiveMaxLength,
  nativeGoalPromptValidationError,
  generateGoalTitle,
  getAuthenticatedOctokit,
  goalTitleFallback,
  goalJobId,
  loadRepositoryVisualPreviewSettings,
  logger,
  parsePublishedVisualPreviews,
  type GoalCapability,
  type GoalJobData,
  type GoalKind,
  type GoalLaunchStrategy,
  type Agent,
  type MulterFile,
} from '@propr/core';
import type { RedisClientType } from 'redis';
import { timeApiStage } from '../apiPerformanceTiming.js';
import { stopTaskExecution, type StopTaskExecutionResult } from './dockerRoutes.js';
import { serializeGoal, type GoalProjectionRow as GoalRow } from '../services/goalProjection.js';
import {
  appendGoalAttachments,
  deleteGoalAttachmentDirectory,
  deleteGoalAttachments,
  getGoalAttachmentContent,
  goalUploadIdentity,
  parseGoalAttachments,
  processGoalUploads,
  removeTemporaryGoalUploads,
  type GoalAttachment,
} from '../services/goalAttachmentService.js';

interface GoalRoutesDeps {
  db: Knex;
  previewReader?: typeof previewMediaReader;
  taskQueue: Queue;
  redisClient: RedisClientType;
  getCapabilities?: (options?: { force?: boolean }) => Promise<GoalCapability[]>;
  generateTitle?: typeof generateGoalTitle;
  stopExecution?: (taskId: string, options: Parameters<typeof stopTaskExecution>[1]) => Promise<StopTaskExecutionResult>;
  processAttachments?: typeof processGoalUploads;
  uploadIdentity?: typeof goalUploadIdentity;
  removeTemporaryUploads?: typeof removeTemporaryGoalUploads;
  loadVisualPreviewSettings?: typeof loadRepositoryVisualPreviewSettings;
  getOctokit?: typeof getAuthenticatedOctokit;
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

function requiredIdempotencyKey(req: Request, res: Response): string | null {
  const key = requestIdempotencyKey(req);
  if (!key) res.status(400).json({ error: 'A valid Idempotency-Key header is required' });
  return key;
}

function mutationHash(operation: string, payload: Record<string, unknown>): string {
  return createHash('sha256').update(`${operation}\n${JSON.stringify(payload)}`).digest('hex');
}

class IdempotencyConflictError extends Error {}

async function resolveGoalTitle(
  generateTitle: typeof generateGoalTitle,
  options: Parameters<typeof generateGoalTitle>[0],
): Promise<string> {
  try {
    return await generateTitle(options);
  } catch (error) {
    logger.warn({ goalId: options.correlationId, error: (error as Error).message }, 'Failed to generate goal title; using bounded objective fallback');
    return goalTitleFallback(options.objective);
  }
}

// eslint-disable-next-line max-params -- the mutation identity tuple is deliberately explicit at this persistence boundary
async function existingMutation(
  db: Knex,
  row: GoalRow,
  key: string,
  operation: string,
  payloadHash: string,
): Promise<{ state?: string } | null> {
  const createUse = await db('goals').where({ owner_id: row.owner_id, create_idempotency_key: key }).first('goal_id');
  if (createUse) {
    throw new IdempotencyConflictError('Idempotency-Key was already used for a different goal, operation, or payload');
  }
  const existing = await db('goal_inputs').where({ owner_id: row.owner_id, idempotency_key: key }).first();
  if (!existing) {
    const checkpoint = await db('goal_checkpoints').where({ owner_id: row.owner_id, idempotency_key: key }).first();
    if (!checkpoint) return null;
    if (checkpoint.goal_id !== row.goal_id || checkpoint.operation !== operation || checkpoint.payload_hash !== payloadHash) {
      throw new IdempotencyConflictError('Idempotency-Key was already used for a different goal, operation, or payload');
    }
    return checkpoint;
  }
  if (existing.goal_id !== row.goal_id || existing.operation !== operation || existing.payload_hash !== payloadHash) {
    throw new IdempotencyConflictError('Idempotency-Key was already used for a different goal, operation, or payload');
  }
  return existing;
}

// eslint-disable-next-line max-params -- the mutation identity tuple is deliberately explicit at this persistence boundary
async function recordControlMutation(
  db: Knex,
  row: GoalRow,
  key: string,
  operation: string,
  payloadHash: string,
): Promise<void> {
  try {
    await db('goal_inputs').insert({
      input_id: randomUUID(), goal_id: row.goal_id, owner_id: row.owner_id,
      idempotency_key: key, operation, payload_hash: payloadHash,
      kind: 'control', message: '', state: 'delivered', created_at: db.fn.now(), delivered_at: db.fn.now(),
    });
  } catch (error) {
    if (!await existingMutation(db, row, key, operation, payloadHash)) throw error;
  }
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
  return validateCreateLaunchOptions(body);
}

function validateCreateLaunchOptions(body: Record<string, unknown>): string | null {
  return validateCreateKind(body) ?? validateCreateCheckpointInterval(body);
}

function validateCreateKind(body: Record<string, unknown>): string | null {
  if (body.kind != null && !GOAL_KINDS.includes(body.kind as GoalKind)) return 'kind must be goal or task';
  if (body.kind === 'task' && body.launchStrategy !== 'direct') return 'tasks must use the direct launch strategy';
  return null;
}

function validateCreateCheckpointInterval(body: Record<string, unknown>): string | null {
  if (body.checkpointIntervalMinutes == null) return null;
  if (body.launchStrategy !== 'direct') return 'checkpointIntervalMinutes only applies to direct goals';
  if (!Number.isSafeInteger(body.checkpointIntervalMinutes)
    || Number(body.checkpointIntervalMinutes) < MIN_GOAL_CHECKPOINT_INTERVAL_MINUTES
    || Number(body.checkpointIntervalMinutes) > MAX_GOAL_CHECKPOINT_INTERVAL_MINUTES) {
    return `checkpointIntervalMinutes must be an integer from ${MIN_GOAL_CHECKPOINT_INTERVAL_MINUTES} to ${MAX_GOAL_CHECKPOINT_INTERVAL_MINUTES}`;
  }
  return null;
}

function buildCreateIdentity(
  body: Record<string, unknown>,
  attachmentIdentity: readonly Record<string, unknown>[] = [],
): { operation: string; payloadHash: string } {
  const operation = 'goal.create';
  const payloadHash = mutationHash(operation, {
    repository: body.repository, objective: body.objective, launchStrategy: body.launchStrategy,
    agentId: body.agentId, model: body.model, baseBranch: body.baseBranch ?? null,
    maxParallelTasks: body.maxParallelTasks ?? null, ultrafix: body.ultrafix === true,
    checkpointIntervalMinutes: body.launchStrategy === 'direct'
      ? body.checkpointIntervalMinutes ?? DEFAULT_GOAL_CHECKPOINT_INTERVAL_MINUTES
      : null,
    ...(attachmentIdentity.length > 0 ? { attachments: attachmentIdentity } : {}),
    ...(body.kind === 'task' ? { kind: 'task' } : {}),
  });
  return { operation, payloadHash };
}

async function findExistingGoalCreation(options: {
  db: Knex;
  ownerId: string;
  key: string;
  operation: string;
  payloadHash: string;
}): Promise<GoalRow | null> {
  const { db, ownerId, key, operation, payloadHash } = options;
  const inputUse = await db('goal_inputs').where({ owner_id: ownerId, idempotency_key: key }).first('input_id');
  const checkpointUse = await db('goal_checkpoints').where({ owner_id: ownerId, idempotency_key: key }).first('checkpoint_id');
  if (inputUse || checkpointUse) {
    throw new IdempotencyConflictError('Idempotency-Key was already used for a different operation or payload');
  }
  const existing = await db<GoalRow>('goals').where({
    owner_id: ownerId,
    create_idempotency_key: key,
  }).first();
  if (existing
    && (existing.create_idempotency_operation !== operation || existing.create_payload_hash !== payloadHash)) {
    throw new IdempotencyConflictError('Idempotency-Key was already used for a different operation or payload');
  }
  return existing ?? null;
}

type AgentSelection = { agent: Agent } | { error: string; status: number };

async function resolveCreationAgent(
  body: Record<string, unknown>,
  getCapabilities: () => Promise<GoalCapability[]>,
  initialPrompt: string,
): Promise<AgentSelection> {
  const registry = AgentRegistry.getInstance();
  await registry.ensureInitialized();
  const agent = registry.getAgentById(body.agentId as string) || registry.getAgentByAlias(body.agentId as string);
  if (!agent) return { error: 'Selected agent was not found', status: 400 };
  const promptError = nativeGoalPromptValidationError(agent.config.type, initialPrompt);
  if (promptError) return { error: promptError, status: 400 };
  if (!agent.config.supportedModels.includes(body.model as string) && agent.config.defaultModel !== body.model) {
    return { error: 'Selected model is not supported by this agent', status: 400 };
  }
  const capability = (await getCapabilities()).find(item => item.agentId === agent.config.id);
  if (!capability?.goalCapable) {
    return { error: capability?.reason || 'Selected agent does not support the required goal/session contract', status: 409 };
  }
  return { agent };
}

export function createGoalRoutes(deps: GoalRoutesDeps) {
  const getCapabilities = deps.getCapabilities ?? (async (options?: { force?: boolean }) => {
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();
    return registry.getGoalCapabilities(options);
  });
  const stop = deps.stopExecution ?? stopTaskExecution;
  const storeAttachments = deps.processAttachments ?? processGoalUploads;
  const identifyUploads = deps.uploadIdentity ?? goalUploadIdentity;
  const cleanupTemporaryUploads = deps.removeTemporaryUploads ?? removeTemporaryGoalUploads;
  const loadVisualPreviewSettings = deps.loadVisualPreviewSettings ?? loadRepositoryVisualPreviewSettings;
  const getOctokit = deps.getOctokit ?? getAuthenticatedOctokit;

  const uploadedFiles = (req: Request): MulterFile[] => Array.isArray(req.files)
    ? req.files as MulterFile[]
    : [];

  const requestBody = (req: Request): Record<string, unknown> => {
    if (typeof req.body?.payload !== 'string') return (req.body ?? {}) as Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(req.body.payload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* handled below */ }
    throw new Error('payload must be valid JSON');
  };

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

  const capabilities = async (req: Request, res: Response) => {
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();
    const detected = await getCapabilities({ force: req.query?.recheck === 'true' });
    const agents = detected.map(capability => {
      const agent = registry.getAgentById(capability.agentId);
      return {
        ...capability,
        models: agent?.config.supportedModels ?? [],
        defaultModel: agent?.config.defaultModel ?? null,
        objectiveMaxCharacters: capability.goalCapable ? nativeGoalObjectiveMaxLength(capability.agentType) : null,
      };
    });
    res.json({ agents });
  };

  const list = async (req: Request, res: Response) => {
    const ownerId = currentOwnerId(req);
    if (!ownerId) return void res.status(401).json({ error: 'Authentication required' });
    const kind = req.query?.kind;
    if (kind != null && !GOAL_KINDS.includes(kind as GoalKind)) {
      return void res.status(400).json({ error: 'kind must be goal or task' });
    }
    const rows = await timeApiStage('sql.goals.list', () => {
      const query = deps.db<GoalRow>('goals').where({ owner_id: ownerId });
      if (kind) query.where({ kind: kind as GoalKind });
      return query.orderBy('updated_at', 'desc').limit(200);
    });
    const goals = await timeApiStage('goals.projection', () =>
      Promise.all(rows.map(row => serializeGoal(deps.db, deps.redisClient, row)))
    );
    const media = await (deps.previewReader ?? previewMediaReader).project(rows.map(goalPreviewSource), 3);
    res.json({ goals: goals.map((goal, index) => ({ ...goal,
      ...(media[index].previews.length ? { previewMedia: media[index].previews } : {}),
    })) });
  };

  const get = async (req: Request, res: Response) => {
    const row = await findOwnedGoal(deps.db, req, res);
    if (row) res.json({ goal: await serializeGoal(deps.db, deps.redisClient, row) });
  };

  const previews = async (req: Request, res: Response) => {
    const row = await findOwnedGoal(deps.db, req, res);
    if (!row) return;
    if (!(await loadVisualPreviewSettings(row.repository)).enabled || !row.final_pr_number) return void res.json({ previews: [] });
    try {
      const [owner, repo] = row.repository.split('/');
      const octokit = await getOctokit();
      const response = await octokit.request(
        'GET /repos/{owner}/{repo}/pulls/{pull_number}',
        { owner, repo, pull_number: row.final_pr_number },
      ) as { data: { body?: string | null } };
      res.json({ previews: parsePublishedVisualPreviews(response.data.body) });
    } catch (error) {
      logger.warn({
        goalId: row.goal_id,
        pullRequestNumber: row.final_pr_number,
        error: (error as Error).message,
      }, 'Could not fetch goal visual previews from GitHub');
      res.json({ previews: [], unavailable: true });
    }
  };

  // eslint-disable-next-line complexity -- creation coordinates idempotency, capability checks, durable files, and queue publication
  const createGoal = async (req: Request, res: Response, files: MulterFile[]) => {
    let body: Record<string, unknown>;
    try { body = requestBody(req); } catch (error) {
      return void res.status(400).json({ error: (error as Error).message });
    }
    const validationError = validateCreateBody(body);
    if (validationError) return void res.status(400).json({ error: validationError });
    const ownerId = currentOwnerId(req);
    if (!ownerId) return void res.status(401).json({ error: 'Authentication required' });
    const createKey = requiredIdempotencyKey(req, res);
    if (!createKey) return;
    const attachmentIdentity = await identifyUploads(files);
    const { operation: createOperation, payloadHash: createPayloadHash } = buildCreateIdentity(body, attachmentIdentity);
    let existing: GoalRow | null;
    try {
      existing = await findExistingGoalCreation({
        db: deps.db, ownerId, key: createKey, operation: createOperation, payloadHash: createPayloadHash,
      });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) return void res.status(409).json({ error: error.message });
      throw error;
    }
    if (existing) return void res.json({ goal: await serializeGoal(deps.db, deps.redisClient, existing) });

    const launchStrategy = body.launchStrategy as GoalLaunchStrategy;
    const kind: GoalKind = body.kind === 'task' ? 'task' : 'goal';
    const promptOptions = {
      objective: body.objective as string,
      kind,
      launchStrategy,
      maxParallelTasks: body.maxParallelTasks as number | null | undefined,
      ultrafix: body.ultrafix === true,
      checkpointIntervalMinutes: body.checkpointIntervalMinutes as number | null | undefined,
      visualPreviewSettings: await loadVisualPreviewSettings(body.repository as string),
    };
    const initialPrompt = buildNativeGoalCommand(promptOptions);
    const baseInitialContext = buildNativeGoalContext(promptOptions);
    const selection = await resolveCreationAgent(body, getCapabilities, initialPrompt);
    if ('error' in selection) return void res.status(selection.status).json({ error: selection.error });
    const { agent } = selection;

    const [repoOwner, repoName] = (body.repository as string).split('/');
    try {
      const octokit = await getOctokit();
      await octokit.request('GET /repos/{owner}/{repo}', { owner: repoOwner, repo: repoName });
    } catch {
      return void res.status(403).json({ error: 'Repository is not accessible to this ProPR installation' });
    }

    const goalId = randomUUID();
    const claimId = randomUUID();
    const taskId = `goal-${goalId}`;
    const now = new Date().toISOString();
    const title = await resolveGoalTitle(deps.generateTitle ?? generateGoalTitle, {
      objective: body.objective as string,
      repository: body.repository as string,
      taskId,
      correlationId: goalId,
    });
    let attachments: GoalAttachment[] = [];
    let attachmentsPersisted = false;
    try {
      attachments = await storeAttachments(files, goalId);
      const initialContext = appendGoalAttachments(baseInitialContext, attachments);
      const contextOperation = 'goal.context';
      const contextKey = `goal-initial-context:${goalId}`;
      const contextPayloadHash = mutationHash(contextOperation, { goalId, message: initialContext });
      const row = {
        goal_id: goalId,
        owner_id: ownerId,
        owner_login: req.user!.username,
        repository: body.repository,
        title,
        objective: body.objective as string,
        launch_strategy: launchStrategy,
        // The column defaults to goal, so only one-off tasks need an explicit kind.
        ...(kind === 'task' ? { kind } : {}),
        initial_prompt: initialPrompt,
        attachments: JSON.stringify(attachments),
        base_branch: body.baseBranch || null,
        agent_id: agent.config.id,
        agent_alias: agent.config.alias,
        agent_type: agent.config.type,
        requested_model: body.model,
        max_parallel_tasks: body.maxParallelTasks || null,
        ultrafix: body.ultrafix === true,
        checkpoint_interval_minutes: launchStrategy === 'direct'
          ? body.checkpointIntervalMinutes ?? DEFAULT_GOAL_CHECKPOINT_INTERVAL_MINUTES
          : null,
        desired_state: 'running',
        current_task_id: taskId,
        run_generation: 0,
        run_claim: claimId,
        create_idempotency_key: createKey,
        create_idempotency_operation: createOperation,
        create_payload_hash: createPayloadHash,
        artifact_refs: JSON.stringify([]),
        artifact_stats: JSON.stringify({ issues: 0, openIssues: 0, pullRequests: 0, openPullRequests: 0 }),
        created_at: now,
        updated_at: now,
      };
      try {
        await deps.db.transaction(async trx => {
          await trx('goals').insert(row);
          await trx('goal_inputs').insert({
            input_id: randomUUID(),
            goal_id: goalId,
            owner_id: ownerId,
            idempotency_key: contextKey,
            operation: contextOperation,
            payload_hash: contextPayloadHash,
            kind: 'context',
            message: initialContext,
            state: 'pending',
            created_at: now,
          });
        });
        attachmentsPersisted = true;
        logger.info({
          goalId,
          agentType: agent.config.type,
          initialPromptCharacters: Array.from(initialPrompt).length,
          initialContextCharacters: Array.from(initialContext).length,
        }, 'Created goal with separate objective and delivery-context messages');
      } catch (error) {
        const raced = await deps.db<GoalRow>('goals').where({
          owner_id: ownerId,
          create_idempotency_key: createKey,
        }).first();
        if (raced) {
          if (raced.create_idempotency_operation !== createOperation || raced.create_payload_hash !== createPayloadHash) {
            return void res.status(409).json({ error: 'Idempotency-Key was already used for a different operation or payload' });
          }
          return void res.json({ goal: await serializeGoal(deps.db, deps.redisClient, raced) });
        }
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
    } finally {
      if (!attachmentsPersisted) await deleteGoalAttachments(attachments);
    }
  };

  const create = async (req: Request, res: Response) => {
    const files = uploadedFiles(req);
    try {
      await createGoal(req, res, files);
    } catch (error) {
      logger.warn({ error: (error as Error).message }, 'Could not create goal with attachments');
      if (!res.headersSent) {
        const message = (error as Error).message || 'Could not process goal attachments';
        const status = /not supported|unsupported|outside|invalid|file/i.test(message) ? 400 : 500;
        res.status(status).json({ error: message });
      }
    } finally {
      await cleanupTemporaryUploads(files);
    }
  };

  const pause = async (req: Request, res: Response) => {
    const row = await findOwnedGoal(deps.db, req, res);
    if (!row) return;
    const key = requiredIdempotencyKey(req, res);
    if (!key) return;
    const operation = 'goal.pause';
    const payloadHash = mutationHash(operation, { goalId: row.goal_id });
    try {
      if (await existingMutation(deps.db, row, key, operation, payloadHash) && row.pause_confirmed_at) {
        return void res.json({ goal: await serializeGoal(deps.db, deps.redisClient, row) });
      }
    } catch (error) {
      if (error instanceof IdempotencyConflictError) return void res.status(409).json({ error: error.message });
      throw error;
    }
    if (row.result_state || row.desired_state === 'cancelled') return void res.status(409).json({ error: 'Goal is terminal' });
    if (row.desired_state !== 'paused') {
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
    }
    // Native goal providers pause through an interrupt on their live control
    // channel. Other proven providers stop their resumable noninteractive
    // invocation and resume the exact session.
    if (!hasNativeGoalControl(row.agent_type) && row.claimed_at && row.session_id && !row.pause_confirmed_at) {
      await stop(row.current_task_id, {
        redisClient: deps.redisClient,
        requestedBy: req.user!.username,
        reason: 'Goal pause requested at the provider boundary.',
        cancellationReason: 'goal_paused',
        markCancelled: async () => undefined,
      });
    }
    await recordControlMutation(deps.db, row, key, operation, payloadHash);
    const updated = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id }).first();
    res.json({ goal: await serializeGoal(deps.db, deps.redisClient, updated!) });
  };

  async function addGoalInput(options: {
    row: GoalRow;
    key: string;
    message: string;
    kind: 'input' | 'resume';
    payloadHash?: string;
    attachments?: GoalAttachment[];
  }): Promise<'inserted' | 'pending' | 'settled'> {
    const { row, key, message, kind } = options;
    const operation = `goal.${kind}`;
    const payloadHash = options.payloadHash ?? mutationHash(operation, { goalId: row.goal_id, message });
    const existing = await existingMutation(deps.db, row, key, operation, payloadHash);
    if (existing) return existing.state === 'pending' ? 'pending' : 'settled';
    try {
      await deps.db.transaction(async trx => {
        await trx('goal_inputs').insert({
          input_id: randomUUID(),
          goal_id: row.goal_id,
          owner_id: row.owner_id,
          idempotency_key: key,
          operation,
          payload_hash: payloadHash,
          kind,
          message,
          state: 'pending',
          created_at: trx.fn.now(),
        });
        if (options.attachments?.length) {
          const current = await trx('goals').where({ goal_id: row.goal_id, owner_id: row.owner_id }).first('attachments');
          const attachments = [...parseGoalAttachments(current?.attachments), ...options.attachments];
          await trx('goals').where({ goal_id: row.goal_id, owner_id: row.owner_id }).update({
            attachments: JSON.stringify(attachments),
            updated_at: trx.fn.now(),
          });
        }
      });
    } catch (error) {
      if (!await existingMutation(deps.db, row, key, operation, payloadHash)) throw error;
      const raced = await existingMutation(deps.db, row, key, operation, payloadHash);
      return raced?.state === 'pending' ? 'pending' : 'settled';
    }
    return 'inserted';
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
    const idempotencyKey = requiredIdempotencyKey(req, res);
    if (!idempotencyKey) return;
    const nativeResume = hasNativeGoalControl(row.agent_type) && Boolean(row.session_id);
    const resumeMessage = row.session_id || row.claimed_at ? GOAL_CONTINUE_INPUT : row.initial_prompt;
    const resumeOperation = 'goal.resume';
    const resumePayloadHash = mutationHash(resumeOperation, {
      goalId: row.goal_id,
      ...(nativeResume ? { transport: 'native-goal' } : { message: resumeMessage }),
    });
    let resumeInserted = false;
    try {
      resumeInserted = !await existingMutation(deps.db, row, idempotencyKey, resumeOperation, resumePayloadHash);
    } catch (error) {
      if (error instanceof IdempotencyConflictError) return void res.status(409).json({ error: error.message });
      throw error;
    }
    if (!resumeInserted && row.desired_state === 'running') {
      return void res.json({ goal: await serializeGoal(deps.db, deps.redisClient, row) });
    }
    if (row.result_state || row.desired_state === 'cancelled') return void res.status(409).json({ error: 'Goal is terminal' });
    if (row.desired_state !== 'paused') return void res.status(409).json({ error: 'Goal is not paused' });
    if (resumeInserted) {
      if (nativeResume) {
        await recordControlMutation(deps.db, row, idempotencyKey, resumeOperation, resumePayloadHash);
      } else {
        await addGoalInput({ row, key: idempotencyKey, message: resumeMessage, kind: 'resume' });
      }
    }
    await deps.db('goals').where({
      goal_id: row.goal_id, owner_id: row.owner_id, run_generation: row.run_generation,
      run_claim: row.run_claim, desired_state: 'paused',
    }).whereNull('result_state').update({
      resume_requested: true,
      ...(resumeInserted ? { control_generation: deps.db.raw('control_generation + 1') } : {}),
      updated_at: deps.db.fn.now(),
    });
    const latest = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id }).first();
    if (latest?.pause_confirmed_at) await beginPausedContinuation(latest);
    const updated = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id }).first();
    res.json({ goal: await serializeGoal(deps.db, deps.redisClient, updated!) });
  };

  const cancel = async (req: Request, res: Response) => {
    const row = await findOwnedGoal(deps.db, req, res);
    if (!row) return;
    const key = requiredIdempotencyKey(req, res);
    if (!key) return;
    const operation = 'goal.cancel';
    const payloadHash = mutationHash(operation, { goalId: row.goal_id });
    try {
      if (await existingMutation(deps.db, row, key, operation, payloadHash) && row.result_state === 'cancelled') {
        return void res.json({ goal: await serializeGoal(deps.db, deps.redisClient, row) });
      }
    } catch (error) {
      if (error instanceof IdempotencyConflictError) return void res.status(409).json({ error: error.message });
      throw error;
    }
    if (row.result_state === 'cancelled') return void res.json({ goal: await serializeGoal(deps.db, deps.redisClient, row) });
    if (row.result_state) return void res.status(409).json({ error: 'Goal is already complete' });
    const finalPauseMs = row.paused_at ? Math.max(0, Date.now() - new Date(row.paused_at).getTime()) : 0;
    if (row.desired_state !== 'cancelled') {
      const changed = await deps.db('goals').where({
        goal_id: row.goal_id, owner_id: row.owner_id,
        run_generation: row.run_generation, run_claim: row.run_claim,
      }).whereNull('result_state').update({
        desired_state: 'cancelled', paused_at: null,
        paused_ms: Number(row.paused_ms || 0) + finalPauseMs,
        updated_at: deps.db.fn.now(),
      });
      if (changed !== 1) return void res.status(409).json({ error: 'Goal state changed before cancellation could be claimed' });
    }
    // A live native goal session (Codex App Server, Claude stream-json)
    // interrupts its turn and clears the goal itself. Session-resume providers
    // use the existing container stop path because they have no native goal
    // control plane.
    const stopped = hasNativeGoalControl(row.agent_type) && row.claimed_at
      ? {
        success: true, taskId: row.current_task_id, containerStopped: false,
        removedQueuedJobs: 0, message: 'Native goal clear requested',
      }
      : await stop(row.current_task_id, {
        redisClient: deps.redisClient,
        requestedBy: req.user!.username,
        reason: 'Goal cancelled by user.',
        cancellationReason: 'goal_cancelled',
        ensureCancelled: true,
      });
    // A signalled worker has not necessarily crossed its stop boundary yet.
    // Leave the goal nonterminal so both an HTTP retry and leased recovery keep
    // reconciling cleanup. Directly stopped/not-running work can finalize now.
    if (stopped.containerStopped || stopped.notRunning || stopped.notFound || stopped.removedQueuedJobs > 0) {
      await deps.db('goals').where({
        goal_id: row.goal_id, owner_id: row.owner_id,
        run_generation: row.run_generation, run_claim: row.run_claim,
        desired_state: 'cancelled',
      }).whereNull('result_state').update({
        result_state: 'cancelled', completed_at: deps.db.fn.now(),
        updated_at: deps.db.fn.now(),
      });
    }
    await recordControlMutation(deps.db, row, key, operation, payloadHash);
    const updated = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id }).first();
    res.json({ goal: await serializeGoal(deps.db, deps.redisClient, updated!) });
  };

  const remove = async (req: Request, res: Response) => {
    const row = await findOwnedGoal(deps.db, req, res);
    if (!row) return;
    const needsStop = !row.result_state && (
      row.desired_state === 'running'
      || row.desired_state === 'cancelled'
      || (row.desired_state === 'paused' && !row.pause_confirmed_at)
    );
    if (needsStop) {
      if (row.desired_state !== 'cancelled') {
        const fenced = await deps.db('goals').where({
          goal_id: row.goal_id, owner_id: row.owner_id,
          run_generation: row.run_generation, run_claim: row.run_claim,
        }).whereNull('result_state').update({
          desired_state: 'cancelled', paused_at: null, updated_at: deps.db.fn.now(),
        });
        if (fenced !== 1) return void res.status(409).json({ error: 'Goal state changed before deletion could stop it' });
      }
      const stopped = await stop(row.current_task_id, {
        redisClient: deps.redisClient,
        requestedBy: req.user!.username,
        reason: 'Goal stopped before deletion.',
        cancellationReason: 'goal_deleted',
        ensureCancelled: true,
      });
      if (stopped.abortSignalled && !stopped.containerStopped) {
        return void res.status(409).json({
          error: 'Goal is still stopping',
          message: 'The stop request was sent. Try deleting the goal again after the active execution has stopped.',
        });
      }
    }
    await deps.db.transaction(async trx => {
      await trx('goals').where({ goal_id: row.goal_id, owner_id: row.owner_id }).delete();
      await trx('llm_execution_details').whereIn('execution_id', function selectGoalExecutions() {
        this.select('execution_id').from('llm_executions').where({ task_id: row.current_task_id });
      }).delete();
      await trx('llm_executions').where({ task_id: row.current_task_id }).delete();
      await trx('task_history').where({ task_id: row.current_task_id }).delete();
      await trx('tasks').where({ task_id: row.current_task_id }).delete();
    });
    await deleteGoalAttachmentDirectory(row.goal_id).catch(error => {
      logger.warn({ goalId: row.goal_id, error: (error as Error).message }, 'Could not remove deleted goal attachments');
    });
    res.status(204).send();
  };

  // eslint-disable-next-line complexity -- model changes coordinate persisted state, provider stop semantics, and idempotency
  const requestModel = async (req: Request, res: Response) => {
    const row = await findOwnedGoal(deps.db, req, res);
    if (!row) return;
    const key = requiredIdempotencyKey(req, res);
    if (!key) return;
    const model = req.body?.model;
    const operation = 'goal.model';
    const payloadHash = mutationHash(operation, { goalId: row.goal_id, model });
    try {
      if (await existingMutation(deps.db, row, key, operation, payloadHash)) {
        return void res.json({ goal: await serializeGoal(deps.db, deps.redisClient, row) });
      }
    } catch (error) {
      if (error instanceof IdempotencyConflictError) return void res.status(409).json({ error: error.message });
      throw error;
    }
    if (row.result_state) return void res.status(409).json({ error: 'Goal is terminal' });
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();
    const agent = registry.getAgentById(row.agent_id);
    if (typeof model !== 'string' || !agent || (!agent.config.supportedModels.includes(model) && agent.config.defaultModel !== model)) return void res.status(400).json({ error: 'Unsupported model' });
    const changed = await deps.db('goals').where({
      goal_id: row.goal_id, owner_id: row.owner_id,
      run_generation: row.run_generation, run_claim: row.run_claim,
    }).whereNull('result_state').update({
      requested_model: model,
      control_generation: deps.db.raw('control_generation + 1'),
      ...(row.desired_state === 'running' ? {
        desired_state: 'paused', paused_at: deps.db.fn.now(),
        pause_confirmed_at: row.claimed_at ? null : deps.db.fn.now(), resume_requested: true,
      } : {}),
      updated_at: deps.db.fn.now(),
    });
    if (changed !== 1) return void res.status(409).json({ error: 'Goal state changed before the model request was saved' });
    if (row.desired_state === 'running' && !hasNativeGoalControl(row.agent_type) && row.claimed_at && row.session_id) {
      await stop(row.current_task_id, {
        redisClient: deps.redisClient, requestedBy: req.user!.username,
        reason: 'Goal model change requested at the next provider boundary.',
        cancellationReason: 'goal_control_boundary', markCancelled: async () => undefined,
      });
    }
    const modelBoundary = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id }).first();
    if (modelBoundary?.desired_state === 'paused' && modelBoundary.pause_confirmed_at && modelBoundary.resume_requested) {
      await beginPausedContinuation(modelBoundary);
    }
    await recordControlMutation(deps.db, row, key, operation, payloadHash);
    const updated = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id }).first();
    res.json({ goal: await serializeGoal(deps.db, deps.redisClient, updated!) });
  };

  // eslint-disable-next-line complexity -- input delivery branches by persisted lifecycle and provider resume capability
  const addInput = async (req: Request, res: Response, files: MulterFile[]) => {
    const row = await findOwnedGoal(deps.db, req, res);
    if (!row) return;
    const key = requiredIdempotencyKey(req, res);
    if (!key) return;
    if (row.result_state || row.desired_state === 'cancelled') return void res.status(409).json({ error: 'Goal is terminal' });
    let body: Record<string, unknown>;
    try { body = requestBody(req); } catch (error) {
      return void res.status(400).json({ error: (error as Error).message });
    }
    const canned = body.canned as keyof typeof cannedInputs | undefined;
    const message = canned ? cannedInputs[canned] : body.message;
    if (typeof message !== 'string' || !message.trim() || message.length > 65_536) return void res.status(400).json({ error: 'A valid message or canned status request is required' });
    const operation = 'goal.input';
    const attachmentIdentity = await identifyUploads(files);
    const payloadHash = mutationHash(operation, {
      goalId: row.goal_id,
      message: message.trim(),
      ...(attachmentIdentity.length > 0 ? { attachments: attachmentIdentity } : {}),
    });
    let inputDisposition: 'inserted' | 'pending' | 'settled';
    let attachments: GoalAttachment[] = [];
    try {
      const existing = await existingMutation(deps.db, row, key, operation, payloadHash);
      if (existing) {
        inputDisposition = existing.state === 'pending' ? 'pending' : 'settled';
      } else {
        attachments = await storeAttachments(files, row.goal_id);
        const deliveredMessage = appendGoalAttachments(message.trim(), attachments);
        if (deliveredMessage.length > 65_536) {
          await deleteGoalAttachments(attachments);
          attachments = [];
          return void res.status(400).json({ error: 'Message and attachment references are too long' });
        }
        inputDisposition = await addGoalInput({
          row, key, message: deliveredMessage, kind: 'input', payloadHash, attachments,
        });
        if (inputDisposition !== 'inserted') await deleteGoalAttachments(attachments);
      }
    } catch (error) {
      await deleteGoalAttachments(attachments);
      if (error instanceof IdempotencyConflictError) return void res.status(409).json({ error: error.message });
      throw error;
    }
    if (inputDisposition === 'settled'
      || (inputDisposition === 'pending' && row.desired_state === 'running' && !row.claimed_at)) {
      const current = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id, owner_id: row.owner_id }).first();
      return void res.json({ goal: await serializeGoal(deps.db, deps.redisClient, current!) });
    }
    if (row.desired_state === 'paused') {
      await deps.db('goals').where({
        goal_id: row.goal_id, owner_id: row.owner_id,
        run_generation: row.run_generation, run_claim: row.run_claim,
        desired_state: 'paused',
      }).whereNull('result_state').update({
        resume_requested: true,
        ...(inputDisposition === 'inserted' || !row.resume_requested
          ? { control_generation: deps.db.raw('control_generation + 1') }
          : {}),
        updated_at: deps.db.fn.now(),
      });
      if (!hasNativeGoalControl(row.agent_type) && row.claimed_at && !row.pause_confirmed_at) {
        await stop(row.current_task_id, {
          redisClient: deps.redisClient, requestedBy: req.user!.username,
          reason: 'Goal input queued for the next provider boundary.',
          cancellationReason: 'goal_control_boundary', markCancelled: async () => undefined,
        });
      }
      const latest = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id }).first();
      if (latest?.pause_confirmed_at) await beginPausedContinuation(latest);
    } else if (hasNativeGoalControl(row.agent_type)) {
      if (inputDisposition === 'inserted') await deps.db('goals').where({
        goal_id: row.goal_id, owner_id: row.owner_id,
        run_generation: row.run_generation, run_claim: row.run_claim, desired_state: 'running',
      }).whereNull('result_state').update({
        control_generation: deps.db.raw('control_generation + 1'), updated_at: deps.db.fn.now(),
      });
    } else if (!row.session_id) {
      // Accept input even before the provider identity is emitted. The first
      // invocation must still receive the immutable initial goal prompt; once
      // its identity is durable the worker stops and resumes that exact session.
      if (inputDisposition === 'inserted') await deps.db('goals').where({
        goal_id: row.goal_id, owner_id: row.owner_id,
        run_generation: row.run_generation, run_claim: row.run_claim, desired_state: 'running',
      }).whereNull('result_state').update({
        control_generation: deps.db.raw('control_generation + 1'), updated_at: deps.db.fn.now(),
      });
      const identified = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id }).first();
      if (identified?.session_id && identified.desired_state === 'running') {
        const paused = await deps.db('goals').where({
          goal_id: identified.goal_id, owner_id: identified.owner_id,
          run_generation: identified.run_generation, run_claim: identified.run_claim,
          desired_state: 'running',
        }).whereNull('result_state').update({
          desired_state: 'paused', paused_at: deps.db.fn.now(),
          pause_confirmed_at: identified.claimed_at ? null : deps.db.fn.now(), resume_requested: true,
          updated_at: deps.db.fn.now(),
        });
        if (paused === 1 && identified.claimed_at) await stop(identified.current_task_id, {
          redisClient: deps.redisClient, requestedBy: req.user!.username,
          reason: 'Goal input queued for exact whole-session resume.',
          cancellationReason: 'goal_control_boundary', markCancelled: async () => undefined,
        });
        const boundary = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id }).first();
        if (paused === 1 && boundary?.pause_confirmed_at) await beginPausedContinuation(boundary);
      }
    } else {
      await deps.db('goals').where({
        goal_id: row.goal_id, owner_id: row.owner_id,
        run_generation: row.run_generation, run_claim: row.run_claim, desired_state: 'running',
      }).whereNull('result_state').update({
        desired_state: 'paused', paused_at: deps.db.fn.now(),
        pause_confirmed_at: row.claimed_at ? null : deps.db.fn.now(), resume_requested: true,
        control_generation: deps.db.raw('control_generation + 1'), updated_at: deps.db.fn.now(),
      });
      if (row.claimed_at) {
        await stop(row.current_task_id, {
          redisClient: deps.redisClient, requestedBy: req.user!.username,
          reason: 'Goal input queued for the next provider boundary.',
          cancellationReason: 'goal_control_boundary', markCancelled: async () => undefined,
        });
      }
      const inputBoundary = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id }).first();
      if (inputBoundary?.pause_confirmed_at) await beginPausedContinuation(inputBoundary);
    }
    const updated = await deps.db<GoalRow>('goals').where({ goal_id: row.goal_id }).first();
    res.json({ goal: await serializeGoal(deps.db, deps.redisClient, updated!) });
  };

  const input = async (req: Request, res: Response) => {
    const files = uploadedFiles(req);
    try {
      await addInput(req, res, files);
    } catch (error) {
      logger.warn({ error: (error as Error).message }, 'Could not send goal input with attachments');
      if (!res.headersSent) {
        const message = (error as Error).message || 'Could not process goal attachments';
        const status = /not supported|unsupported|outside|invalid|file/i.test(message) ? 400 : 500;
        res.status(status).json({ error: message });
      }
    } finally {
      await cleanupTemporaryUploads(files);
    }
  };

  const attachment = async (req: Request, res: Response) => {
    const row = await findOwnedGoal(deps.db, req, res);
    if (!row) return;
    const attachmentId = Array.isArray(req.params.attachmentId) ? req.params.attachmentId[0] : req.params.attachmentId;
    const item = parseGoalAttachments(row.attachments).find(candidate => candidate.id === attachmentId);
    if (!item) return void res.status(404).json({ error: 'Attachment not found' });
    try {
      const content = await getGoalAttachmentContent(item);
      res.setHeader('Content-Type', item.mimeType);
      res.setHeader('Content-Disposition', `inline; filename=${JSON.stringify(item.originalName)}`);
      res.send(content);
    } catch (error) {
      logger.warn({ goalId: row.goal_id, attachmentId, error: (error as Error).message }, 'Could not read goal attachment');
      res.status(404).json({ error: 'Attachment not found' });
    }
  };

  return {
    capabilities, list, get, previews, create, pause, resume, cancel, remove, requestModel, input, attachment,
    requireGoalTaskOwnership,
  };
}
