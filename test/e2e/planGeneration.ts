/**
 * Live E2E plan creation with an explicit deadline and cancellation.
 *
 * A plan attempt (create, generate, wait for review, finalize, wait for issues)
 * must finish inside the node:test suite that started it. When that suite times
 * out, node:test only aborts the test's signal: work that ignores the signal
 * keeps polling, retrying and creating plans while later suites run, and can
 * outlive the after() cleanup. Every wait here therefore observes the signal,
 * and every attempt is bounded by a deadline that the suite timeout, and the
 * nightly job budget, are derived from.
 */

import type { ApiClient } from "../../packages/cli/src/api/client.js";
import {
  createPlan,
  getPlan,
  generatePlan,
  finalizePlan,
  listPlanIssues,
  type Plan,
  type PlanIssue,
} from "../../packages/cli/src/api/plans.js";

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

// A successful brownfield generation on the nightly server took 621s, past the
// former 600s polling window. Leave real headroom above that observation.
export const PLAN_GENERATION_TIMEOUT_MS = 15 * 60_000;
// Finalization creates the GitHub issues; waiting for them is bounded separately.
export const PLAN_ISSUES_TIMEOUT_MS = 2 * 60_000;
// Time the enclosing test keeps after the helper's deadline to report the
// failure and let the suite's own cleanup run before node:test cancels it.
export const PLAN_SUITE_CLEANUP_MS = 60_000;
// A retry is only started when this much of the budget is left; a shorter
// attempt could not plausibly reach review and finalization.
export const PLAN_RETRY_MIN_REMAINING_MS = 5 * 60_000;
// Budget of one plan-creation test: one full slow attempt plus room for a quick
// retry after an early generation failure.
export const PLAN_TEST_BUDGET_MS = PLAN_GENERATION_TIMEOUT_MS + PLAN_ISSUES_TIMEOUT_MS + PLAN_RETRY_MIN_REMAINING_MS;
// node:test timeout of a plan-creation test. It is a backstop: the helper's own
// deadline expires first and produces a descriptive failure.
export const PLAN_TEST_TIMEOUT_MS = PLAN_TEST_BUDGET_MS + PLAN_SUITE_CLEANUP_MS;
// The model matrix collects issues from several plans before implementing them
// inside its 60-minute suite; plan creation may use at most this share of it.
export const MODEL_MATRIX_PLAN_BUDGET_MS = 25 * 60_000;

export const PLAN_POLL_INTERVAL_MS = 5_000;
export const PLAN_ISSUES_POLL_INTERVAL_MS = 3_000;

/**
 * Absolute epoch-ms deadline by which E2E work must have stopped for the
 * nightly job (120 minutes, which also runs the full test suite first) to still
 * upload its diagnostics. Unset or invalid means no job-level bound.
 */
export function parseJobDeadline(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export const E2E_JOB_DEADLINE = parseJobDeadline(process.env.PROPR_E2E_DEADLINE_EPOCH_MS);

/** The earliest of a test budget starting now and the job deadline. */
export function planDeadline(
  budgetMs = PLAN_TEST_BUDGET_MS,
  jobDeadline = E2E_JOB_DEADLINE,
  now = Date.now(),
): number {
  const testDeadline = now + budgetMs;
  return jobDeadline === undefined ? testDeadline : Math.min(testDeadline, jobDeadline);
}

// ---------------------------------------------------------------------------
// Dependencies (injectable for deterministic tests)
// ---------------------------------------------------------------------------

/**
 * Forwarded to every API request: the signal aborts the in-flight request and
 * its retries when the test is cancelled or the deadline passes, and the
 * timeout never lets one attempt run past the deadline.
 */
export interface PlanRequest {
  signal: AbortSignal;
  timeout: number;
}

export interface PlanApi {
  createPlan(repo: string, prompt: string, client: ApiClient, request: PlanRequest): Promise<{ draft_id: string }>;
  generatePlan(draftId: string, client: ApiClient, request: PlanRequest): Promise<unknown>;
  getPlan(draftId: string, client: ApiClient, request: PlanRequest): Promise<Pick<Plan, "status" | "plan_json" | "generation_trace">>;
  finalizePlan(draftId: string, client: ApiClient, request: PlanRequest): Promise<unknown>;
  listPlanIssues(draftId: string, client: ApiClient, request: PlanRequest): Promise<PlanIssue[]>;
}

export interface PlanGenerationOptions {
  /** Aborted when the enclosing test is cancelled or times out. */
  signal?: AbortSignal;
  /** Absolute epoch-ms deadline for the whole operation. */
  deadline?: number;
  /**
   * Receives every API request, including one the helper stopped waiting for
   * after cancellation, so cleanup can wait until no request is in flight.
   */
  tracker?: PlanWorkTracker;
  api?: PlanApi;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (message: string) => void;
}

// The CLI client's default per-attempt timeout; the deadline may shorten it.
export const PLAN_REQUEST_TIMEOUT_MS = 30_000;

const liveApi: PlanApi = {
  createPlan: (repo, prompt, client, request) => createPlan(repo, prompt, {}, client, request),
  generatePlan: (draftId, client, request) => generatePlan(draftId, {}, client, request),
  getPlan: (draftId, client, request) => getPlan(draftId, client, request),
  finalizePlan: (draftId, client, request) => finalizePlan(draftId, client, request),
  listPlanIssues: (draftId, client, request) => listPlanIssues(draftId, client, request),
};

/** Sleep that rejects as soon as the signal aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/** Settles like `work`, or rejects as soon as the signal aborts. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export class PlanDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanDeadlineError";
  }
}

// ---------------------------------------------------------------------------
// Planner failures
// ---------------------------------------------------------------------------

// The planner reports a provider credential rejection (for example an expired
// Claude OAuth session) with this fixed summary. Another generation attempt
// cannot succeed until the account is signed back in, so retrying only burns
// the suite timeout and hides the cause behind "produced 0 issue(s)".
const PLANNER_AUTHENTICATION_FAILURE = "Plan generation could not authenticate with a required service.";

export function isPlannerAuthenticationFailure(reason: unknown): boolean {
  return typeof reason === "string" && reason.trim() === PLANNER_AUTHENTICATION_FAILURE;
}

// ---------------------------------------------------------------------------
// Plan creation
// ---------------------------------------------------------------------------

export async function createAndGeneratePlan(
  repo: string,
  prompt: string,
  client: ApiClient,
  createdPlanIds: string[],
  options: PlanGenerationOptions = {},
): Promise<{ planId: string; issues: PlanIssue[] }> {
  const now = options.now ?? Date.now;
  const deadline = options.deadline ?? planDeadline(PLAN_GENERATION_TIMEOUT_MS + PLAN_ISSUES_TIMEOUT_MS, E2E_JOB_DEADLINE, now());

  options.signal?.throwIfAborted();
  if (now() >= deadline) {
    throw new PlanDeadlineError("Plan creation was not started: its E2E deadline has already passed.");
  }

  // One signal for the whole operation: aborted by the test's signal or when
  // the deadline passes, and forwarded to every request and sleep.
  const operation = new AbortController();
  const { signal } = options;
  const forwardAbort = () => operation.abort(abortReason(signal!));
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const deadlineTimer = setTimeout(
    () => operation.abort(new PlanDeadlineError("Plan creation exceeded its E2E deadline.")),
    Math.min(Math.max(0, deadline - now()), 2 ** 31 - 1),
  );
  deadlineTimer.unref?.();
  try {
    return await runPlanAttempt(repo, prompt, client, createdPlanIds, { ...options, now, deadline }, operation.signal);
  } finally {
    clearTimeout(deadlineTimer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

async function runPlanAttempt(
  repo: string,
  prompt: string,
  client: ApiClient,
  createdPlanIds: string[],
  options: PlanGenerationOptions & { now: () => number; deadline: number },
  signal: AbortSignal,
): Promise<{ planId: string; issues: PlanIssue[] }> {
  const api = options.api ?? liveApi;
  const sleep = options.sleep ?? abortableSleep;
  const log = options.log ?? console.log;
  const { now, deadline, tracker } = options;
  let label = "(not yet created)";

  /** Fails once the operation is cancelled or its deadline has passed. */
  const checkpoint = (step: string) => {
    signal.throwIfAborted();
    if (now() >= deadline) {
      throw new PlanDeadlineError(`Plan ${label} reached its E2E deadline ${step}.`);
    }
  };

  /**
   * Runs one request bounded by the operation: never started after
   * cancellation or the deadline, abandoned as soon as either happens, and
   * its result discarded when it arrives after the deadline.
   */
  const call = async <T>(step: string, request: (options: PlanRequest) => Promise<T>): Promise<T> => {
    checkpoint(`before ${step}`);
    const work = request({ signal, timeout: Math.max(1, Math.min(PLAN_REQUEST_TIMEOUT_MS, deadline - now())) });
    tracker?.track(work);
    const result = await untilAborted(work, signal);
    checkpoint(`while waiting for ${step}`);
    return result;
  };

  // Recorded when the server answers, even if the helper stopped waiting, so
  // the suite cleanup deletes a plan created during a cancellation race.
  const plan = await call("plan creation", (request) =>
    api.createPlan(repo, prompt, client, request).then((created) => {
      createdPlanIds.push(created.draft_id);
      return created;
    }));
  label = plan.draft_id.substring(0, 8);

  await call("generation start", (request) => api.generatePlan(plan.draft_id, client, request));

  const doneStatuses = new Set(["review", "executed", "approved", "merged", "pr_created", "failed"]);
  // Generation may use the whole budget except the issue wait after finalization.
  const generationDeadline = Math.min(now() + PLAN_GENERATION_TIMEOUT_MS, deadline - PLAN_ISSUES_TIMEOUT_MS);
  let lastStatus = "draft";
  let sawGenerating = false;
  let settled = false;

  while (now() < generationDeadline) {
    await sleep(Math.min(PLAN_POLL_INTERVAL_MS, Math.max(0, generationDeadline - now())), signal);
    const current = await call("plan status", (request) => api.getPlan(plan.draft_id, client, request));
    if (current.status !== lastStatus) {
      log(`    Plan ${label}: ${lastStatus} -> ${current.status}`);
      lastStatus = current.status;
    }
    if (current.status === "generating" || current.status === "refining") sawGenerating = true;
    if (doneStatuses.has(current.status) || (current.status === "draft" && sawGenerating)) {
      settled = true;
      break;
    }
  }

  const currentPlan = await call("plan status", (request) => api.getPlan(plan.draft_id, client, request));
  if (!settled && !doneStatuses.has(currentPlan.status)) {
    throw new PlanDeadlineError(
      `Plan ${label} was still ${currentPlan.status} when its generation deadline expired; it did not reach review.`,
    );
  }
  if (!sawGenerating || currentPlan.status === "failed") {
    const reason = currentPlan.generation_trace?.error;
    if (typeof reason === "string" && reason) {
      log(`    Plan ${label} failed: ${reason}`);
      if (isPlannerAuthenticationFailure(reason)) {
        throw new Error(
          `Plan ${label} failed: ${reason} Reauthenticate the planner's provider account on the E2E server; retrying cannot succeed until then.`,
        );
      }
    }
    return { planId: plan.draft_id, issues: [] };
  }
  if (currentPlan.status !== "review") {
    log(`    Plan ${label} not ready to finalize: ${currentPlan.status}`);
    return { planId: plan.draft_id, issues: [] };
  }

  await call("finalization", (request) => api.finalizePlan(plan.draft_id, client, request));
  const finalizedPlan = await call("finalized plan", (request) => api.getPlan(plan.draft_id, client, request));
  const expectedIssueCount = Math.max(1, Array.isArray(finalizedPlan.plan_json) ? finalizedPlan.plan_json.length : 1);

  const issuesDeadline = Math.min(now() + PLAN_ISSUES_TIMEOUT_MS, deadline);
  let issues: PlanIssue[] = [];
  for (;;) {
    issues = await call("plan issues", (request) => api.listPlanIssues(plan.draft_id, client, request));
    if (issues.length >= expectedIssueCount) return { planId: plan.draft_id, issues };
    if (now() >= issuesDeadline) break;
    await sleep(Math.min(PLAN_ISSUES_POLL_INTERVAL_MS, Math.max(0, issuesDeadline - now())), signal);
  }
  throw new PlanDeadlineError(
    `Plan ${label} was finalized but only ${issues.length}/${expectedIssueCount} issue(s) appeared before its deadline.`,
  );
}

/**
 * Create plans until one yields `minIssues` issues. A new attempt is started
 * only while the test is not cancelled and enough of the deadline remains for
 * it to reach review and finalization.
 */
export async function createPlanWithRetries(
  repo: string,
  label: string,
  prompt: string,
  client: ApiClient,
  createdPlanIds: string[],
  options: PlanGenerationOptions & { minIssues?: number; attempts?: number } = {},
): Promise<{ planId: string; issues: PlanIssue[] }> {
  const { minIssues = 1, attempts = 3, ...planOptions } = options;
  const now = planOptions.now ?? Date.now;
  const log = planOptions.log ?? console.log;
  const deadline = planOptions.deadline ?? planDeadline(PLAN_TEST_BUDGET_MS, E2E_JOB_DEADLINE, now());

  let lastResult: { planId: string; issues: PlanIssue[] } | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    planOptions.signal?.throwIfAborted();
    if (attempt > 1 && deadline - now() < PLAN_RETRY_MIN_REMAINING_MS) {
      log(`    ${label} plan: ${Math.max(0, deadline - now())}ms left, not starting attempt ${attempt}`);
      break;
    }
    const result = await createAndGeneratePlan(repo, prompt, client, createdPlanIds, { ...planOptions, deadline });
    lastResult = result;
    if (result.issues.length >= minIssues) return result;
    log(`    ${label} plan attempt ${attempt} produced ${result.issues.length} issue(s)`);
  }
  return lastResult ?? { planId: "", issues: [] };
}

// ---------------------------------------------------------------------------
// In-flight work
// ---------------------------------------------------------------------------

/**
 * Tracks plan operations so suite cleanup can wait for cancelled work to
 * settle before deleting the plans it created.
 */
export class PlanWorkTracker {
  private readonly pending = new Set<Promise<unknown>>();

  track<T>(work: Promise<T>): Promise<T> {
    const settled = work.then(() => undefined, () => undefined);
    this.pending.add(settled);
    void settled.then(() => this.pending.delete(settled));
    return work;
  }

  get size(): number {
    return this.pending.size;
  }

  /** Resolves true once every tracked operation settled, false on timeout. */
  async settle(timeoutMs: number): Promise<boolean> {
    if (this.pending.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([Promise.all([...this.pending]).then(() => true as const), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }
}
