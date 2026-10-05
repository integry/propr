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
import { GOAL_WAIT_MAX_TIMEOUT_SECONDS } from "@propr/shared";
import type { GoalAttention, GoalWaitCondition, GoalWaitEvent, GoalWaitOutcome } from "@propr/shared";
import { ApiClient, createApiClient } from "./client.js";
import { ApiError, NetworkError, RequestCancelledError, TimeoutError } from "./errors.js";

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
  /** Open blockers from the shared projection; absent on servers that predate it. */
  attention?: GoalAttention;
}

/** Goals waiting on their operator, from the shared attention projection. */
export interface GoalAttentionEntry {
  goalId: string;
  repository: string;
  title: string | null;
  taskId: string | null;
  desiredState: string | null;
  waitingForOperator: boolean;
  reason: GoalAttention["reason"];
  blockers: GoalAttention["blockers"];
}

export interface GoalAttentionPage {
  goals: GoalAttentionEntry[];
  offset: number;
  limit: number;
  nextOffset: number | null;
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
 *
 * `refusal` is set when a retry after an unconfirmed attempt was rejected
 * before the server could resolve the key (401/403), e.g. because the login
 * expired mid-retry. The earlier attempt may still have been applied.
 */
export class GoalMutationUncertainError extends Error {
  constructor(
    message: string,
    readonly idempotencyKey: string,
    readonly attempts: number,
    readonly cause?: unknown,
    readonly refusal?: ApiError,
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

/**
 * Access refusals can precede the server's idempotency lookup, so they say
 * nothing about whether an earlier unconfirmed attempt was applied.
 */
function isAccessRefusal(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
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
 * transient failures become {@link GoalMutationUncertainError}, as does an
 * access refusal that follows an unconfirmed attempt.
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
        if (lastError !== undefined && isAccessRefusal(error)) {
          const earlier = lastError instanceof Error ? lastError.message : String(lastError);
          throw new GoalMutationUncertainError(
            `${earlier}; the retry was then refused (${error.status}): ${error.message}`,
            options.idempotencyKey,
            attempt,
            lastError,
            error,
          );
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

export async function listGoalAttention(
  query: { repository?: string; offset?: number; limit?: number } = {},
  options: GoalApiOptions = {},
): Promise<GoalAttentionPage> {
  const client = await resolveClient(options);
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 20;
  const response = await client.get<Partial<GoalAttentionPage>>("/api/goals/attention", {
    params: { repository: query.repository, offset, limit },
  });
  return {
    goals: response.data.goals ?? [],
    offset: response.data.offset ?? offset,
    limit: response.data.limit ?? limit,
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

/** One bounded server-side wait, as returned by `GET /api/goals/:goalId/wait`. */
export interface GoalWaitResponse {
  outcome: GoalWaitOutcome;
  condition: GoalWaitCondition | null;
  cursor: string;
  event: GoalWaitEvent | null;
  matchedImmediately: boolean;
  goal: {
    id: string;
    repository: string;
    title: string | null;
    lifecycleState: string;
    requestedState: string;
    resultState: string | null;
    terminal: boolean;
    goalCompleted: boolean;
    pauseConfirmed: boolean;
    currentTaskId: string | null;
    checkpoint: { count: number; lastAt: string | null };
    finalPr: { number: number; url: string | null } | null;
    failureReason: string | null;
    updatedAt: string | null;
    completedAt: string | null;
  };
  waitedMs: number;
  timeoutSeconds: number;
}

/** Extra time the HTTP request may take beyond the server-side wait. */
const GOAL_WAIT_REQUEST_GRACE_MS = 15_000;

/** One bounded wait request (at most {@link GOAL_WAIT_MAX_TIMEOUT_SECONDS} seconds). */
export async function waitGoalOnce(
  goalId: string,
  request: { until?: GoalWaitCondition; afterCursor?: string; timeoutSeconds: number },
  options: GoalApiOptions & { signal?: AbortSignal } = {},
): Promise<GoalWaitResponse> {
  const client = await resolveClient(options);
  const timeoutSeconds = Math.min(Math.max(0, request.timeoutSeconds), GOAL_WAIT_MAX_TIMEOUT_SECONDS);
  const response = await client.get<GoalWaitResponse>(goalPath(goalId, "/wait"), {
    params: { until: request.until, afterCursor: request.afterCursor, timeoutSeconds },
    timeout: timeoutSeconds * 1000 + GOAL_WAIT_REQUEST_GRACE_MS,
    signal: options.signal,
  });
  return response.data;
}

/**
 * Time the last request's reply may take to arrive after the overall deadline
 * before the CLI abandons it, so `--timeout 0` can still check once and a
 * server answering exactly at the deadline is not discarded.
 */
export const GOAL_WAIT_REPLY_GRACE_MS = 2_000;

export interface GoalWaitChainResult extends Omit<GoalWaitResponse, "cursor" | "goal"> {
  /** Last cursor the server returned (or the caller supplied); null when no request completed. */
  cursor: string | null;
  /** Current goal projection; null when the deadline passed before any request completed. */
  goal: GoalWaitResponse["goal"] | null;
  /** Bounded requests issued to reach this result. */
  requests: number;
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Chain bounded wait requests until the condition matches, the goal can no
 * longer match, or the overall deadline passes. The cursor returned by each
 * request is carried into the next, so nothing between requests is missed or
 * reported twice. Without a caller cursor, a non-blocking request first
 * establishes the baseline cursor, so every blocking request, and every retry
 * of one, keeps the original observation boundary. Transient transport
 * failures are retried with the same cursor until the deadline; one still
 * failing at the deadline resolves as `timed_out`.
 *
 * The deadline aborts in-flight requests and retry delays (after
 * {@link GOAL_WAIT_REPLY_GRACE_MS}) and resolves as `timed_out` with the last
 * cursor; aborting `signal` (Ctrl-C) only stops waiting and rejects with
 * {@link RequestCancelledError}.
 */
// eslint-disable-next-line complexity -- one loop keeps baseline, deadline, retry and cancellation handling auditable together
export async function waitGoalUntil(
  goalId: string,
  request: { until?: GoalWaitCondition; afterCursor?: string; deadline: number },
  options: GoalApiOptions & {
    signal?: AbortSignal;
    now?: () => number;
    retryDelayMs?: number;
    replyGraceMs?: number;
    /** Called with every cursor the server returns, so an interrupted wait can still resume. */
    onCursor?: (cursor: string) => void;
  } = {},
): Promise<GoalWaitChainResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  let cursor = request.afterCursor;
  let requests = 0;
  let last: GoalWaitResponse | null = null;
  const expired = new AbortController();
  const stopAfterMs = Math.max(0, request.deadline - startedAt) + (options.replyGraceMs ?? GOAL_WAIT_REPLY_GRACE_MS);
  const expiry = setTimeout(() => expired.abort(), stopAfterMs);
  const signal = options.signal ? AbortSignal.any([options.signal, expired.signal]) : expired.signal;
  const timedOut = (): GoalWaitChainResult => ({
    outcome: "timed_out",
    condition: request.until ?? null,
    cursor: cursor ?? null,
    event: null,
    matchedImmediately: false,
    goal: last?.goal ?? null,
    waitedMs: now() - startedAt,
    timeoutSeconds: Math.max(0, request.deadline - startedAt) / 1000,
    requests,
  });
  try {
    for (;;) {
      const remainingSeconds = Math.max(0, (request.deadline - now()) / 1000);
      try {
        requests++;
        last = await waitGoalOnce(goalId, {
          until: request.until, afterCursor: cursor,
          // The baseline request never blocks, so losing its reply cannot hide an event published while it waited.
          timeoutSeconds: cursor === undefined ? 0 : Math.min(remainingSeconds, GOAL_WAIT_MAX_TIMEOUT_SECONDS),
        }, { ...options, signal });
      } catch (error) {
        if (options.signal?.aborted) throw error instanceof RequestCancelledError ? error : new RequestCancelledError();
        if (!isTransientFailure(error) && !expired.signal.aborted) throw error;
        // A deadline reached while a request or its transient retries were pending is a timeout, not an error.
        if (expired.signal.aborted || request.deadline - now() <= 0) return timedOut();
        await abortableSleep(Math.min(options.retryDelayMs ?? GOAL_MUTATION_RETRY_DELAY_MS, Math.max(0, request.deadline - now())), signal);
        continue;
      }
      cursor = last.cursor;
      options.onCursor?.(cursor);
      if (last.outcome !== "timed_out" || request.deadline - now() <= 0) return { ...last, requests };
    }
  } finally {
    clearTimeout(expiry);
  }
}
