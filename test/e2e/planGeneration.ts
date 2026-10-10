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

export interface PlanApi {
  createPlan(repo: string, prompt: string, client: ApiClient): Promise<{ draft_id: string }>;
  generatePlan(draftId: string, client: ApiClient): Promise<unknown>;
  getPlan(draftId: string, client: ApiClient): Promise<Pick<Plan, "status" | "plan_json" | "generation_trace">>;
  finalizePlan(draftId: string, client: ApiClient): Promise<unknown>;
  listPlanIssues(draftId: string, client: ApiClient): Promise<PlanIssue[]>;
}

export interface PlanGenerationOptions {
  /** Aborted when the enclosing test is cancelled or times out. */
  signal?: AbortSignal;
  /** Absolute epoch-ms deadline for the whole operation. */
  deadline?: number;
  api?: PlanApi;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (message: string) => void;
}

const liveApi: PlanApi = {
  createPlan: (repo, prompt, client) => createPlan(repo, prompt, {}, client),
  generatePlan: (draftId, client) => generatePlan(draftId, {}, client),
  getPlan: (draftId, client) => getPlan(draftId, client),
  finalizePlan: (draftId, client) => finalizePlan(draftId, client),
  listPlanIssues: (draftId, client) => listPlanIssues(draftId, client),
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
  const api = options.api ?? liveApi;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const log = options.log ?? console.log;
  const { signal } = options;
  const deadline = options.deadline ?? planDeadline(PLAN_GENERATION_TIMEOUT_MS + PLAN_ISSUES_TIMEOUT_MS, E2E_JOB_DEADLINE, now());

  signal?.throwIfAborted();
  if (now() >= deadline) {
    throw new PlanDeadlineError("Plan creation was not started: its E2E deadline has already passed.");
  }

  const plan = await api.createPlan(repo, prompt, client);
  // Recorded before anything else can throw, so the suite cleanup deletes it.
  createdPlanIds.push(plan.draft_id);
  const label = plan.draft_id.substring(0, 8);

  signal?.throwIfAborted();
  await api.generatePlan(plan.draft_id, client);

  const doneStatuses = new Set(["review", "executed", "approved", "merged", "pr_created", "failed"]);
  // Generation may use the whole budget except the issue wait after finalization.
  const generationDeadline = Math.min(now() + PLAN_GENERATION_TIMEOUT_MS, deadline - PLAN_ISSUES_TIMEOUT_MS);
  let lastStatus = "draft";
  let sawGenerating = false;
  let settled = false;

  while (now() < generationDeadline) {
    await sleep(Math.min(PLAN_POLL_INTERVAL_MS, Math.max(0, generationDeadline - now())), signal);
    signal?.throwIfAborted();
    const current = await api.getPlan(plan.draft_id, client);
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

  signal?.throwIfAborted();
  const currentPlan = await api.getPlan(plan.draft_id, client);
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

  signal?.throwIfAborted();
  await api.finalizePlan(plan.draft_id, client);
  signal?.throwIfAborted();
  const finalizedPlan = await api.getPlan(plan.draft_id, client);
  const expectedIssueCount = Math.max(1, Array.isArray(finalizedPlan.plan_json) ? finalizedPlan.plan_json.length : 1);

  const issuesDeadline = Math.min(now() + PLAN_ISSUES_TIMEOUT_MS, deadline);
  let issues: PlanIssue[] = [];
  for (;;) {
    signal?.throwIfAborted();
    issues = await api.listPlanIssues(plan.draft_id, client);
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
