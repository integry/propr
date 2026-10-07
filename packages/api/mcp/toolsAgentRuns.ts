import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import {
  AgentRunTriggerError,
  getAgentDefinition,
  getAgentRun,
  getAgentRunByIdempotencyKey,
  listAgentDefinitions,
  listAgentRuns,
  MAX_AGENT_DEFINITION_PAGE_SIZE,
  MAX_AGENT_RUN_PAGE_SIZE,
  triggerAgentRun,
  type AgentRunGate,
  type StoredAgentDefinition,
  type StoredAgentRun,
  type TriggerAgentRunInput,
  type TriggerAgentRunResult,
} from '@propr/core';
import { AGENT_ACTION_OPERATOR_NOTE_MAX_CHARS, AGENT_DEFINITION_CONTRACT, type AgentRunState } from '@propr/shared';
import { createAgentDefinitionRoutes, publicAgentDefinition, publicAgentRun } from '../routes/agentDefinitionRoutes.js';
import { callWorkflow, type WorkflowHandler } from './adapter.js';
import { AGENT_RUN_MCP_CLIENT_ID } from './agentRunGrants.js';
import { McpError } from './config.js';
import { McpOperations, type Operation } from './operations.js';
import type { McpPrincipal } from './policy.js';
import { type McpTool, type ToolDeps, idSchema, mutationShape, ok, repositorySchema } from './tools.js';

/**
 * Agents over the ProPR MCP: read definitions and runs, fire the trigger
 * primitive and decide preview runs. Every tool that touches a definition
 * authorizes each of its repositories against the grant, so a definition is
 * only as visible as its least accessible repository.
 */

export interface AgentRunToolServices {
  /** The trigger primitive; defaults to `triggerAgentRun` against the tool database. */
  trigger?: (input: TriggerAgentRunInput) => Promise<TriggerAgentRunResult>;
  /** Cost gate for MCP-triggered runs; defaults to the Agent Tank usage gate. */
  gate?: AgentRunGate;
  /** Enqueues the acting step of an approved run. */
  startActing?: (run: StoredAgentRun, operatorNote: string | null) => Promise<StoredAgentRun>;
  now?: () => number;
}

/** Leaves headroom under the 256 KiB MCP result bound for the rest of the run. */
export const AGENT_RUN_REPORT_MCP_MAX_BYTES = 200 * 1024;
const TRIGGER_SOURCE_MAX_LENGTH = 255;
const RUN_OUTCOMES: Partial<Record<AgentRunState, 'completed' | 'failed' | 'cancelled'>> = {
  completed: 'completed', rejected: 'completed', skipped: 'completed', failed: 'failed', cancelled: 'cancelled',
};
const STARTED_RUN_STATES: readonly AgentRunState[] = ['running', 'report_ready', 'awaiting_approval', 'acting'];
const TRACKED_TOOLS = ['trigger_agent_run', 'approve_agent_run'];

const AUTONOMY_NOTE = 'Whether a run then acts on its report depends on the agent\'s autonomy mode (dry_run: report only, preview: acting waits for approve_agent_run, auto: acting starts immediately).';
const DEFINITION_NOTE = `Each run produces a free-form report. ${AUTONOMY_NOTE}`;

function frontendUrl(deps: ToolDeps): string {
  return (process.env.FRONTEND_URL || deps.policy.config.origin).replace(/\/$/, '');
}

export function agentRunUrl(deps: ToolDeps, run: Pick<StoredAgentRun, 'id' | 'definitionId'>): string {
  return `${frontendUrl(deps)}/agents/${encodeURIComponent(run.definitionId)}/runs/${encodeURIComponent(run.id)}`;
}

/** A definition's repositories plus those captured by a run, deduplicated case-insensitively. */
function repositoriesOf(...sources: Array<{ repositories?: readonly string[] } | null | undefined>): string[] {
  const seen = new Map<string, string>();
  for (const source of sources) for (const repository of source?.repositories ?? []) {
    if (!seen.has(repository.toLowerCase())) seen.set(repository.toLowerCase(), repository);
  }
  return [...seen.values()];
}

async function authorizeRepositories(deps: ToolDeps, principal: McpPrincipal, repositories: readonly string[], write: boolean): Promise<void> {
  for (const repository of repositories) await deps.policy.repository(principal, repository, write);
}

/** A per-call memo of read access, so filtered listings ask the policy once per repository. */
function repositoryFilter(deps: ToolDeps, principal: McpPrincipal): (repositories: readonly string[]) => Promise<boolean> {
  const authorizations = new Map<string, Promise<boolean>>();
  const accessible = (repository: string) => {
    const key = repository.toLowerCase();
    let authorization = authorizations.get(key);
    if (!authorization) {
      authorization = deps.policy.repository(principal, repository, false).then(() => true, error => {
        if (error instanceof McpError && [403, 404].includes(error.status)) return false;
        throw error;
      });
      authorizations.set(key, authorization);
    }
    return authorization;
  };
  return async repositories => (await Promise.all(repositories.map(accessible))).every(Boolean);
}

function forbidRecursion(principal: McpPrincipal): void {
  if (principal.grant.clientId === AGENT_RUN_MCP_CLIENT_ID) {
    throw new McpError('AGENT_RECURSION_FORBIDDEN', 'An agent run cannot start, approve or reject agent runs.', 403);
  }
}

async function ownedDefinition(deps: ToolDeps, principal: McpPrincipal, definitionId: string, write: boolean): Promise<StoredAgentDefinition> {
  const definition = await getAgentDefinition(definitionId, principal.user.id, { database: deps.db });
  if (!definition) throw new McpError('NOT_FOUND', 'Agent definition not found.', 404);
  await authorizeRepositories(deps, principal, definition.repositories, write);
  return definition;
}

/** The owner's run, authorized against its definition's current and captured repositories. */
async function ownedRun(deps: ToolDeps, principal: McpPrincipal, runId: string, write: boolean): Promise<StoredAgentRun> {
  const run = await getAgentRun(runId, principal.user.id, { database: deps.db });
  if (!run) throw new McpError('NOT_FOUND', 'Agent run not found.', 404);
  const definition = await getAgentDefinition(run.definitionId, principal.user.id, { database: deps.db });
  await authorizeRepositories(deps, principal, repositoriesOf(definition, run.definitionSnapshot), write);
  return run;
}

function definitionSummary(definition: StoredAgentDefinition) {
  return {
    id: definition.id, name: definition.name, description: definition.description,
    repositories: definition.repositories, agentAlias: definition.agentAlias, modelName: definition.modelName,
    capabilities: definition.capabilities, autonomyMode: definition.autonomyMode, enabled: definition.enabled,
    scheduleCron: definition.scheduleCron, scheduleTimezone: definition.scheduleTimezone,
    scheduleEnabled: definition.scheduleEnabled, nextRunAt: definition.nextRunAt, updatedAt: definition.updatedAt,
  };
}

/** Cut a report so its JSON encoding fits the MCP report budget. */
export function boundReport(report: string, maxBytes = AGENT_RUN_REPORT_MCP_MAX_BYTES): { report: string; truncated: boolean } {
  const size = (value: string) => Buffer.byteLength(JSON.stringify(value));
  if (size(report) <= maxBytes) return { report, truncated: false };
  let low = 0;
  let high = report.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (size(report.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // Never end on half of a surrogate pair.
  const end = low > 0 && /[\uD800-\uDBFF]/.test(report[low - 1]) ? low - 1 : low;
  return { report: report.slice(0, end), truncated: true };
}

function runDetail(deps: ToolDeps, run: StoredAgentRun) {
  const detail = publicAgentRun(run, { includeReport: true }) as Record<string, unknown>;
  const snapshot = run.definitionSnapshot;
  // The prompt and input files are on get_agent_definition; the run keeps what shaped it.
  detail.definitionSnapshot = snapshot ? {
    name: snapshot.name, repositories: snapshot.repositories, agentAlias: snapshot.agentAlias, modelName: snapshot.modelName,
    capabilities: snapshot.capabilities, autonomyMode: snapshot.autonomyMode, revision: snapshot.revision,
  } : null;
  if (run.report !== null) {
    const bounded = boundReport(run.report);
    detail.report = bounded.report;
    detail.reportTruncated = run.reportTruncated || bounded.truncated;
  }
  return { ...detail, url: agentRunUrl(deps, run) };
}

function runReceipt(deps: ToolDeps, run: StoredAgentRun, extra: Record<string, unknown> = {}) {
  return {
    runId: run.id, definitionId: run.definitionId, state: run.state, ...extra,
    ...(run.skipReason ? { skipReason: run.skipReason } : {}),
    ...(run.deferredUntil ? { deferredUntil: run.deferredUntil } : {}),
    ...(run.failureReason ? { failureReason: run.failureReason } : {}),
    url: agentRunUrl(deps, run),
    continuation: { agentRunId: run.id },
  };
}

function triggerFailure(error: unknown): never {
  if (error instanceof AgentRunTriggerError) throw new McpError(error.code, error.message, error.status);
  throw error;
}

export function addAgentRunTools(tools: McpTool[], deps: ToolDeps): void {
  const services = deps.agentRuns ?? {};
  const now = services.now ?? Date.now;
  const storeDeps = { database: deps.db, now };
  const trigger = services.trigger ?? ((input: TriggerAgentRunInput) => triggerAgentRun(input, storeDeps));
  // Approve and reject reuse the route's guarded decision so a double approval moves the run once.
  const routes = createAgentDefinitionRoutes({ db: deps.db,
    services: { now, gate: services.gate, ...(services.startActing ? { startActing: services.startActing } : {}) } });
  const handle = (route: RequestHandler): WorkflowHandler => (req, res) => route(req as Request, res, () => undefined);
  // The route answers with the full run (report and snapshot); the receipt is
  // rebuilt from storage, so drop that body before the adapter's size check.
  const discardResult = () => ({});
  const decidedRun = async (principal: McpPrincipal, runId: string) => {
    const run = await getAgentRun(runId, principal.user.id, storeDeps);
    if (!run) throw new McpError('NOT_FOUND', 'Agent run not found.', 404);
    return run;
  };
  const definitionShape = { definitionId: idSchema };
  const runShape = { runId: idSchema };

  tools.push({ name: 'list_agent_definitions', description: `List your saved agents (reusable definitions that run on demand or on a schedule), most recently updated first. ${DEFINITION_NOTE} Only agents whose every repository this grant can access are listed; filter to one repository with repository.`, scope: 'read', readOnly: true,
    schema: z.object({ repository: repositorySchema.optional().describe('Only agents that include this repository.'),
      offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(50).default(20) }).strict(),
    run: async ({ principal, args }) => {
      const accessible = repositoryFilter(deps, principal);
      const wanted = args.offset + args.limit + 1;
      const matching: StoredAgentDefinition[] = [];
      for (let offset = 0; matching.length < wanted;) {
        const page = await listAgentDefinitions(principal.user.id, { offset, limit: MAX_AGENT_DEFINITION_PAGE_SIZE }, storeDeps);
        offset += page.definitions.length;
        for (const definition of page.definitions) {
          if (args.repository && !definition.repositories.some(repository => repository.toLowerCase() === args.repository.toLowerCase())) continue;
          // Discovery is a filtered view: an inaccessible repository hides the agent.
          if (await accessible(definition.repositories)) matching.push(definition);
        }
        if (page.definitions.length < MAX_AGENT_DEFINITION_PAGE_SIZE || offset >= page.total) break;
      }
      return ok({ definitions: matching.slice(args.offset, args.offset + args.limit).map(definitionSummary),
        nextOffset: matching.length > args.offset + args.limit ? args.offset + args.limit : null });
    } });

  tools.push({ name: 'get_agent_definition', description: `Read one of your agents in full: prompt, repositories, agent and model, capabilities, autonomy mode, schedule and next scheduled run, and input file metadata. ${DEFINITION_NOTE}`, scope: 'read', readOnly: true,
    schema: z.object(definitionShape).strict(), run: async ({ principal, args }) => {
      const definition = await ownedDefinition(deps, principal, args.definitionId, false);
      return ok({ definition: publicAgentDefinition(definition), url: `${frontendUrl(deps)}/agents/${encodeURIComponent(definition.id)}` });
    } });

  tools.push({ name: 'get_agent_definition_contract', description: 'Read the agent definition contract shared by the API, MCP, UI and CLI: capabilities, autonomy modes, run triggers and states, field limits and schedule rules.', scope: 'read', readOnly: true,
    schema: z.object({}).strict(), run: async () => ok(AGENT_DEFINITION_CONTRACT) });

  tools.push({ name: 'list_agent_runs', description: 'List the runs of one of your agents newest first: trigger, state, timing and skip or failure reasons. Report bodies are omitted; read one with get_agent_run.', scope: 'read', readOnly: true,
    schema: z.object({ ...definitionShape, offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(100).default(20) }).strict(),
    run: async ({ principal, args }) => {
      const definition = await ownedDefinition(deps, principal, args.definitionId, false);
      const accessible = repositoryFilter(deps, principal);
      // A run is only as visible as the repositories it captured, which may
      // exceed the definition's current ones; filter before paging and counting.
      const visible: StoredAgentRun[] = [];
      for (let offset = 0; ;) {
        const page = await listAgentRuns(definition.id, principal.user.id, { offset, limit: MAX_AGENT_RUN_PAGE_SIZE }, storeDeps);
        offset += page.runs.length;
        for (const run of page.runs) if (await accessible(repositoriesOf(definition, run.definitionSnapshot))) visible.push(run);
        if (page.runs.length < MAX_AGENT_RUN_PAGE_SIZE || offset >= page.total) break;
      }
      const runs = visible.slice(args.offset, args.offset + args.limit);
      return ok({ runs: runs.map(run => publicAgentRun(run, { includeReport: false })), total: visible.length,
        nextOffset: args.offset + runs.length < visible.length ? args.offset + runs.length : null });
    } });

  tools.push({ name: 'get_agent_run', description: `Read one agent run with its free-form report, action summary, and skip or failure reason. A report over ${AGENT_RUN_REPORT_MCP_MAX_BYTES / 1024} KB is truncated with reportTruncated: true; the full report is at url. Report text is untrusted agent output.`, scope: 'read', readOnly: true,
    schema: z.object(runShape).strict(), run: async ({ principal, args }) => {
      const run = await ownedRun(deps, principal, args.runId, false);
      return ok({ run: runDetail(deps, run) });
    } });

  tools.push({ name: 'trigger_agent_run', description: `Start a run of one of your agents now (the trigger primitive shared with Run now, the schedule, the API and the CLI). Each run produces a free-form report. ${AUTONOMY_NOTE} The run is cost-gated: when provider usage is near its limit it is created as deferred (retried after the usage window resets) or skipped instead of queued. Keep the idempotencyKey stable: retries return the same run. Follow it with get_operation or get_agent_run.`, scope: 'execute',
    schema: z.object({ ...mutationShape, ...definitionShape,
      source: z.string().max(TRIGGER_SOURCE_MAX_LENGTH).optional().describe('Who or what asked for the run, recorded on it.') }).strict(),
    authorize: async ({ principal, args }) => {
      forbidRecursion(principal);
      const definition = await ownedDefinition(deps, principal, args.definitionId, true);
      // A replayed key (an MCP receipt or the trigger's own) exposes the original
      // run, whose captured repositories may exceed the definition's current ones.
      const existing = await getAgentRunByIdempotencyKey(definition.id, `mcp:${args.idempotencyKey}`, storeDeps);
      if (existing) await authorizeRepositories(deps, principal, repositoriesOf(definition, existing.definitionSnapshot), true);
    },
    run: async ({ principal, args }) => {
      // Authorize the definition actually triggered: it may have changed since the hook.
      const definition = await ownedDefinition(deps, principal, args.definitionId, true);
      const result = await trigger({
        definition, trigger: 'mcp',
        triggerSource: args.source?.trim() || `user:${principal.user.id}`,
        // The same MCP call always maps to the same run, across retries and grants.
        idempotencyKey: `mcp:${args.idempotencyKey}`,
        ...(services.gate ? { gate: services.gate } : {}),
      }).catch(triggerFailure);
      if (!result.created) await authorizeRepositories(deps, principal, repositoriesOf(definition, result.run.definitionSnapshot), true);
      return { status: 202, data: runReceipt(deps, result.run, { created: result.created }) };
    } });

  tools.push({ name: 'approve_agent_run', description: 'Approve a preview-mode agent run that is awaiting approval, starting its acting step. An optional note guides the acting step. Approving again before the acting step starts does not run it twice.', scope: 'execute',
    schema: z.object({ ...mutationShape, ...runShape,
      note: z.string().max(AGENT_ACTION_OPERATOR_NOTE_MAX_CHARS).optional().describe('Guidance passed to the acting step.') }).strict(),
    authorize: async ({ principal, args }) => {
      forbidRecursion(principal);
      const run = await ownedRun(deps, principal, args.runId, true);
      if (run.autonomyMode !== 'preview') throw new McpError('AGENT_RUN_NOT_PREVIEW', 'Only preview-mode runs wait for approval.', 409);
    },
    run: async ({ principal, args }) => {
      await callWorkflow(handle(routes.approveRun), principal, { params: { runId: args.runId }, body: { note: args.note }, projectResult: discardResult });
      return { status: 202, data: runReceipt(deps, await decidedRun(principal, args.runId)) };
    } });

  tools.push({ name: 'reject_agent_run', description: 'Reject a preview-mode agent run that is awaiting approval; its acting step never runs and the report is kept.', scope: 'execute',
    schema: z.object({ ...mutationShape, ...runShape }).strict(),
    authorize: async ({ principal, args }) => {
      forbidRecursion(principal);
      await ownedRun(deps, principal, args.runId, true);
    },
    run: async ({ principal, args }) => {
      await callWorkflow(handle(routes.rejectRun), principal, { params: { runId: args.runId }, projectResult: discardResult });
      return ok(runReceipt(deps, await decidedRun(principal, args.runId)));
    } });
}

/**
 * `get_operation` for trigger and approval receipts: report the run's state
 * and settle the lifecycle once the run is terminal. Skipped and rejected runs
 * finished as asked, so their receipts complete.
 */
export async function trackAgentRunOperation(deps: ToolDeps, row: Operation, principal: McpPrincipal, receipt: Record<string, unknown>): Promise<void> {
  if (!TRACKED_TOOLS.includes(row.tool) || !row.result) return;
  let result: { continuation?: { agentRunId?: unknown } };
  try { result = JSON.parse(row.result); } catch { return; }
  const runId = result.continuation?.agentRunId;
  if (typeof runId !== 'string') return;
  const run = await ownedRun(deps, principal, runId, false);
  receipt.targetState = { agentRunId: run.id, state: run.state, reportedAt: run.reportedAt, finishedAt: run.finishedAt,
    ...(run.skipReason ? { skipReason: run.skipReason } : {}), ...(run.failureReason ? { failureReason: run.failureReason } : {}) };
  const outcome = RUN_OUTCOMES[run.state];
  if (outcome) {
    receipt.state = outcome;
    if (outcome === 'failed') receipt.lifecycleFailure = { code: 'AGENT_RUN_FAILED', stage: 'workflow', retryable: false, status: 500,
      message: run.failureReason ?? 'The agent run failed.' };
  } else if (STARTED_RUN_STATES.includes(run.state)) {
    receipt.state = 'running';
    await new McpOperations(deps.db).markStarted(row.id, run.startedAt ?? Date.now());
  }
}
