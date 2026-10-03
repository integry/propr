/**
 * Goals API
 *
 * Typed access to the owner-scoped goal endpoints. Every mutation carries an
 * Idempotency-Key; transient transport failures are retried automatically with
 * the same key, so a retried request can never start a second goal or queue a
 * second input. Failures whose outcome cannot be known are surfaced as
 * {@link GoalMutationUncertainError} with the key needed to recover safely.
 */

import { randomUUID } from "node:crypto";
import { ApiClient, createApiClient } from "./client.js";
import { ApiError, NetworkError, TimeoutError } from "./errors.js";

export const GOAL_LAUNCH_STRATEGIES = ["direct", "orchestrate"] as const;
export type GoalLaunchStrategy = typeof GOAL_LAUNCH_STRATEGIES[number];

export const GOAL_LIST_STATES = ["active", "running", "paused", "completed", "failed", "cancelled", "all"] as const;
export type GoalListState = typeof GOAL_LIST_STATES[number];

/** Matches the MCP mutation key contract so one key format works on every surface. */
export const IDEMPOTENCY_KEY_PATTERN = /^[\w.-]{8,128}$/;

/** Total attempts for one logical mutation, including the first. */
export const GOAL_MUTATION_ATTEMPTS = 3;
const GOAL_MUTATION_RETRY_DELAY_MS = 500;

export interface GoalCapabilityAgent {
  agentId: string;
  agentAlias: string;
  agentType: string;
  goalCapable: boolean;
  reason?: string;
  lifecycle: Record<string, string> | null;
  controls: Record<string, boolean>;
  models: string[];
  defaultModel: string | null;
  objectiveMaxCharacters: number | null;
}

export interface GoalInput {
  id: string;
  message: string;
  attachmentCount: number;
  state: "pending" | "delivered" | "undeliverable";
  createdAt: string | null;
  deliveredAt: string | null;
}

export interface GoalCheckpoint {
  intervalMinutes: number | null;
  count: number;
  lastAt: string | null;
  lastCommitSha: string | null;
  error: string | null;
  pending: boolean;
  latest: Record<string, unknown> | null;
}

/** The server goal projection shared with the Web UI. */
export interface Goal {
  id: string;
  owner: string;
  repository: string;
  title: string;
  objective: string;
  launchStrategy: GoalLaunchStrategy;
  baseBranch: string | null;
  branchName: string | null;
  agent: { id: string; alias: string; type: string };
  requestedModel: string;
  effectiveModel: string | null;
  maxParallelTasks: number | null;
  ultrafix: boolean | null;
  desiredState: "running" | "paused" | "cancelled";
  resultState: "completed" | "failed" | "cancelled" | null;
  failureReason: string | null;
  pausePending: boolean;
  control: { requestGeneration: number; acknowledgedGeneration: number; pending: boolean };
  taskId: string;
  sessionId: string | null;
  conversationId: string | null;
  finalPr: { number: number | null; url: string } | null;
  checkpoint: GoalCheckpoint | null;
  artifactStats?: Record<string, number>;
  taskState: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  elapsedMs: number;
  pausedMs: number;
  activeMs: number;
  inputs?: GoalInput[];
}

/** Shared detail projection (also returned by MCP `get_goal`). */
export interface GoalDetail {
  currentActivity: { currentFocus: string | null; entries: Array<{ timestamp: string | null; message: string }>; order: string };
  progress: {
    tasks: { total: number; active: number; completed: number; failed: number; cancelled: number };
    recentTerminalTransitions: Array<{ taskId: string; state: string; at: string | null; reason: string | null }>;
    startedAt: string | null;
    elapsedSeconds: number | null;
    checkpoint: Record<string, unknown> | null;
  };
  pendingInput: {
    waitingForOperator: boolean;
    reason: string | null;
    undeliveredInputs: number;
    lastInputAt: string | null;
    lastInputDeliveredAt: string | null;
  };
  pullRequests: Array<{ number: number; state: string | null; role: "final" | "task"; taskId?: string }>;
}

export interface GoalListResponse {
  goals: Goal[];
  offset: number;
  limit: number;
  nextOffset: number | null;
}

export interface GoalInputPage {
  inputs: GoalInput[];
  order: string;
  offset: number;
  limit: number;
  nextOffset: number | null;
}

export interface CreateGoalRequest {
  repository: string;
  objective: string;
  agentId: string;
  model: string;
  launchStrategy: GoalLaunchStrategy;
  baseBranch?: string;
  maxParallelTasks?: number;
  checkpointIntervalMinutes?: number;
  ultrafix?: boolean;
}

/**
 * - `created`: this request durably created and queued the goal.
 * - `replayed`: the key already created this goal; nothing new was started.
 * - `saved_queue_pending`: the goal was saved but its first attempt is waiting on server recovery.
 */
export type GoalCreateOutcome = "created" | "replayed" | "saved_queue_pending";

export interface GoalMutationResult {
  goal: Goal | null;
  idempotencyKey: string;
  attempts: number;
  status: number;
}

export interface GoalCreateResult extends GoalMutationResult {
  outcome: GoalCreateOutcome;
  goalId: string;
}

/**
 * The server may or may not have applied the mutation. Re-running the same
 * command with `idempotencyKey` is always safe: it returns the original
 * result instead of applying the mutation twice.
 */
export class GoalMutationUncertainError extends Error {
  constructor(
    message: string,
    readonly idempotencyKey: string,
    readonly attempts: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GoalMutationUncertainError";
  }
}

export function newIdempotencyKey(): string {
  return `cli-${randomUUID()}`;
}

/** Returns a validated caller key, or a fresh one for a new logical request. */
export function resolveIdempotencyKey(supplied: string | undefined): string {
  if (supplied === undefined) return newIdempotencyKey();
  if (!IDEMPOTENCY_KEY_PATTERN.test(supplied)) {
    throw new Error("Idempotency key must be 8-128 characters of letters, digits, '_', '.', or '-'.");
  }
  return supplied;
}

function goalPath(goalId: string, suffix = ""): string {
  return `/api/goals/${encodeURIComponent(goalId)}${suffix}`;
}

/** Transport failures and gateway errors that never carry a definitive server answer. */
function isTransientFailure(error: unknown): boolean {
  if (error instanceof NetworkError || error instanceof TimeoutError) return true;
  return error instanceof ApiError && [502, 503, 504].includes(error.status) && !queuedGoalId(error);
}

/** A 503 with a goal ID means creation was durably saved and queue recovery is pending. */
function queuedGoalId(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 503) return null;
  const goalId = (error.response as { goalId?: unknown } | undefined)?.goalId;
  return typeof goalId === "string" && goalId ? goalId : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MutationOptions {
  method: "POST" | "PATCH";
  endpoint: string;
  body?: unknown;
  idempotencyKey: string;
  attempts?: number;
  retryDelayMs?: number;
}

/**
 * Sends one logical mutation, retrying transient failures with the same key.
 * Definitive HTTP answers (4xx, 500) are rethrown unchanged; exhausted
 * transient failures become {@link GoalMutationUncertainError}.
 */
async function mutate<T>(
  client: ApiClient,
  options: MutationOptions,
): Promise<{ data: T; status: number; attempts: number }> {
  const maxAttempts = options.attempts ?? GOAL_MUTATION_ATTEMPTS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await client.request<T>(options.endpoint, {
        method: options.method,
        body: options.body,
        headers: { "Idempotency-Key": options.idempotencyKey },
      });
      return { data: response.data, status: response.status, attempts: attempt };
    } catch (error) {
      if (!isTransientFailure(error)) {
        if (error instanceof ApiError && error.status >= 500 && !queuedGoalId(error)) {
          throw new GoalMutationUncertainError(error.message, options.idempotencyKey, attempt, error);
        }
        if (error instanceof ApiError) Object.assign(error, { attempts: attempt });
        throw error;
      }
      lastError = error;
      if (attempt < maxAttempts) await sleep((options.retryDelayMs ?? GOAL_MUTATION_RETRY_DELAY_MS) * attempt);
    }
  }
  throw new GoalMutationUncertainError(
    lastError instanceof Error ? lastError.message : String(lastError),
    options.idempotencyKey,
    maxAttempts,
    lastError,
  );
}

export interface GoalApiOptions {
  client?: ApiClient;
  /** Override for tests; defaults to {@link GOAL_MUTATION_ATTEMPTS}. */
  attempts?: number;
  retryDelayMs?: number;
}

async function resolveClient(options: GoalApiOptions): Promise<ApiClient> {
  return options.client ?? createApiClient();
}

export async function getGoalCapabilities(
  recheck = false,
  options: GoalApiOptions = {},
): Promise<GoalCapabilityAgent[]> {
  const client = await resolveClient(options);
  const response = await client.get<{ agents: GoalCapabilityAgent[] }>("/api/goals/capabilities", {
    params: recheck ? { recheck: "true" } : undefined,
  });
  return response.data.agents ?? [];
}

export async function listGoals(
  query: { repository?: string; state?: GoalListState; offset?: number; limit?: number } = {},
  options: GoalApiOptions = {},
): Promise<GoalListResponse> {
  const client = await resolveClient(options);
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 20;
  const response = await client.get<Partial<GoalListResponse> & { goals: Goal[] }>("/api/goals", {
    params: {
      repository: query.repository,
      state: query.state && query.state !== "all" ? query.state : undefined,
      offset,
      limit,
    },
  });
  const goals = response.data.goals ?? [];
  return {
    goals,
    offset: response.data.offset ?? offset,
    limit: response.data.limit ?? limit,
    // Servers predating pagination ignore offset/limit; never loop on them.
    nextOffset: response.data.nextOffset ?? null,
  };
}

export async function getGoalDetail(
  goalId: string,
  options: GoalApiOptions = {},
): Promise<{ goal: Goal; detail: GoalDetail }> {
  const client = await resolveClient(options);
  const response = await client.get<{ goal: Goal; detail: GoalDetail }>(goalPath(goalId, "/detail"));
  return response.data;
}

export async function listGoalInputs(
  goalId: string,
  page: { offset?: number; limit?: number } = {},
  options: GoalApiOptions = {},
): Promise<GoalInputPage> {
  const client = await resolveClient(options);
  const offset = page.offset ?? 0;
  const limit = page.limit ?? 20;
  const response = await client.get<GoalInputPage>(goalPath(goalId, "/inputs"), { params: { offset, limit } });
  return { ...response.data, offset: response.data.offset ?? offset, limit: response.data.limit ?? limit };
}

/** Creates a goal and explicitly starts autonomous work on it. */
export async function createGoal(
  request: CreateGoalRequest,
  idempotencyKey: string,
  options: GoalApiOptions = {},
): Promise<GoalCreateResult> {
  const client = await resolveClient(options);
  try {
    const result = await mutate<{ goal: Goal }>(client, {
      method: "POST", endpoint: "/api/goals", body: request, idempotencyKey,
      attempts: options.attempts, retryDelayMs: options.retryDelayMs,
    });
    return {
      goal: result.data.goal,
      goalId: result.data.goal.id,
      idempotencyKey,
      attempts: result.attempts,
      status: result.status,
      outcome: result.status === 201 ? "created" : "replayed",
    };
  } catch (error) {
    const goalId = queuedGoalId(error);
    if (!goalId) throw error;
    return {
      goal: null, goalId, idempotencyKey,
      attempts: (error as { attempts?: number }).attempts ?? 1,
      status: 503, outcome: "saved_queue_pending",
    };
  }
}

async function goalMutation(
  goalId: string,
  action: { method: "POST" | "PATCH"; suffix: string; body?: unknown },
  idempotencyKey: string,
  options: GoalApiOptions,
): Promise<GoalMutationResult> {
  const client = await resolveClient(options);
  const result = await mutate<{ goal: Goal }>(client, {
    method: action.method, endpoint: goalPath(goalId, action.suffix), body: action.body ?? {}, idempotencyKey,
    attempts: options.attempts, retryDelayMs: options.retryDelayMs,
  });
  return { goal: result.data.goal, idempotencyKey, attempts: result.attempts, status: result.status };
}

export function sendGoalInput(
  goalId: string,
  input: { message: string } | { canned: "done" | "left" },
  idempotencyKey: string,
  options: GoalApiOptions = {},
): Promise<GoalMutationResult> {
  return goalMutation(goalId, { method: "POST", suffix: "/input", body: input }, idempotencyKey, options);
}

export function pauseGoal(goalId: string, idempotencyKey: string, options: GoalApiOptions = {}): Promise<GoalMutationResult> {
  return goalMutation(goalId, { method: "POST", suffix: "/pause" }, idempotencyKey, options);
}

export function resumeGoal(goalId: string, idempotencyKey: string, options: GoalApiOptions = {}): Promise<GoalMutationResult> {
  return goalMutation(goalId, { method: "POST", suffix: "/resume" }, idempotencyKey, options);
}

export function cancelGoal(goalId: string, idempotencyKey: string, options: GoalApiOptions = {}): Promise<GoalMutationResult> {
  return goalMutation(goalId, { method: "POST", suffix: "/cancel" }, idempotencyKey, options);
}

export function setGoalModel(
  goalId: string,
  model: string,
  idempotencyKey: string,
  options: GoalApiOptions = {},
): Promise<GoalMutationResult> {
  return goalMutation(goalId, { method: "PATCH", suffix: "/model", body: { model } }, idempotencyKey, options);
}
