/* eslint-disable max-lines -- agent definitions, their input files and their runs share one owner-scoped HTTP boundary */
import path from 'node:path';
import fs from 'fs-extra';
import type { Request, RequestHandler, Response } from 'express';
import type { Knex } from 'knex';
import type { RedisClientType } from 'redis';
import {
  AttachmentService,
  changeAgentDefinitionAttachments,
  createAgentDefinition,
  deleteAgentDefinitionUnlessRunInStates,
  enqueueAgentRunActionOrFail,
  getAgentDefinition,
  getAgentRun,
  listAgentDefinitions,
  listAgentRuns,
  logger,
  transitionAgentRun,
  triggerAgentRun,
  updateAgentDefinition,
  validateAgentDefinitionRuntime,
  type AgentDefinitionPatch,
  type AgentRunGate,
  type Attachment,
  type MulterFile,
  type StoredAgentDefinition,
  type StoredAgentRun,
  type TriggerAgentRunInput,
  type TriggerAgentRunResult,
} from '@propr/core';
import {
  AGENT_ACTION_OPERATOR_NOTE_MAX_CHARS,
  AGENT_DEFINITION_CONTRACT,
  DEFAULT_AGENT_PREVIOUS_REPORTS,
  MAX_AGENT_ATTACHMENTS,
  validateAgentDefinitionInput,
  type AgentDefinitionInput,
  type AgentRunState,
  type AgentRunTrigger,
} from '@propr/shared';
import {
  handleGitHubRepositoryAccessError,
  resolveGitHubMetadataToken,
  verifyGitHubRepositoryAccess,
} from '../githubMetadataAuth.js';
import { stopTaskExecution, type StopTaskExecutionResult } from './dockerRoutes.js';
import { goalAttachmentUpload } from './plannerRoutes.js';
import { publicGoalAttachments, removeTemporaryGoalUploads } from '../services/goalAttachmentService.js';

/**
 * REST surface for Agents: definitions, their input files and their runs.
 * `/api/agents/*` belongs to coding-agent operations, so Agents live under
 * `/api/agent-definitions` and `/api/agent-runs`.
 *
 * Every route is owner-scoped: another user's definition or run answers 404,
 * never 403, so existence is not leaked. Handlers stay thin; the core stores
 * and `triggerAgentRun` do the work.
 */

export const AGENT_DEFINITION_ATTACHMENT_ROOT = path.join(process.cwd(), 'storage', 'agent-definitions');

/** Triggers a REST caller may name; `schedule` and `mcp` belong to the daemon and MCP. */
const REST_AGENT_RUN_TRIGGERS = ['manual', 'api', 'cli'] as const satisfies readonly AgentRunTrigger[];
const TRIGGER_SOURCE_MAX_LENGTH = 255;
const IDEMPOTENCY_KEY_MAX_LENGTH = 255;
/** Runs that own a live agent container; their definition cannot be deleted under them. */
const ACTIVE_AGENT_RUN_STATES: readonly AgentRunState[] = ['running', 'acting'];
const CANCELLABLE_AGENT_RUN_STATES: readonly AgentRunState[] = ['queued', 'deferred', 'running', 'awaiting_approval', 'acting'];
/** Cancel retries when the run keeps moving between the read and the guarded transition. */
const MAX_CANCEL_ATTEMPTS = 5;

type StopTask = (taskId: string, options: Parameters<typeof stopTaskExecution>[1]) => Promise<StopTaskExecutionResult>;

export interface AgentDefinitionRouteServices {
  verifyAccess?: (repository: string, accessToken: string) => Promise<void>;
  resolveToken?: (req: Request) => Promise<string>;
  trigger?: (input: TriggerAgentRunInput) => Promise<TriggerAgentRunResult>;
  validateRuntime?: (definition: StoredAgentDefinition) => Promise<string | null>;
  stopTask?: StopTask;
  /** Cost gate for triggered runs; attached by the usage gate. */
  gate?: AgentRunGate;
  processUpload?: (file: MulterFile, definitionId: string) => Promise<Attachment>;
  removeTemporaryUploads?: (files: readonly MulterFile[]) => Promise<void>;
  removeAttachmentFiles?: (definitionId: string, attachments: readonly Attachment[] | 'all') => Promise<void>;
  /** Enqueues the acting step of an approved run, failing the run when that is impossible. */
  startActing?: (run: StoredAgentRun, operatorNote: string | null) => Promise<StoredAgentRun>;
  now?: () => number;
}

export interface AgentDefinitionRoutesDeps {
  db: Knex;
  /** Needed by the default `stopTask` to stop a running run's task. */
  redisClient?: RedisClientType;
  services?: AgentDefinitionRouteServices;
}

class RouteError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

/** Multer for agent input files: same types and limits as goal attachments, with a JSON 400 on rejection. */
export const agentDefinitionAttachmentUpload: RequestHandler = (req, res, next) => {
  goalAttachmentUpload(req, res, error => {
    if (!error) { next(); return; }
    const files = (Array.isArray(req.files) ? req.files : []) as MulterFile[];
    void removeTemporaryGoalUploads(files).finally(() => res.status(400).json({ error: (error as Error).message }));
  });
};

function ownerId(req: Request): string | null {
  return req.user?.id ? String(req.user.id) : null;
}

function requireOwner(req: Request): string {
  const owner = ownerId(req);
  if (!owner) throw new RouteError(401, 'Authentication required');
  return owner;
}

function sendError(res: Response, error: unknown, fallback: string): void {
  const status = (error as { status?: unknown })?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const code = (error as { code?: unknown }).code;
    res.status(status).json({ error: (error as Error).message, ...(typeof code === 'string' ? { code } : {}) });
    return;
  }
  logger.error({ err: error }, fallback);
  res.status(500).json({ error: fallback });
}

function parsePage(query: Request['query']): { limit?: number; offset?: number } {
  const page: { limit?: number; offset?: number } = {};
  for (const key of ['limit', 'offset'] as const) {
    const raw = query[key];
    if (raw === undefined) continue;
    const value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(value) || (key === 'limit' && value < 1)) {
      throw new RouteError(400, `${key} must be a ${key === 'limit' ? 'positive' : 'non-negative'} integer`);
    }
    page[key] = value;
  }
  return page;
}

function has(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
}

/** Map the shared input contract onto the store's columns; only present fields are mapped. */
export function agentDefinitionInputToPatch(body: Partial<AgentDefinitionInput>): AgentDefinitionPatch {
  const input = body as Record<string, unknown>;
  const patch: AgentDefinitionPatch = {};
  if (has(input, 'name')) patch.name = body.name!.trim();
  if (has(input, 'description')) patch.description = body.description?.trim() || null;
  if (has(input, 'prompt')) patch.prompt = body.prompt;
  if (has(input, 'repositories')) patch.repositories = body.repositories;
  if (has(input, 'capabilities')) patch.capabilities = body.capabilities;
  if (has(input, 'autonomy')) patch.autonomyMode = body.autonomy;
  if (has(input, 'schedule')) {
    patch.scheduleCron = body.schedule ?? null;
    patch.scheduleEnabled = body.schedule != null;
  }
  if (has(input, 'enabled')) patch.enabled = body.enabled;
  if (has(input, 'agentId')) patch.agentAlias = body.agentId ?? null;
  if (has(input, 'model')) patch.modelName = body.model ?? null;
  if (has(input, 'previousReportCount')) {
    patch.previousReportsLimit = body.previousReportCount;
    patch.includePreviousReports = body.previousReportCount! > 0;
  }
  return patch;
}

/** Fields that change whether the definition can run against the live configuration. */
const RUNTIME_FIELDS: readonly (keyof AgentDefinitionPatch)[] = ['repositories', 'agentAlias', 'modelName', 'capabilities', 'autonomyMode', 'enabled'];

function sameRepositories(left: readonly string[], right: readonly string[]): boolean {
  const normalize = (repositories: readonly string[]) => [...new Set(repositories.map(repository => repository.toLowerCase()))].sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

/** Stored paths are server internals; clients only see attachment metadata. */
export function publicAgentDefinition(definition: StoredAgentDefinition) {
  return { ...definition, attachments: publicGoalAttachments(definition.attachments) };
}

export function publicAgentRun(run: StoredAgentRun, { includeReport }: { includeReport: boolean }) {
  const snapshot = run.definitionSnapshot ? publicAgentDefinition(run.definitionSnapshot) : null;
  if (includeReport) return { ...run, definitionSnapshot: snapshot };
  // History rows stay light: the report and the definition snapshot are only in the run detail.
  const summary: Partial<StoredAgentRun> = { ...run };
  delete summary.report;
  delete summary.definitionSnapshot;
  return summary;
}

async function defaultProcessUpload(file: MulterFile, definitionId: string): Promise<Attachment> {
  return AttachmentService.processUpload(file, definitionId, {
    storageRoot: AGENT_DEFINITION_ATTACHMENT_ROOT,
    persistAttachment: async () => undefined,
  });
}

function attachmentPath(definitionId: string, attachment: Attachment): string | null {
  const directory = path.join(AGENT_DEFINITION_ATTACHMENT_ROOT, path.basename(definitionId));
  const resolved = path.resolve(process.cwd(), attachment.storedPath);
  return resolved.startsWith(`${directory}${path.sep}`) ? resolved : null;
}

async function defaultRemoveAttachmentFiles(definitionId: string, attachments: readonly Attachment[] | 'all'): Promise<void> {
  if (attachments === 'all') {
    await fs.remove(path.join(AGENT_DEFINITION_ATTACHMENT_ROOT, path.basename(definitionId)));
    return;
  }
  await Promise.all(attachments.map(attachment => {
    const file = attachmentPath(definitionId, attachment);
    return file ? fs.remove(file).catch(() => undefined) : undefined;
  }));
}

function requestedTrigger(req: Request, body: Record<string, unknown>): AgentRunTrigger {
  if (body.trigger === undefined || body.trigger === null) {
    return req.authenticationMethod === 'session' ? 'manual' : 'api';
  }
  if (!REST_AGENT_RUN_TRIGGERS.includes(body.trigger as typeof REST_AGENT_RUN_TRIGGERS[number])) {
    throw new RouteError(400, `trigger must be one of: ${REST_AGENT_RUN_TRIGGERS.join(', ')}`);
  }
  return body.trigger as AgentRunTrigger;
}

function requestIdempotencyKey(req: Request): string | null {
  const key = req.get('Idempotency-Key');
  if (key === undefined || key === '') return null;
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new RouteError(400, `Idempotency-Key must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`);
  }
  return key;
}

function operatorNote(body: Record<string, unknown>): string | null {
  if (body.note === undefined || body.note === null) return null;
  if (typeof body.note !== 'string' || body.note.length > AGENT_ACTION_OPERATOR_NOTE_MAX_CHARS) {
    throw new RouteError(400, `note must be a string of at most ${AGENT_ACTION_OPERATOR_NOTE_MAX_CHARS} characters`);
  }
  return body.note.trim() || null;
}

function requestBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body ?? {};
  if (typeof body !== 'object' || Array.isArray(body)) throw new RouteError(400, 'Request body must be a JSON object');
  return body as Record<string, unknown>;
}

export function createAgentDefinitionRoutes(deps: AgentDefinitionRoutesDeps) {
  const database = deps.db;
  const services = deps.services ?? {};
  const now = services.now ?? Date.now;
  const storeDeps = { database, now };
  const verifyAccess = services.verifyAccess ?? ((repository: string, token: string) => verifyGitHubRepositoryAccess(repository, token));
  const resolveToken = services.resolveToken ?? ((req: Request) => resolveGitHubMetadataToken(req));
  const trigger = services.trigger ?? ((input: TriggerAgentRunInput) => triggerAgentRun(input, storeDeps));
  const validateRuntime = services.validateRuntime ?? ((definition: StoredAgentDefinition) => validateAgentDefinitionRuntime(definition));
  const stopTask: StopTask = services.stopTask ?? stopTaskExecution;
  const processUpload = services.processUpload ?? defaultProcessUpload;
  const removeTemporaryUploads = services.removeTemporaryUploads ?? removeTemporaryGoalUploads;
  const removeAttachmentFiles = services.removeAttachmentFiles ?? defaultRemoveAttachmentFiles;
  const startActing = services.startActing
    ?? ((run: StoredAgentRun, note: string | null) => enqueueAgentRunActionOrFail(run, { ...storeDeps, operatorNote: note }));

  /**
   * The user's GitHub grant must be able to read every repository, exactly
   * like planner context repositories. Returns false when the response was
   * already sent (inaccessible repository or missing authorization).
   */
  async function verifyRepositories(req: Request, res: Response, repositories: readonly string[]): Promise<boolean> {
    if (repositories.length === 0) return true;
    try {
      const token = await resolveToken(req);
      for (const repository of repositories) await verifyAccess(repository, token);
      return true;
    } catch (error) {
      if (await handleGitHubRepositoryAccessError(req, res, error)) return false;
      throw error;
    }
  }

  async function requireDefinition(req: Request, owner: string): Promise<StoredAgentDefinition> {
    const definition = await getAgentDefinition(String(req.params.id), owner, storeDeps);
    if (!definition) throw new RouteError(404, 'Agent definition not found');
    return definition;
  }

  async function requireRuntimeValid(definition: StoredAgentDefinition): Promise<void> {
    const invalid = await validateRuntime(definition);
    if (invalid) throw new RouteError(400, invalid, 'AGENT_INVALID');
  }

  function handler(fallback: string, run: (req: Request, res: Response) => Promise<void>): RequestHandler {
    return async (req, res) => {
      try {
        await run(req, res);
      } catch (error) {
        if (!res.headersSent) sendError(res, error, fallback);
      }
    };
  }

  const list = handler('Failed to list agent definitions', async (req, res) => {
    const owner = requireOwner(req);
    const page = await listAgentDefinitions(owner, parsePage(req.query), storeDeps);
    res.json({ ...page, definitions: page.definitions.map(publicAgentDefinition) });
  });

  const contract = handler('Failed to load the agent definition contract', async (req, res) => {
    requireOwner(req);
    res.json(AGENT_DEFINITION_CONTRACT);
  });

  const create = handler('Failed to create agent definition', async (req, res) => {
    const owner = requireOwner(req);
    const body = requestBody(req);
    const validationError = validateAgentDefinitionInput(body);
    if (validationError) throw new RouteError(400, validationError);
    const patch = agentDefinitionInputToPatch(body as unknown as AgentDefinitionInput);
    const input = {
      ownerId: owner,
      ...patch,
      name: patch.name!,
      prompt: patch.prompt!,
      previousReportsLimit: patch.previousReportsLimit ?? DEFAULT_AGENT_PREVIOUS_REPORTS,
      includePreviousReports: patch.includePreviousReports ?? DEFAULT_AGENT_PREVIOUS_REPORTS > 0,
    };

    // Check the would-be definition against the live config before it exists.
    const timestamp = now();
    const candidate: StoredAgentDefinition = {
      id: '', ownerId: owner, name: input.name, description: input.description ?? null,
      repositories: input.repositories ?? [], prompt: input.prompt, attachments: [],
      agentAlias: input.agentAlias ?? null, modelName: input.modelName ?? null,
      capabilities: input.capabilities ?? [...AGENT_DEFINITION_CONTRACT.defaultCapabilities],
      includePreviousReports: input.includePreviousReports, previousReportsLimit: input.previousReportsLimit,
      scheduleCron: input.scheduleCron ?? null, scheduleTimezone: 'UTC', scheduleEnabled: input.scheduleEnabled ?? false,
      nextRunAt: null, autonomyMode: input.autonomyMode ?? AGENT_DEFINITION_CONTRACT.defaultAutonomyMode,
      enabled: input.enabled ?? true, revision: 0, createdAt: timestamp, updatedAt: timestamp,
    };
    await requireRuntimeValid(candidate);
    if (!await verifyRepositories(req, res, candidate.repositories)) return;

    const definition = await createAgentDefinition(input, storeDeps);
    res.status(201).json({ definition: publicAgentDefinition(definition) });
  });

  const get = handler('Failed to load agent definition', async (req, res) => {
    const definition = await requireDefinition(req, requireOwner(req));
    res.json({ definition: publicAgentDefinition(definition) });
  });

  const update = handler('Failed to update agent definition', async (req, res) => {
    const owner = requireOwner(req);
    const { expectedRevision, ...body } = requestBody(req);
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0)) {
      throw new RouteError(400, 'expectedRevision must be a non-negative integer');
    }
    const validationError = validateAgentDefinitionInput(body, { partial: true });
    if (validationError) throw new RouteError(400, validationError);
    const current = await requireDefinition(req, owner);
    const patch = agentDefinitionInputToPatch(body as Partial<AgentDefinitionInput>);

    if (RUNTIME_FIELDS.some(field => patch[field] !== undefined)) {
      await requireRuntimeValid({ ...current, ...patch } as StoredAgentDefinition);
    }
    if (patch.repositories !== undefined && !sameRepositories(patch.repositories, current.repositories)) {
      if (!await verifyRepositories(req, res, patch.repositories)) return;
    }

    const definition = await updateAgentDefinition(current.id, owner, patch, {
      ...storeDeps,
      expectedRevision: expectedRevision as number | undefined,
    });
    if (!definition) throw new RouteError(404, 'Agent definition not found');
    res.json({ definition: publicAgentDefinition(definition) });
  });

  const remove = handler('Failed to delete agent definition', async (req, res) => {
    const owner = requireOwner(req);
    const definition = await requireDefinition(req, owner);
    // The active-run check is part of the delete itself, so a run starting concurrently cannot be cascaded away.
    const outcome = await deleteAgentDefinitionUnlessRunInStates(definition.id, owner, ACTIVE_AGENT_RUN_STATES, storeDeps);
    if (outcome === 'run_active') {
      throw new RouteError(409, 'Agent has a run in progress; cancel it before deleting the agent', 'AGENT_RUN_ACTIVE');
    }
    if (outcome === 'not_found') throw new RouteError(404, 'Agent definition not found');
    await removeAttachmentFiles(definition.id, 'all').catch(error => {
      logger.warn({ definitionId: definition.id, err: error }, 'Failed to remove agent definition input files');
    });
    res.status(204).end();
  });

  const uploadAttachments = handler('Failed to upload agent input files', async (req, res) => {
    const files = (Array.isArray(req.files) ? req.files : req.file ? [req.file] : []) as MulterFile[];
    const processed: Attachment[] = [];
    try {
      const owner = requireOwner(req);
      const definition = await requireDefinition(req, owner);
      if (files.length === 0) throw new RouteError(400, 'No files uploaded');
      if (definition.attachments.length + files.length > MAX_AGENT_ATTACHMENTS) {
        throw new RouteError(400, `An agent can have at most ${MAX_AGENT_ATTACHMENTS} input files`);
      }
      for (const file of files) {
        try {
          processed.push(await processUpload(file, definition.id));
        } catch (error) {
          // Unsupported or binary content is the caller's fault.
          throw new RouteError(400, (error as Error).message);
        }
      }
      // Append to the list stored now, not the one read before processing, and re-check the limit against it.
      const changed = await changeAgentDefinitionAttachments(definition.id, owner, current => {
        if (current.length + processed.length > MAX_AGENT_ATTACHMENTS) {
          throw new RouteError(400, `An agent can have at most ${MAX_AGENT_ATTACHMENTS} input files`);
        }
        return [...current, ...processed];
      }, storeDeps);
      if (!changed) throw new RouteError(404, 'Agent definition not found');
      const updated = changed.definition;
      const added = new Set(processed.map(attachment => attachment.id));
      res.status(201).json({
        definition: publicAgentDefinition(updated),
        attachments: publicGoalAttachments(updated.attachments.filter(attachment => added.has(attachment.id))),
      });
    } catch (error) {
      if (processed.length > 0) await removeAttachmentFiles(String(req.params.id), processed).catch(() => undefined);
      throw error;
    } finally {
      await removeTemporaryUploads(files).catch(() => undefined);
    }
  });

  const deleteAttachment = handler('Failed to remove agent input file', async (req, res) => {
    const owner = requireOwner(req);
    const definitionId = String(req.params.id);
    const attachmentId = String(req.params.attachmentId);
    let attachment: Attachment | undefined;
    // Remove from the list stored at write time so a concurrent change is not reverted.
    const changed = await changeAgentDefinitionAttachments(definitionId, owner, current => {
      attachment = current.find(candidate => candidate.id === attachmentId);
      if (!attachment) throw new RouteError(404, 'Attachment not found');
      return current.filter(candidate => candidate.id !== attachmentId);
    }, storeDeps);
    if (!changed || !attachment) throw new RouteError(404, 'Agent definition not found');
    // The file goes only once no stored list references it.
    await removeAttachmentFiles(definitionId, [attachment]);
    res.json({ definition: publicAgentDefinition(changed.definition) });
  });

  /** The trigger primitive over HTTP: run now, GitHub Actions, webhook relays and external cron. */
  const triggerRun = handler('Failed to trigger agent run', async (req, res) => {
    const owner = requireOwner(req);
    const body = requestBody(req);
    const runTrigger = requestedTrigger(req, body);
    if (body.source != null && (typeof body.source !== 'string' || body.source.length > TRIGGER_SOURCE_MAX_LENGTH)) {
      throw new RouteError(400, `source must be a string of at most ${TRIGGER_SOURCE_MAX_LENGTH} characters`);
    }
    const idempotencyKey = requestIdempotencyKey(req);
    const definition = await requireDefinition(req, owner);
    if (!await verifyRepositories(req, res, definition.repositories)) return;

    const result = await trigger({
      definition,
      trigger: runTrigger,
      triggerSource: (body.source as string | undefined)?.trim() || `user:${owner}`,
      idempotencyKey,
      gate: services.gate,
    });
    res.status(result.created ? 202 : 200).json({ run: publicAgentRun(result.run, { includeReport: true }), created: result.created });
  });

  const listRuns = handler('Failed to list agent runs', async (req, res) => {
    const owner = requireOwner(req);
    const definition = await requireDefinition(req, owner);
    const page = await listAgentRuns(definition.id, owner, parsePage(req.query), storeDeps);
    res.json({ ...page, runs: page.runs.map(run => publicAgentRun(run, { includeReport: false })) });
  });

  async function requireRun(req: Request, owner: string): Promise<StoredAgentRun> {
    const run = await getAgentRun(String(req.params.runId), owner, storeDeps);
    if (!run) throw new RouteError(404, 'Agent run not found');
    return run;
  }

  const getRun = handler('Failed to load agent run', async (req, res) => {
    const run = await requireRun(req, requireOwner(req));
    res.json({ run: publicAgentRun(run, { includeReport: true }) });
  });

  /**
   * Cancel first so a late worker write cannot resurrect the run, then stop its
   * task. The transition is guarded on the exact state just read, so `run.state`
   * is the state that was cancelled; when the run moved in between (for example
   * queued → running), the cancel retries against the new state.
   */
  async function cancelCurrentState(req: Request, owner: string): Promise<{ run: StoredAgentRun; cancelled: StoredAgentRun }> {
    for (let attempt = 0; attempt < MAX_CANCEL_ATTEMPTS; attempt += 1) {
      const run = await requireRun(req, owner);
      if (!CANCELLABLE_AGENT_RUN_STATES.includes(run.state)) {
        throw new RouteError(409, `Agent run is ${run.state} and can no longer be cancelled`, 'AGENT_RUN_NOT_CANCELLABLE');
      }
      const cancelled = await transitionAgentRun(run.id, [run.state], 'cancelled', {}, storeDeps);
      if (cancelled) return { run, cancelled };
    }
    throw new RouteError(409, 'Agent run changed state before it could be cancelled', 'AGENT_RUN_NOT_CANCELLABLE');
  }

  const cancelRun = handler('Failed to cancel agent run', async (req, res) => {
    const owner = requireOwner(req);
    const { run, cancelled } = await cancelCurrentState(req, owner);

    // Task ids come from the row the cancel produced, for the state it actually cancelled.
    const taskId = run.state === 'running' ? cancelled.reportTaskId : run.state === 'acting' ? cancelled.actionTaskId : null;
    if (taskId) {
      try {
        if (!services.stopTask && !deps.redisClient) throw new Error('No Redis client is configured to stop the task');
        await stopTask(taskId, {
          redisClient: deps.redisClient!,
          requestedBy: req.user?.username ?? owner,
          reason: 'Agent run cancelled by user. Terminating execution...',
          cancellationReason: 'agent_run_cancelled',
        });
      } catch (error) {
        logger.warn({ runId: run.id, taskId, err: error }, 'Agent run was cancelled but its task could not be stopped');
      }
    }
    res.json({ run: publicAgentRun(cancelled, { includeReport: true }) });
  });

  /**
   * An approved run whose acting step has not been claimed yet. The approval
   * committed, but the request that made it may have stopped before the
   * acting step was enqueued, so approving again re-dispatches it.
   */
  function isUnclaimedApproval(run: StoredAgentRun): boolean {
    return run.state === 'acting' && run.approvedBy !== null && run.actionTaskId === null;
  }

  /**
   * Decides a preview run with a compare-and-set from `awaiting_approval`, so
   * a double-clicked Approve moves the run once. The operator note is stored
   * with the approval, so a re-dispatch keeps the approver's guidance.
   */
  async function decideRun(req: Request, owner: string, to: 'acting' | 'rejected', note: string | null = null): Promise<StoredAgentRun> {
    const run = await requireRun(req, owner);
    const notAwaiting = (state: AgentRunState) => new RouteError(409, `Agent run is ${state} and is not awaiting approval`, 'AGENT_RUN_NOT_AWAITING_APPROVAL');
    if (to === 'acting' && isUnclaimedApproval(run)) return run;
    if (run.state !== 'awaiting_approval') throw notAwaiting(run.state);
    const patch = to === 'acting' ? { approvedBy: owner, operatorNote: note } : {};
    const decided = await transitionAgentRun(run.id, ['awaiting_approval'], to, patch, storeDeps);
    if (decided) return decided;
    const current = await requireRun(req, owner);
    if (to === 'acting' && isUnclaimedApproval(current)) return current;
    throw notAwaiting(current.state);
  }

  /**
   * Approving again repeats the handoff of an approval whose acting step was
   * not claimed yet; the acting job id is deterministic, so this never runs
   * the step twice. The note stored with the first approval is the one used.
   */
  const approveRun = handler('Failed to approve agent run', async (req, res) => {
    const owner = requireOwner(req);
    const note = operatorNote(requestBody(req));
    const acting = await decideRun(req, owner, 'acting', note);
    const run = await startActing(acting, acting.operatorNote);
    res.json({ run: publicAgentRun(run, { includeReport: true }) });
  });

  const rejectRun = handler('Failed to reject agent run', async (req, res) => {
    const rejected = await decideRun(req, requireOwner(req), 'rejected');
    res.json({ run: publicAgentRun(rejected, { includeReport: true }) });
  });

  return {
    list, contract, create, get, update, remove,
    uploadAttachments, deleteAttachment,
    triggerRun, listRuns, getRun, cancelRun, approveRun, rejectRun,
  };
}
