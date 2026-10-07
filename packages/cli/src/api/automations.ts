/**
 * Automations API
 *
 * Typed access to the owner-scoped Agents endpoints (`/api/agent-definitions`
 * and `/api/agent-runs`). The CLI calls these "automations" because
 * `propr agent` already manages coding-agent configurations.
 *
 * Triggering a run carries an Idempotency-Key; transient transport failures
 * are retried with the same key, so a retried trigger never creates a second
 * run. Failures whose outcome cannot be known surface as
 * {@link GoalMutationUncertainError} with the key needed to retry safely.
 */

import type { AgentAutonomyMode, AgentCapability, AgentRunState, AgentRunTrigger } from "@propr/shared";
import { ApiClient, createApiClient } from "./client.js";
import { mutate } from "./goals.js";

/** Attachment metadata as the server exposes it (stored paths stay server-side). */
export interface AutomationAttachment {
  id: string;
  originalName?: string;
  mimeType?: string;
  size?: number;
  [key: string]: unknown;
}

/** A saved agent definition (UI label: "Agent"). */
export interface Automation {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  repositories: string[];
  prompt: string;
  attachments: AutomationAttachment[];
  agentAlias: string | null;
  modelName: string | null;
  capabilities: AgentCapability[];
  includePreviousReports: boolean;
  previousReportsLimit: number;
  scheduleCron: string | null;
  scheduleTimezone: string;
  scheduleEnabled: boolean;
  nextRunAt: number | null;
  autonomyMode: AgentAutonomyMode;
  enabled: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** One run of an agent. `report` and `definitionSnapshot` are absent from history rows. */
export interface AutomationRun {
  id: string;
  definitionId: string;
  ownerId: string;
  trigger: AgentRunTrigger;
  triggerSource: string | null;
  idempotencyKey: string | null;
  state: AgentRunState;
  autonomyMode: AgentAutonomyMode;
  definitionSnapshot?: Automation | null;
  reportTaskId: string | null;
  actionTaskId: string | null;
  report?: string | null;
  reportTruncated: boolean;
  actionSummary: string | null;
  /** Why a run was skipped or deferred (for example the usage gate's reason). */
  skipReason: string | null;
  failureReason: string | null;
  approvedBy: string | null;
  operatorNote: string | null;
  deferredUntil: number | null;
  deferrals: number;
  createdAt: number;
  startedAt: number | null;
  reportedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
}

export interface AutomationPage {
  automations: Automation[];
  total: number;
  limit: number;
  offset: number;
}

export interface AutomationRunPage {
  runs: AutomationRun[];
  total: number;
  limit: number;
  offset: number;
}

export interface AutomationTriggerResult {
  run: AutomationRun;
  /** False when the idempotency key already created this run; nothing new was started. */
  created: boolean;
  idempotencyKey: string;
  attempts: number;
  status: number;
}

export interface AutomationApiOptions {
  client?: ApiClient;
  /** Override for tests; defaults to the goal mutation attempt count. */
  attempts?: number;
  retryDelayMs?: number;
}

async function resolveClient(options: AutomationApiOptions): Promise<ApiClient> {
  return options.client ?? createApiClient();
}

function definitionPath(id: string, suffix = ""): string {
  return `/api/agent-definitions/${encodeURIComponent(id)}${suffix}`;
}

function runPath(runId: string, suffix = ""): string {
  return `/api/agent-runs/${encodeURIComponent(runId)}${suffix}`;
}

function pageParams(page: { limit?: number; offset?: number }): Record<string, number | undefined> {
  return { limit: page.limit, offset: page.offset };
}

export async function listAutomations(
  page: { limit?: number; offset?: number } = {},
  options: AutomationApiOptions = {},
): Promise<AutomationPage> {
  const client = await resolveClient(options);
  const response = await client.get<{ definitions?: Automation[]; total?: number; limit?: number; offset?: number }>(
    "/api/agent-definitions",
    { params: pageParams(page) },
  );
  const automations = response.data.definitions ?? [];
  return {
    automations,
    total: response.data.total ?? automations.length,
    limit: response.data.limit ?? page.limit ?? automations.length,
    offset: response.data.offset ?? page.offset ?? 0,
  };
}

export async function getAutomation(id: string, options: AutomationApiOptions = {}): Promise<Automation> {
  const client = await resolveClient(options);
  const response = await client.get<{ definition: Automation }>(definitionPath(id));
  return response.data.definition;
}

/**
 * The trigger primitive: starts (or, for a repeated key, returns) one run.
 * Sends `{ trigger: 'cli', source }` so the run records where it came from.
 */
export async function triggerAutomationRun(
  id: string,
  request: { idempotencyKey: string; source?: string },
  options: AutomationApiOptions = {},
): Promise<AutomationTriggerResult> {
  const client = await resolveClient(options);
  const result = await mutate<{ run: AutomationRun; created?: boolean }>(client, {
    method: "POST",
    endpoint: definitionPath(id, "/runs"),
    body: { trigger: "cli", ...(request.source ? { source: request.source } : {}) },
    idempotencyKey: request.idempotencyKey,
    attempts: options.attempts,
    retryDelayMs: options.retryDelayMs,
  });
  return {
    run: result.data.run,
    created: result.data.created ?? result.status === 202,
    idempotencyKey: request.idempotencyKey,
    attempts: result.attempts,
    status: result.status,
  };
}

export async function listAutomationRuns(
  id: string,
  page: { limit?: number; offset?: number } = {},
  options: AutomationApiOptions = {},
): Promise<AutomationRunPage> {
  const client = await resolveClient(options);
  const response = await client.get<Partial<AutomationRunPage>>(definitionPath(id, "/runs"), { params: pageParams(page) });
  const runs = response.data.runs ?? [];
  return {
    runs,
    total: response.data.total ?? runs.length,
    limit: response.data.limit ?? page.limit ?? runs.length,
    offset: response.data.offset ?? page.offset ?? 0,
  };
}

export async function getAutomationRun(
  runId: string,
  options: AutomationApiOptions & { signal?: AbortSignal } = {},
): Promise<AutomationRun> {
  const client = await resolveClient(options);
  const response = await client.get<{ run: AutomationRun }>(runPath(runId), { signal: options.signal });
  return response.data.run;
}

/**
 * Run decisions are compare-and-set on the server, so they are sent once:
 * a blind retry after a lost reply would be answered with a 409.
 */
async function runAction(
  runId: string,
  action: "approve" | "reject" | "cancel",
  body: Record<string, unknown>,
  options: AutomationApiOptions,
): Promise<AutomationRun> {
  const client = await resolveClient(options);
  const response = await client.post<{ run: AutomationRun }>(runPath(runId, `/${action}`), { body });
  return response.data.run;
}

export function approveAutomationRun(
  runId: string,
  request: { note?: string } = {},
  options: AutomationApiOptions = {},
): Promise<AutomationRun> {
  return runAction(runId, "approve", request.note ? { note: request.note } : {}, options);
}

export function rejectAutomationRun(runId: string, options: AutomationApiOptions = {}): Promise<AutomationRun> {
  return runAction(runId, "reject", {}, options);
}

export function cancelAutomationRun(runId: string, options: AutomationApiOptions = {}): Promise<AutomationRun> {
  return runAction(runId, "cancel", {}, options);
}
