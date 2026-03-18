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

  if (!sawGenerating || lastStatus === "failed") {
    return { planId: plan.draft_id, issues: [] };
  }

  await finalizePlan(plan.draft_id, client);
  const issues = await listPlanIssues(plan.draft_id, client);
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
          // When multiple models implement the same issue, match by model name in task ID
          (!results.some((o) => o !== r && o.taskId === null && o.issueNumber === r.issueNumber) ||
            t.id.includes(r.model_name.split("-")[0])),
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
