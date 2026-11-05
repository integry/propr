import { MODEL_MATRIX_PLAN_BUDGET_MS, PLAN_SUITE_CLEANUP_MS } from "./planGeneration.js";

// Execution polling alone retains its full 30-minute default, starting AFTER
// discovery. PROPR_E2E_MODEL_TASK_TIMEOUT_MS overrides only this execution budget.
export const DEFAULT_MODEL_TASK_TIMEOUT_MS = 30 * 60 * 1000;

export const MODEL_TASK_DISCOVERY_POLLS = 60;
export const MODEL_TASK_POLL_INTERVAL_MS = 10_000;
// Covers issue lookup/submission, discovery API latency and the final execution
// poll's API latency. Discovery's ten minutes of sleeps are separate from this.
export const MODEL_PHASE_OVERHEAD_MS = 5 * 60_000;
export const MODEL_MATRIX_FOLLOWUP_BUDGET_MS = 2.5 * 60_000;

/** Whole implementation phase, not a replacement for execution polling. */
export function modelPhaseBudgetMs(executionMs: number): number {
  return MODEL_TASK_DISCOVERY_POLLS * MODEL_TASK_POLL_INTERVAL_MS + executionMs + MODEL_PHASE_OVERHEAD_MS;
}

/**
 * Backstop for plan creation, two whole implementation phases, history and logs.
 * Each child gets cancellation/unwind headroom, plus one share for the suite.
 * Default: 25 + 2*45 + 2*2.5 + 6*1 = 126 minutes. This deliberately exceeds
 * the dedicated job's 110-minute work deadline: remaining job time still wins,
 * leaving upload/cleanup headroom inside the unchanged 120-minute job timeout.
 * The suite must never preempt its own composed allowed waits, even without CI.
 */
export function modelMatrixSuiteTimeoutMs(executionMs: number): number {
  return MODEL_MATRIX_PLAN_BUDGET_MS + 2 * modelPhaseBudgetMs(executionMs)
    + 2 * MODEL_MATRIX_FOLLOWUP_BUDGET_MS + 6 * PLAN_SUITE_CLEANUP_MS;
}

/** Resolve the live model-task polling budget while always retaining a finite fallback. */
export function parseModelTaskTimeoutMs(
  raw: string | undefined,
  fallback = DEFAULT_MODEL_TASK_TIMEOUT_MS,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
