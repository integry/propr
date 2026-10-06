import { randomUUID } from 'node:crypto';
import type { JobsOptions } from 'bullmq';
import type { Knex } from 'knex';
import { agentTypeSupportsProprMcp, type AgentRunTrigger, type SyntheticAgentConfig } from '@propr/shared';
import { loadMonitoredReposRaw, loadSettings, type RepoToMonitor } from '../../config/configManager.js';
import { loadAgents, type AgentConfig } from '../../config/configManagerAgents.js';
import { loadSyntheticAgents } from '../../config/configManagerSyntheticAgents.js';
import { getIssueQueue } from '../../queue/taskQueue.js';
import type { AgentRunJobData, AgentRunPhase } from '../../queue/taskQueue.types.js';
import logger from '../../utils/logger.js';
import type { StoredAgentDefinition } from './agentDefinitionStore.js';
import {
  createAgentRun,
  getAgentRunById,
  getAgentRunByIdempotencyKey,
  transitionAgentRun,
  type StoredAgentRun,
} from './agentRunStore.js';

/**
 * The single trigger primitive for agent runs. UI "Run now", the schedule and
 * the API/MCP/CLI all call `triggerAgentRun`, so validation, idempotency, the
 * repository/model checks and the cost gate live in one place.
 *
 * GitHub repository access is not checked here: core has no request context.
 * The API and MCP layers check it before calling, and the scheduler re-checks
 * enablement when the run fires.
 */

export const AGENT_RUN_JOB_NAMES: Readonly<Record<AgentRunPhase, string>> = {
  report: 'processAgentRun',
  action: 'processAgentAction',
};

/**
 * Retried only to finish storing state: a delivery fails when a run's state
 * could not be persisted. The processor never executes a claimed run again (a
 * retry fails an abandoned `running` run, or finishes one whose report is
 * stored), so a retry does not spend tokens twice.
 */
export const AGENT_RUN_JOB_OPTIONS: Readonly<JobsOptions> = { attempts: 3, backoff: { type: 'exponential', delay: 5_000 } };

export type AgentRunTriggerErrorCode = 'AGENT_DISABLED' | 'AGENT_INVALID';

export class AgentRunTriggerError extends Error {
  readonly status: number;
  readonly code: AgentRunTriggerErrorCode;

  constructor(message: string, status: number, code: AgentRunTriggerErrorCode) {
    super(message);
    this.name = 'AgentRunTriggerError';
    this.status = status;
    this.code = code;
  }
}

export type AgentRunEnqueue = (name: string, data: AgentRunJobData, options: JobsOptions) => Promise<unknown>;

export interface AgentRunTriggerDependencies {
  database?: Knex;
  now?: () => number;
  enqueue?: AgentRunEnqueue;
  loadAgents?: () => Promise<AgentConfig[]>;
  loadSyntheticAgents?: () => Promise<SyntheticAgentConfig[]>;
  loadRepos?: () => Promise<RepoToMonitor[]>;
  /** The configured default agent alias (settings.default_agent_alias), if any. */
  loadDefaultAgentAlias?: () => Promise<string | null>;
}

export type AgentRunGateDecision =
  | { action: 'proceed' }
  | { action: 'skip'; reason: string }
  | { action: 'defer'; until: number; reason: string };

export interface AgentRunGateContext {
  definition: StoredAgentDefinition;
  trigger: AgentRunTrigger;
  triggerSource: string | null;
}

/** Pre-run admission check (the cost gate); returning nothing proceeds. */
export type AgentRunGate = (context: AgentRunGateContext) => Promise<AgentRunGateDecision | null | undefined>
  | AgentRunGateDecision | null | undefined;

export interface TriggerAgentRunInput {
  definition: StoredAgentDefinition;
  trigger: AgentRunTrigger;
  /** Who or what fired the run, e.g. a user id or the schedule slot. */
  triggerSource?: string | null;
  /** Replays with the same key return the existing run without enqueueing again. */
  idempotencyKey?: string | null;
  gate?: AgentRunGate;
}

export interface TriggerAgentRunResult {
  run: StoredAgentRun;
  /** False when an existing run with the same idempotency key was returned. */
  created: boolean;
  /** True only when this call enqueued the report phase. */
  enqueued: boolean;
}

async function defaultEnqueue(name: string, data: AgentRunJobData, options: JobsOptions): Promise<unknown> {
  const queue = await getIssueQueue();
  // The issue queue is typed for its original payloads; agent runs share it.
  return (queue as unknown as { add: AgentRunEnqueue }).add(name, data, options);
}

export function agentRunJobId(runId: string, phase: AgentRunPhase): string {
  return `agent-run-${runId}-${phase}`;
}

/**
 * Enqueue one phase of a run. The job id is deterministic, so a double
 * enqueue of the same phase is deduplicated by BullMQ.
 */
export async function enqueueAgentRunPhase(
  run: Pick<StoredAgentRun, 'id' | 'definitionId' | 'ownerId'>,
  phase: AgentRunPhase,
  { enqueue = defaultEnqueue }: Pick<AgentRunTriggerDependencies, 'enqueue'> = {},
  { operatorNote }: { operatorNote?: string | null } = {},
): Promise<string> {
  const jobId = agentRunJobId(run.id, phase);
  const data: AgentRunJobData = {
    runId: run.id,
    definitionId: run.definitionId,
    ownerId: run.ownerId,
    phase,
    correlationId: randomUUID(),
    ...(phase === 'action' && operatorNote ? { operatorNote } : {}),
  };
  await enqueue(AGENT_RUN_JOB_NAMES[phase], data, { ...AGENT_RUN_JOB_OPTIONS, jobId });
  return jobId;
}

export interface EnqueueAgentRunActionDependencies extends Pick<AgentRunTriggerDependencies, 'database' | 'now' | 'enqueue'> {
  transitionRun?: typeof transitionAgentRun;
  /** Guidance from the approver, passed to the acting prompt; defaults to the note stored with the approval. */
  operatorNote?: string | null;
}

/**
 * Enqueues the acting step of a run that just moved to `acting` (auto mode or
 * an approval). When the job cannot be enqueued nothing would ever pick the
 * run up, so it is failed with the reason instead. Returns the run as stored.
 *
 * Safe to repeat for an unclaimed `acting` run: the job id is deterministic,
 * so re-dispatching an interrupted handoff never enqueues a second job.
 */
export async function enqueueAgentRunActionOrFail(
  run: StoredAgentRun,
  { database, now, enqueue, transitionRun = transitionAgentRun, operatorNote = run.operatorNote }: EnqueueAgentRunActionDependencies = {},
): Promise<StoredAgentRun> {
  try {
    await enqueueAgentRunPhase(run, 'action', { enqueue }, { operatorNote });
    return run;
  } catch (error) {
    const reason = `Could not start the acting step: ${error instanceof Error ? error.message : String(error)}`;
    logger.error({ runId: run.id, err: error }, 'Failed to enqueue agent run acting step');
    const failed = await transitionRun(run.id, ['acting'], 'failed', { failureReason: reason }, { database, now });
    // Another writer moved the run first (for example a cancel); report what it stored.
    return failed ?? await getAgentRunById(run.id, { database }) ?? run;
  }
}

function directAgentSupportsModel(agent: AgentConfig, modelName: string | null): boolean {
  return agent.enabled && (modelName === null || agent.supportedModels.includes(modelName));
}

function syntheticAgentSupportsModel(agent: SyntheticAgentConfig, modelName: string | null): boolean {
  return agent.enabled && agent.models.some(model => model.enabled && model.id === (modelName ?? agent.defaultModel));
}

/**
 * A synthetic model can route to any enabled member whose physical agent is
 * enabled, so every such member must support propr_mcp. Members on a disabled
 * or missing physical agent are never selected by routing and are ignored.
 */
function syntheticAgentSupportsProprMcp(agent: SyntheticAgentConfig, modelName: string | null, agents: AgentConfig[]): boolean {
  const model = agent.models.find(choice => choice.enabled && choice.id === (modelName ?? agent.defaultModel));
  const selectable = (model?.members ?? []).flatMap(member => {
    if (!member.enabled) return [];
    const direct = agents.find(candidate => candidate.alias === member.directAgentAlias);
    return direct?.enabled ? [direct] : [];
  });
  return selectable.length > 0 && selectable.every(direct => agentTypeSupportsProprMcp(direct.type));
}

async function loadConfiguredDefaultAgentAlias(): Promise<string | null> {
  const alias = (await loadSettings() as Record<string, unknown>).default_agent_alias;
  return typeof alias === 'string' && alias.trim() ? alias.trim() : null;
}

/**
 * The agent type the worker uses when a definition names no agent, resolved
 * like `AgentRegistry.getDefaultAgent`: the configured default alias, then the
 * `default` alias, among enabled direct agents. With no agents configured the
 * registry falls back to a Claude agent from the environment. Null when no
 * default agent can be resolved.
 */
function defaultAgentType(agents: AgentConfig[], configuredAlias: string | null): string | null {
  if (agents.length === 0) return 'claude';
  const enabled = agents.filter(agent => agent.enabled);
  const resolved = (configuredAlias ? enabled.find(agent => agent.alias === configuredAlias) : undefined)
    ?? enabled.find(agent => agent.alias === 'default');
  return resolved?.type ?? null;
}

/**
 * Check a definition against the live configuration. Returns a user-facing
 * error, or null when the definition can run.
 *
 * - every repository is an enabled monitored repository;
 * - the agent alias is enabled and supports the model (same rule as
 *   `implement_plan`); without an alias the worker uses the default agent,
 *   which must resolve when propr_mcp is needed;
 * - propr_mcp, requested by the capability or by the acting step of preview
 *   and auto runs, is only used with agent types that support it.
 */
export async function validateAgentDefinitionRuntime(
  definition: StoredAgentDefinition,
  deps: AgentRunTriggerDependencies = {},
): Promise<string | null> {
  const {
    loadRepos = loadMonitoredReposRaw,
    loadAgents: loadDirectAgents = loadAgents,
    loadSyntheticAgents: loadSynthetic = () => loadSyntheticAgents(),
    loadDefaultAgentAlias = loadConfiguredDefaultAgentAlias,
  } = deps;

  if (definition.repositories.length > 0) {
    const enabled = new Set((await loadRepos()).filter(repo => repo.enabled).map(repo => repo.name.trim().toLowerCase()));
    const unavailable = definition.repositories.filter(repository => !enabled.has(repository.toLowerCase()));
    if (unavailable.length > 0) return `Repositories are not enabled: ${unavailable.join(', ')}`;
  }

  const alias = definition.agentAlias;
  const modelName = definition.modelName;
  const needsProprMcp = definition.capabilities.includes('propr_mcp') || definition.autonomyMode !== 'dry_run';
  if (alias === null) {
    if (modelName !== null) return 'A model requires an agent';
    if (!needsProprMcp) return null;
    const [agents, configuredAlias] = await Promise.all([loadDirectAgents(), loadDefaultAgentAlias()]);
    const type = defaultAgentType(agents, configuredAlias);
    if (type === null) return 'No default agent is configured; choose an agent that supports propr_mcp';
    if (!agentTypeSupportsProprMcp(type)) {
      return 'The default agent does not support propr_mcp, which the propr_mcp capability and the preview and auto acting steps require';
    }
    return null;
  }

  const [agents, synthetic] = await Promise.all([loadDirectAgents(), loadSynthetic()]);
  const direct = agents.find(agent => agent.alias === alias && directAgentSupportsModel(agent, modelName));
  const syntheticAgent = direct ? undefined
    : synthetic.find(agent => agent.alias === alias && syntheticAgentSupportsModel(agent, modelName));
  if (!direct && !syntheticAgent) return 'Choose an enabled agent and a model it supports';

  if (needsProprMcp) {
    const supported = direct ? agentTypeSupportsProprMcp(direct.type)
      : syntheticAgentSupportsProprMcp(syntheticAgent!, modelName, agents);
    if (!supported) return `Agent ${alias} does not support propr_mcp, which the propr_mcp capability and the preview and auto acting steps require`;
  }
  return null;
}

/**
 * Create the run receipt and enqueue its report phase.
 *
 * Throws `AgentRunTriggerError` 409 `AGENT_DISABLED` for a disabled definition
 * and 400 `AGENT_INVALID` when the definition cannot run with the current
 * configuration; no run is created in either case. A gate may create the run
 * as `skipped` or `deferred` instead, without enqueueing. If enqueueing fails
 * after the run exists, the run is marked `failed` and the error is rethrown.
 */
export async function triggerAgentRun(
  { definition, trigger, triggerSource = null, idempotencyKey = null, gate }: TriggerAgentRunInput,
  deps: AgentRunTriggerDependencies = {},
): Promise<TriggerAgentRunResult> {
  const storeDeps = { database: deps.database, now: deps.now };

  // A replay sees the original receipt even if the definition changed since.
  if (idempotencyKey !== null) {
    const existing = await getAgentRunByIdempotencyKey(definition.id, idempotencyKey, storeDeps);
    if (existing) return { run: existing, created: false, enqueued: false };
  }

  if (!definition.enabled) throw new AgentRunTriggerError('Agent is disabled', 409, 'AGENT_DISABLED');
  const invalid = await validateAgentDefinitionRuntime(definition, deps);
  if (invalid) throw new AgentRunTriggerError(invalid, 400, 'AGENT_INVALID');

  const decision = (await gate?.({ definition, trigger, triggerSource })) ?? { action: 'proceed' as const };
  const base = { definition, trigger, triggerSource, idempotencyKey };
  const { run, created } = decision.action === 'skip'
    ? await createAgentRun({ ...base, initialState: 'skipped', skipReason: decision.reason }, storeDeps)
    : decision.action === 'defer'
      ? await createAgentRun({ ...base, initialState: 'deferred', deferredUntil: decision.until }, storeDeps)
      : await createAgentRun(base, storeDeps);

  if (decision.action !== 'proceed') {
    logger.info({ runId: run.id, definitionId: definition.id, action: decision.action, reason: decision.reason },
      'Agent run held by the trigger gate');
  }
  // A concurrent replay won the insert; that caller owns the enqueue.
  if (!created || run.state !== 'queued') return { run, created, enqueued: false };

  try {
    await enqueueAgentRunPhase(run, 'report', deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureReason = `Failed to enqueue the agent run on the job queue: ${message}`;
    try {
      await transitionAgentRun(run.id, ['queued'], 'failed', { failureReason }, storeDeps);
    } catch (transitionError) {
      logger.error({ runId: run.id, err: transitionError }, 'Could not mark agent run failed after an enqueue failure');
    }
    throw error;
  }
  return { run, created, enqueued: true };
}
