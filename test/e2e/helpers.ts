/**
 * E2E test helpers — shared types, client construction, polling utilities.
 */

import { execSync } from "node:child_process";
import { ApiClient } from "../../packages/cli/src/api/client.js";
import { ConfigManager } from "../../packages/cli/src/config/ConfigManager.js";
import { listTasks } from "../../packages/cli/src/api/tasks.js";
import { getTaskStatus, type TaskStatus } from "../../packages/cli/src/api/implement.js";
import { listLlmLogs } from "../../packages/cli/src/api/logs.js";
import {
  createPlan,
  getPlan,
  generatePlan,
  finalizePlan,
  listPlanIssues,
  type PlanIssue,
} from "../../packages/cli/src/api/plans.js";
import {
  implementAllIssues,
  type ImplementAllIssuesResponse,
} from "../../packages/cli/src/api/implement.js";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export const API_URL = process.env.PROPR_E2E_API_URL;
export const REPO = process.env.PROPR_E2E_REPO;
export const SKIP_SLOW = process.env.PROPR_E2E_SKIP_SLOW === "1";
export const NO_CLEANUP = process.env.PROPR_E2E_NO_CLEANUP === "1";

export function resolveToken(): string | undefined {
  if (process.env.PROPR_E2E_TOKEN) return process.env.PROPR_E2E_TOKEN;
  try {
    return execSync("gh auth token", { encoding: "utf-8" }).trim();
  } catch {
    return undefined;
  }
}

export const TOKEN = resolveToken();
export const MISSING_ENV = !API_URL || !TOKEN || !REPO;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export function createTestClient(): ApiClient {
  const configManager = new ConfigManager("/tmp/propr-e2e-config");
  return new ApiClient(configManager, { baseUrl: API_URL!, token: TOKEN! });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelTestResult {
  agent_alias: string;
  model_name: string;
  issueNumber: number;
  taskId: string | null;
  finalState: string | null;
  observedStates: Set<string>;
  hasHistory: boolean;
  historyCount: number;
  hasLogs: boolean;
  logCount: number;
  prNumber: number | null;
  prUrl: string | null;
  failureReason: string | null;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  testMode: string;
}

export function newModelResult(
  pair: { agent_alias: string; model_name: string },
  issueNumber: number,
  testMode: string,
): ModelTestResult {
  return {
    agent_alias: pair.agent_alias,
    model_name: pair.model_name,
    issueNumber,
    taskId: null,
    finalState: null,
    observedStates: new Set(),
    hasHistory: false,
    historyCount: 0,
    hasLogs: false,
    logCount: 0,
    prNumber: null,
    prUrl: null,
    failureReason: null,
    durationMs: null,
    inputTokens: 0,
    outputTokens: 0,
    testMode,
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface AgentModelPair {
  agent_alias: string;
  model_name: string;
}

// ---------------------------------------------------------------------------
// Plan helpers
// ---------------------------------------------------------------------------

export async function createAndGeneratePlan(
  repo: string,
  prompt: string,
  client: ApiClient,
  createdPlanIds: string[],
): Promise<{ planId: string; issues: PlanIssue[] }> {
  const plan = await createPlan(repo, prompt, {}, client);
  createdPlanIds.push(plan.draft_id);

  await generatePlan(plan.draft_id, {}, client);

  const doneStatuses = new Set(["review", "executed", "approved", "merged", "pr_created", "failed"]);
  let lastStatus = "draft";
  let sawGenerating = false;

  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    const current = await getPlan(plan.draft_id, client);
    if (current.status !== lastStatus) {
      console.log(`    Plan ${plan.draft_id.substring(0, 8)}: ${lastStatus} -> ${current.status}`);
      lastStatus = current.status;
    }
    if (current.status === "generating" || current.status === "refining") sawGenerating = true;
    if (doneStatuses.has(current.status)) break;
    if (current.status === "draft" && sawGenerating) break;
  }

  const currentPlan = await getPlan(plan.draft_id, client);
  if (!sawGenerating || currentPlan.status === "failed") {
    return { planId: plan.draft_id, issues: [] };
  }
  if (currentPlan.status !== "review") {
    console.log(`    Plan ${plan.draft_id.substring(0, 8)} not ready to finalize: ${currentPlan.status}`);
    return { planId: plan.draft_id, issues: [] };
  }

  await finalizePlan(plan.draft_id, client);
  const finalizedPlan = await getPlan(plan.draft_id, client);
  const expectedIssueCount = Array.isArray(finalizedPlan.plan_json) ? finalizedPlan.plan_json.length : 1;
  const issues = await waitForPlanIssueCondition(
    plan.draft_id,
    client,
    (currentIssues) => currentIssues.length >= Math.max(1, expectedIssueCount),
    120_000,
    3_000,
  );
  return { planId: plan.draft_id, issues };
}

// ---------------------------------------------------------------------------
// Task tracking helpers
// ---------------------------------------------------------------------------

export async function waitForTasks(
  results: ModelTestResult[],
  repo: string,
  client: ApiClient,
  timeoutPolls = 60,
): Promise<void> {
  for (let poll = 0; poll < timeoutPolls; poll++) {
    await sleep(10_000);
    const taskList = await listTasks({ repository: repo }, client);

    let allFound = true;
    for (const r of results) {
      if (r.taskId) continue;
      const task = taskList.tasks.find(
        (t) =>
          t.issueNumber === r.issueNumber &&
          (t.modelName === r.model_name || t.id.includes(r.model_name)),
      );
      if (task && !results.some((o) => o !== r && o.taskId === task.id)) {
        r.taskId = task.id;
        console.log(`    Task for #${r.issueNumber} (${r.model_name}): ${task.id.substring(0, 50)}...`);
      } else {
        allFound = false;
      }
    }
    if (allFound) break;

    if (poll % 6 === 0) {
      const found = results.filter((r) => r.taskId).length;
      console.log(`    Tasks: ${found}/${results.length}`);
    }
  }
}

export async function pollTasksToCompletion(
  results: ModelTestResult[],
  client: ApiClient,
): Promise<void> {
  const withTasks = results.filter((r) => r.taskId);
  if (withTasks.length === 0) return;

  const terminalStates = new Set(["completed", "failed", "cancelled"]);
  let pollCount = 0;

  while (true) {
    await sleep(10_000);
    pollCount++;

    let allDone = true;
    for (const r of withTasks) {
      if (r.finalState && terminalStates.has(r.finalState)) continue;
      allDone = false;

      const status = await getTaskStatus(r.taskId!, client);
      const prevSize = r.observedStates.size;
      r.observedStates.add(status.currentState);
      if (r.observedStates.size > prevSize) {
        console.log(`    [${r.agent_alias}/${r.model_name}] #${r.issueNumber}: ${status.currentState}`);
      }
      if (terminalStates.has(status.currentState)) {
        r.finalState = status.currentState;
        r.hasHistory = status.history.length > 0;
        r.historyCount = status.history.length;
        r.prNumber = status.prNumber ?? null;
        r.prUrl = status.prUrl ?? null;
        r.failureReason = status.failureReason ?? null;

        if (status.history.length >= 2) {
          const first = new Date(status.history[0].timestamp).getTime();
          const last = new Date(status.history[status.history.length - 1].timestamp).getTime();
          r.durationMs = last - first;
        }

        if (status.isCompleted && status.prNumber) {
          console.log(`    [${r.agent_alias}/${r.model_name}] PR: #${status.prNumber}`);
        }
        if (status.isFailed) {
          console.log(`    [${r.agent_alias}/${r.model_name}] FAILED: ${status.failureReason}`);
        }
      }
    }

    if (pollCount % 5 === 0) {
      const done = withTasks.filter((r) => r.finalState && terminalStates.has(r.finalState)).length;
      console.log(`    Progress: ${done}/${withTasks.length} done`);
    }

    if (allDone) break;
  }
}

// ---------------------------------------------------------------------------
// Plan issue status helpers
// ---------------------------------------------------------------------------

/**
 * In-progress statuses for plan issues.
 * Issues in these states are actively being processed.
 */
export const IN_PROGRESS_STATUSES = new Set([
  "processing",
  "under_review",
  "in_refinement",
  "refinement_processing",
]);

/**
 * Terminal statuses for plan issues.
 * Once an issue reaches these states, it is considered complete.
 */
export const TERMINAL_STATUSES = new Set(["merged", "closed"]);

/**
 * Checks if any plan issue is currently in-progress.
 */
export function hasInProgressIssue(issues: PlanIssue[]): boolean {
  return issues.some((issue) => IN_PROGRESS_STATUSES.has(issue.status));
}

/**
 * Gets counts of issues by status category.
 */
export function getIssueStatusCounts(issues: PlanIssue[]): {
  pending: number;
  inProgress: number;
  terminal: number;
  total: number;
} {
  let pending = 0;
  let inProgress = 0;
  let terminal = 0;

  for (const issue of issues) {
    if (issue.status === "pending") {
      pending++;
    } else if (IN_PROGRESS_STATUSES.has(issue.status)) {
      inProgress++;
    } else if (TERMINAL_STATUSES.has(issue.status)) {
      terminal++;
    }
  }

  return { pending, inProgress, terminal, total: issues.length };
}

/**
 * Waits for plan issues to reach expected states.
 *
 * @param draftId - The plan draft ID
 * @param client - API client
 * @param condition - Function that returns true when the condition is met
 * @param timeoutMs - Maximum time to wait (default 300s)
 * @param pollIntervalMs - Interval between polls (default 5s)
 * @returns The final list of plan issues
 */
export async function waitForPlanIssueCondition(
  draftId: string,
  client: ApiClient,
  condition: (issues: PlanIssue[]) => boolean,
  timeoutMs = 300_000,
  pollIntervalMs = 5_000,
): Promise<PlanIssue[]> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const issues = await listPlanIssues(draftId, client);
    if (condition(issues)) {
      return issues;
    }
    await sleep(pollIntervalMs);
  }

  // Return final state even if condition wasn't met
  return listPlanIssues(draftId, client);
}

/**
 * Triggers implementation with sequential processing and verifies the behavior.
 *
 * @param draftId - The plan draft ID
 * @param client - API client
 * @returns Result of implement-all with sequential processing
 */
export async function triggerSequentialImplementation(
  draftId: string,
  client: ApiClient,
): Promise<ImplementAllIssuesResponse> {
  const result = await implementAllIssues(
    draftId,
    { useEpic: true, autoMerge: true },
    client,
  );
  return result;
}
