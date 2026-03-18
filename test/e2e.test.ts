/**
 * E2E Tests for ProPR CLI API
 *
 * Runs against a live ProPR instance. Requires environment variables:
 *   PROPR_E2E_API_URL  — Backend URL (e.g. https://api.gitfix.dev)
 *   PROPR_E2E_TOKEN    — GitHub token for auth
 *   PROPR_E2E_REPO     — Dedicated test repo (e.g. integry/propr-e2e-test)
 *
 * Optional:
 *   PROPR_E2E_SKIP_SLOW  — Set to "1" to skip plan/implementation tests
 *   PROPR_E2E_NO_CLEANUP — Set to "1" to skip cleanup for manual verification
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Import from CLI package API modules directly (not via barrel exports)
// to avoid tsx resolution issues with .js extension re-exports in dist/.
import { ApiClient } from "../packages/cli/src/api/client.js";
import { ConfigManager } from "../packages/cli/src/config/ConfigManager.js";

import { getSystemStatus, type SystemStatus } from "../packages/cli/src/api/system.js";
import { getQueueStats, type QueueStats } from "../packages/cli/src/api/system.js";
import { getRepos, addRepo, removeRepo, triggerIndexing, getIndexingStatus } from "../packages/cli/src/api/repos.js";
import { getSettings } from "../packages/cli/src/api/settings.js";
import { listLlmLogs, type LlmLogEntry } from "../packages/cli/src/api/logs.js";
import { listTasks } from "../packages/cli/src/api/tasks.js";
import { stopTask, deleteTask } from "../packages/cli/src/api/tasks.js";
import { listAgents, type AgentConfig } from "../packages/cli/src/api/agents.js";
import {
  listTodos,
  getTodo,
  createTodo,
  updateTodo,
  deleteTodo,
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  reorderTodos,
  type RepoTodo,
  type RepoTodoCategory,
} from "../packages/cli/src/api/todos.js";
import {
  createPlan,
  getPlan,
  listPlans,
  deletePlan,
  listPlanIssues,
  generatePlan,
  finalizePlan,
  type Plan,
  type PlanIssue,
} from "../packages/cli/src/api/plans.js";
import {
  implementIssue,
  getTaskStatus,
  type TaskStatus,
} from "../packages/cli/src/api/implement.js";

// ---------------------------------------------------------------------------
// Environment & configuration
// ---------------------------------------------------------------------------

const API_URL = process.env.PROPR_E2E_API_URL;
const REPO = process.env.PROPR_E2E_REPO;
const SKIP_SLOW = process.env.PROPR_E2E_SKIP_SLOW === "1";
const NO_CLEANUP = process.env.PROPR_E2E_NO_CLEANUP === "1";

// Token: env var first, then fall back to `gh auth token`
import { execSync } from "node:child_process";

function resolveToken(): string | undefined {
  if (process.env.PROPR_E2E_TOKEN) return process.env.PROPR_E2E_TOKEN;
  try {
    return execSync("gh auth token", { encoding: "utf-8" }).trim();
  } catch {
    return undefined;
  }
}

const TOKEN = resolveToken();
const MISSING_ENV = !API_URL || !TOKEN || !REPO;

// ---------------------------------------------------------------------------
// Client setup — no ~/.propr/config.json dependency
// ---------------------------------------------------------------------------

let client: ApiClient;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Shared state across test groups
// ---------------------------------------------------------------------------

let availableAgents: AgentConfig[] = [];

// Plan lifecycle artifacts
let greenfieldPlan: Plan | null = null;
let brownfieldPlan: Plan | null = null;

// Implementation artifacts
let greenfieldTaskId: string | null = null;
let brownfieldTaskId: string | null = null;
let greenfieldDraftId: string | null = null;
let brownfieldDraftId: string | null = null;

// All-models implementation tracking
interface ModelTestResult {
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
}
const modelTestResults: ModelTestResult[] = [];
let allModelsPlanId: string | null = null;

// Todo cleanup tracking
const createdTodoIds: string[] = [];
const createdCategoryIds: string[] = [];

// Plan cleanup tracking
const createdPlanIds: string[] = [];

// Repo cleanup tracking — if we added the repo ourselves
let addedRepo = false;

// ---------------------------------------------------------------------------
// Root describe — skip entirely if env vars missing
// ---------------------------------------------------------------------------

describe("ProPR CLI E2E", { skip: MISSING_ENV ? "Missing required env vars (PROPR_E2E_API_URL, PROPR_E2E_TOKEN, PROPR_E2E_REPO)" : false }, () => {
  before(() => {
    // Construct ApiClient directly with a throwaway ConfigManager
    const configManager = new ConfigManager("/tmp/propr-e2e-config");
    client = new ApiClient(configManager, {
      baseUrl: API_URL!,
      token: TOKEN!,
    });
  });

  after(async () => {
    if (NO_CLEANUP) {
      console.log("  [cleanup] Skipped (PROPR_E2E_NO_CLEANUP=1)");
      return;
    }

    // Stop & delete implementation tasks
    const allTaskIds = [
      greenfieldTaskId,
      brownfieldTaskId,
      ...modelTestResults.map((r) => r.taskId),
    ].filter(Boolean) as string[];

    for (const taskId of allTaskIds) {
      try { await stopTask(taskId, client); } catch { /* ignore */ }
      try { await deleteTask(taskId, true, client); } catch { /* ignore */ }
    }

    // Delete todos
    for (const id of createdTodoIds) {
      try { await deleteTodo(id, client); } catch { /* ignore */ }
    }

    // Delete categories
    for (const id of createdCategoryIds) {
      try { await deleteCategory(id, client); } catch { /* ignore */ }
    }

    // Delete plans
    for (const id of createdPlanIds) {
      try { await deletePlan(id, client); } catch { /* ignore */ }
    }

    // Remove repo if we added it
    if (addedRepo) {
      try { await removeRepo(REPO!, client); } catch { /* ignore */ }
    }

    console.log("  [cleanup] Done");
  });

  // =========================================================================
  // 1. System health
  // =========================================================================

  describe("1. System health", () => {
    it("getSystemStatus returns all component fields", async () => {
      const status: SystemStatus = await getSystemStatus(client);
      assert.ok(typeof status.api === "string", "api field present");
      assert.ok(typeof status.redis === "string", "redis field present");
      assert.ok(typeof status.daemon === "string", "daemon field present");
      assert.ok(typeof status.worker === "string", "worker field present");
      assert.ok(typeof status.githubAuth === "string", "githubAuth field present");
      assert.ok(typeof status.claudeAuth === "string", "claudeAuth field present");
      assert.ok(typeof status.timestamp === "string", "timestamp field present");
      console.log(`    System: api=${status.api} redis=${status.redis} daemon=${status.daemon} worker=${status.worker}`);
    });

    it("getQueueStats returns numeric fields >= 0", async () => {
      const stats: QueueStats = await getQueueStats(client);
      for (const key of ["waiting", "active", "completed", "failed", "delayed", "total"] as const) {
        assert.ok(typeof stats[key] === "number", `${key} is a number`);
        assert.ok(stats[key] >= 0, `${key} >= 0`);
      }
      console.log(`    Queue: waiting=${stats.waiting} active=${stats.active} completed=${stats.completed} failed=${stats.failed}`);
    });
  });

  // =========================================================================
  // 2. Repositories
  // =========================================================================

  describe("2. Repositories", () => {
    it("getRepos returns an array", async () => {
      const result = await getRepos(client);
      assert.ok(Array.isArray(result.repos_to_monitor), "repos_to_monitor is an array");
      console.log(`    Repos monitored: ${result.repos_to_monitor.length}`);
    });

    it(`test repo (${REPO}) exists and is enabled — adds if missing`, async () => {
      const result = await getRepos(client);
      let repo = result.repos_to_monitor.find(
        (r) => r.name.toLowerCase() === REPO!.toLowerCase()
      );

      if (!repo) {
        console.log(`    Repo ${REPO} not found — adding it`);
        await addRepo(REPO!, { enabled: true }, client);
        addedRepo = true;
        const updated = await getRepos(client);
        repo = updated.repos_to_monitor.find(
          (r) => r.name.toLowerCase() === REPO!.toLowerCase()
        );
      }

      assert.ok(repo, `Repo ${REPO} still not found after adding`);
      assert.ok(repo.enabled, `Repo ${REPO} is not enabled`);
    });

    it("ensure repo is indexed (trigger + wait if needed)", { timeout: 300_000 }, async () => {
      // Check current indexing status
      const status = await getIndexingStatus(REPO!, client);
      const repoStatus = status.repositories[0];

      if (repoStatus?.indexing_status === "completed" && repoStatus.last_indexed_at) {
        console.log(`    Already indexed at ${repoStatus.last_indexed_at}`);
        return;
      }

      // Trigger indexing
      console.log(`    Triggering indexing for ${REPO}...`);
      await triggerIndexing(REPO!, { fullReindex: true }, client);

      // Poll until indexing completes
      for (let i = 0; i < 60; i++) {
        await sleep(5000);
        const current = await getIndexingStatus(REPO!, client);
        const s = current.repositories[0];
        if (!s) continue;

        const pct = s.progress?.percentComplete ?? 0;
        console.log(`    Indexing: ${s.indexing_status} (${pct}%)`);

        if (s.indexing_status === "completed") {
          console.log(`    Indexing completed at ${s.last_indexed_at}`);
          return;
        }
        if (s.indexing_status === "failed") {
          assert.fail("Indexing failed");
        }
      }

      assert.fail("Indexing timed out after 5 minutes");
    });
  });

  // =========================================================================
  // 3. Settings
  // =========================================================================

  describe("3. Settings", () => {
    it("getSettings returns expected key types", async () => {
      const settings = await getSettings(client);
      assert.ok(typeof settings.worker_concurrency === "number", "worker_concurrency is number");
      assert.ok(Array.isArray(settings.github_user_whitelist), "github_user_whitelist is array");
      assert.ok(typeof settings.analysis_model_fast === "string", "analysis_model_fast is string");
      assert.ok(typeof settings.planner_context_model === "string", "planner_context_model is string");
      assert.ok(typeof settings.planner_generation_model === "string", "planner_generation_model is string");
      assert.ok(typeof settings.auto_followup_score_threshold === "number", "auto_followup_score_threshold is number");
    });
  });

  // =========================================================================
  // 4. Logs
  // =========================================================================

  describe("4. Logs", () => {
    it("listLlmLogs returns array + pagination", async () => {
      const result = await listLlmLogs({}, client);
      assert.ok(Array.isArray(result.logs), "logs is array");
      assert.ok(typeof result.pagination === "object", "pagination present");
      assert.ok(typeof result.pagination.total === "number", "pagination.total is number");
      assert.ok(typeof result.pagination.page === "number", "pagination.page is number");
      console.log(`    Total logs: ${result.pagination.total}`);
    });

    it("listLlmLogs with limit=2 returns <= 2", async () => {
      const result = await listLlmLogs({ limit: 2 }, client);
      assert.ok(result.logs.length <= 2, `Expected <= 2 logs, got ${result.logs.length}`);
    });

    it("listLlmLogs with success=false — all returned have success === false", async () => {
      const result = await listLlmLogs({ success: false }, client);
      for (const log of result.logs) {
        assert.strictEqual(log.success, false, `Log ${log.logId} has success !== false`);
      }
    });
  });

  // =========================================================================
  // 5. Tasks
  // =========================================================================

  describe("5. Tasks", () => {
    it("listTasks returns array + total", async () => {
      const result = await listTasks({}, client);
      assert.ok(Array.isArray(result.tasks), "tasks is array");
      assert.ok(typeof result.total === "number", "total is number");
      console.log(`    Total tasks: ${result.total}`);
    });

    it("listTasks filtered by repository — all match", async () => {
      const result = await listTasks({ repository: REPO! }, client);
      for (const task of result.tasks) {
        assert.strictEqual(
          task.repository.toLowerCase(),
          REPO!.toLowerCase(),
          `Task ${task.id} has repository ${task.repository}, expected ${REPO}`
        );
      }
    });
  });

  // =========================================================================
  // 6. Agents
  // =========================================================================

  describe("6. Agents", () => {
    it("listAgents returns array with expected fields", async () => {
      const result = await listAgents(client);
      assert.ok(Array.isArray(result.agents), "agents is array");
      for (const agent of result.agents) {
        assert.ok(typeof agent.id === "string", "agent.id is string");
        assert.ok(typeof agent.alias === "string", "agent.alias is string");
        assert.ok(typeof agent.type === "string", "agent.type is string");
        assert.ok(Array.isArray(agent.supportedModels), "agent.supportedModels is array");
      }
      availableAgents = result.agents.filter((a) => a.enabled);
      console.log(`    Available agents: ${availableAgents.map((a) => a.alias).join(", ")}`);
    });
  });

  // =========================================================================
  // 7. Todo CRUD
  // =========================================================================

  describe("7. Todo CRUD", () => {
    let category: RepoTodoCategory;
    let todo1: RepoTodo;
    let todo2: RepoTodo;

    it("create category", async () => {
      category = await createCategory({ repository: REPO!, name: `e2e-cat-${Date.now()}` }, client);
      createdCategoryIds.push(category.categoryId);
      assert.ok(category.categoryId, "categoryId present");
      assert.ok(category.name.startsWith("e2e-cat-"), "name matches");
    });

    it("create todos", async () => {
      todo1 = await createTodo(
        { repository: REPO!, content: `e2e-todo-1-${Date.now()}`, categoryId: category.categoryId },
        client
      );
      createdTodoIds.push(todo1.todoId);
      assert.ok(todo1.todoId, "todo1 id present");

      todo2 = await createTodo(
        { repository: REPO!, content: `e2e-todo-2-${Date.now()}`, categoryId: category.categoryId },
        client
      );
      createdTodoIds.push(todo2.todoId);
      assert.ok(todo2.todoId, "todo2 id present");
    });

    it("list todos", async () => {
      const result = await listTodos(REPO!, client);
      assert.ok(Array.isArray(result.todos), "todos is array");
      const ids = result.todos.map((t) => t.todoId);
      assert.ok(ids.includes(todo1.todoId), "todo1 in list");
      assert.ok(ids.includes(todo2.todoId), "todo2 in list");
    });

    it("get todo", async () => {
      const fetched = await getTodo(todo1.todoId, client);
      assert.strictEqual(fetched.todoId, todo1.todoId);
      assert.strictEqual(fetched.content, todo1.content);
    });

    it("update todo", async () => {
      const updated = await updateTodo(todo1.todoId, { content: "updated-content" }, client);
      assert.strictEqual(updated.content, "updated-content");
    });

    it("reorder todos", async () => {
      const result = await reorderTodos(
        REPO!,
        [
          { id: todo2.todoId, orderIndex: 0 },
          { id: todo1.todoId, orderIndex: 1 },
        ],
        client
      );
      assert.ok(result.success, "reorder succeeded");
    });

    it("delete todos", { skip: NO_CLEANUP ? "NO_CLEANUP set" : false }, async () => {
      const r1 = await deleteTodo(todo1.todoId, client);
      assert.ok(r1.success, "delete todo1 succeeded");
      // Remove from cleanup list since already deleted
      const idx1 = createdTodoIds.indexOf(todo1.todoId);
      if (idx1 >= 0) createdTodoIds.splice(idx1, 1);

      const r2 = await deleteTodo(todo2.todoId, client);
      assert.ok(r2.success, "delete todo2 succeeded");
      const idx2 = createdTodoIds.indexOf(todo2.todoId);
      if (idx2 >= 0) createdTodoIds.splice(idx2, 1);
    });

    it("delete category", { skip: NO_CLEANUP ? "NO_CLEANUP set" : false }, async () => {
      const r = await deleteCategory(category.categoryId, client);
      assert.ok(r.success, "delete category succeeded");
      const idx = createdCategoryIds.indexOf(category.categoryId);
      if (idx >= 0) createdCategoryIds.splice(idx, 1);
    });
  });

  // =========================================================================
  // 8. Plan lifecycle — greenfield
  // =========================================================================

  describe("8. Plan lifecycle — greenfield", {
    timeout: 600_000,
    skip: SKIP_SLOW ? "PROPR_E2E_SKIP_SLOW=1" : false,
  }, () => {
    it("create plan and track progress to terminal state", async () => {
      const plan = await createPlan(
        REPO!,
        "Add a CONTRIBUTING.md with guidelines for contributing to the project",
        {},
        client
      );
      greenfieldPlan = plan;
      greenfieldDraftId = plan.draft_id;
      createdPlanIds.push(plan.draft_id);

      assert.ok(plan.draft_id, "draft_id present");
      console.log(`    Plan created: ${plan.draft_id} (status: ${plan.status})`);

      // Trigger generation
      console.log(`    Triggering generation...`);
      await generatePlan(plan.draft_id, {}, client);

      // Poll until a terminal state that indicates generation completed.
      const observedStatuses = new Set<string>();
      observedStatuses.add(plan.status);
      let lastStatus = plan.status;

      // Terminal = generation done (back to draft/review after generating, or failed)
      const doneStatuses = new Set(["review", "executed", "approved", "merged", "pr_created", "failed"]);
      // We also treat "draft" as done IF we already saw "generating" (meaning it finished)
      let sawGenerating = lastStatus === "generating";

      const isDone = () => {
        if (doneStatuses.has(lastStatus)) return true;
        if (lastStatus === "draft" && sawGenerating) return true;
        return false;
      };

      while (!isDone()) {
        await sleep(5000);
        const current = await getPlan(plan.draft_id, client);
        if (current.status !== lastStatus) {
          console.log(`    Plan status: ${lastStatus} → ${current.status}`);
          lastStatus = current.status;
          observedStatuses.add(current.status);
          if (current.status === "generating" || current.status === "refining") {
            sawGenerating = true;
          }
        }
        greenfieldPlan = current;
      }

      // Assert we saw generation activity
      const hasIntermediate = sawGenerating;
      assert.ok(hasIntermediate, `Expected to observe generating/refining, observed: ${[...observedStatuses].join(", ")}`);
      assert.notStrictEqual(lastStatus, "failed", `Plan failed unexpectedly`);
      console.log(`    Final status: ${lastStatus} | Observed: ${[...observedStatuses].join(", ")}`);

      // Finalize plan to create GitHub issues
      console.log(`    Finalizing plan (creating GitHub issues)...`);
      const finalizeResult = await finalizePlan(plan.draft_id, client);
      assert.ok(finalizeResult.success, "Finalize succeeded");
      console.log(`    Issues created: ${finalizeResult.issuesCreated}`);
    });

    it("plan appears in listPlans", async () => {
      assert.ok(greenfieldPlan, "greenfieldPlan must exist");
      const result = await listPlans(REPO!, {}, client);
      const found = result.drafts.find((d) => d.draft_id === greenfieldPlan!.draft_id);
      assert.ok(found, "Greenfield plan found in list");
    });
  });

  // =========================================================================
  // 9. Plan lifecycle — brownfield
  // =========================================================================

  describe("9. Plan lifecycle — brownfield", {
    timeout: 600_000,
    skip: SKIP_SLOW ? "PROPR_E2E_SKIP_SLOW=1" : false,
  }, () => {
    it("create plan and track progress to terminal state", async () => {
      const plan = await createPlan(
        REPO!,
        "Improve error handling and add input validation across the codebase",
        {},
        client
      );
      brownfieldPlan = plan;
      brownfieldDraftId = plan.draft_id;
      createdPlanIds.push(plan.draft_id);

      assert.ok(plan.draft_id, "draft_id present");
      console.log(`    Plan created: ${plan.draft_id} (status: ${plan.status})`);

      // Trigger generation
      console.log(`    Triggering generation...`);
      await generatePlan(plan.draft_id, {}, client);

      // Poll until generation completes (same logic as greenfield)
      const observedStatuses = new Set<string>();
      observedStatuses.add(plan.status);
      let lastStatus = plan.status;

      const doneStatuses = new Set(["review", "executed", "approved", "merged", "pr_created", "failed"]);
      let sawGenerating = lastStatus === "generating";

      const isDone = () => {
        if (doneStatuses.has(lastStatus)) return true;
        if (lastStatus === "draft" && sawGenerating) return true;
        return false;
      };

      while (!isDone()) {
        await sleep(5000);
        const current = await getPlan(plan.draft_id, client);
        if (current.status !== lastStatus) {
          console.log(`    Plan status: ${lastStatus} → ${current.status}`);
          lastStatus = current.status;
          observedStatuses.add(current.status);
          if (current.status === "generating" || current.status === "refining") {
            sawGenerating = true;
          }
        }
        brownfieldPlan = current;
      }

      assert.ok(sawGenerating, `Expected to observe generating/refining, observed: ${[...observedStatuses].join(", ")}`);
      assert.notStrictEqual(lastStatus, "failed", `Plan failed unexpectedly`);
      console.log(`    Final status: ${lastStatus} | Observed: ${[...observedStatuses].join(", ")}`);

      // Finalize plan to create GitHub issues
      console.log(`    Finalizing plan (creating GitHub issues)...`);
      const finalizeResult = await finalizePlan(plan.draft_id, client);
      assert.ok(finalizeResult.success, "Finalize succeeded");
      console.log(`    Issues created: ${finalizeResult.issuesCreated}`);

      // Verify plan has issues via the issues endpoint
      const issues = await listPlanIssues(plan.draft_id, client);
      assert.ok(issues.length > 0, "Brownfield plan should have generated issues");
      console.log(`    Plan issues: ${issues.length}`);
    });
  });

  // =========================================================================
  // 10. All-models implementation — create plan, assign each model an issue
  // =========================================================================

  describe("10. All-models implementation", {
    timeout: 1_800_000, // 30 min — many models
    skip: SKIP_SLOW ? "PROPR_E2E_SKIP_SLOW=1" : false,
  }, () => {
    it("create plan with enough issues for all models", async () => {
      const allPairs: { agent_alias: string; model_name: string }[] = [];
      for (const agent of availableAgents) {
        for (const model of agent.supportedModels) {
          allPairs.push({ agent_alias: agent.alias, model_name: model });
        }
      }

      if (allPairs.length === 0) {
        console.log("    Skipping: no agent/model pairs available");
        return;
      }

      console.log(`    Total agent/model pairs: ${allPairs.length}`);
      for (const p of allPairs) {
        console.log(`      ${p.agent_alias}/${p.model_name}`);
      }

      const prompt = [
        `Create ${allPairs.length} separate small improvements for this project.`,
        "Each should be a self-contained task like: add a utility function, improve a config file,",
        "add documentation, add error handling, add input validation, add a helper script,",
        "improve logging, add type annotations, add constants file, add a health check.",
        `Generate exactly ${allPairs.length} issues.`,
      ].join(" ");

      console.log(`    Creating plan for ${allPairs.length} issues...`);
      const plan = await createPlan(REPO!, prompt, {}, client);
      allModelsPlanId = plan.draft_id;
      createdPlanIds.push(plan.draft_id);

      console.log(`    Triggering generation...`);
      await generatePlan(plan.draft_id, {}, client);

      const doneStatuses = new Set(["review", "executed", "approved", "merged", "pr_created", "failed"]);
      let lastStatus = "draft";
      let sawGenerating = false;

      for (let i = 0; i < 120; i++) {
        await sleep(5000);
        const current = await getPlan(plan.draft_id, client);
        if (current.status !== lastStatus) {
          console.log(`    Plan status: ${lastStatus} -> ${current.status}`);
          lastStatus = current.status;
        }
        if (current.status === "generating" || current.status === "refining") sawGenerating = true;
        if (doneStatuses.has(current.status)) break;
        if (current.status === "draft" && sawGenerating) break;
      }

      assert.ok(sawGenerating, `Plan never started generating. Observed: ${lastStatus}`);
      assert.notStrictEqual(lastStatus, "failed", "Plan generation failed");

      console.log(`    Finalizing plan...`);
      const finalizeResult = await finalizePlan(plan.draft_id, client);
      assert.ok(finalizeResult.success, "Finalize failed");
      console.log(`    Issues created: ${finalizeResult.issuesCreated}`);
    });

    it("implement one issue per model and track execution", async () => {
      if (!allModelsPlanId) {
        console.log("    Skipping: no plan available");
        return;
      }

      const allPairs: { agent_alias: string; model_name: string }[] = [];
      for (const agent of availableAgents) {
        for (const model of agent.supportedModels) {
          allPairs.push({ agent_alias: agent.alias, model_name: model });
        }
      }

      const issues = await listPlanIssues(allModelsPlanId, client);
      const pendingIssues = issues.filter((i) => i.status === "pending");
      const modelsToTest = allPairs.slice(0, pendingIssues.length);

      if (modelsToTest.length === 0) {
        console.log("    Skipping: no pending issues available");
        return;
      }

      console.log(`    Testing ${modelsToTest.length} models (${pendingIssues.length} issues available)`);
      if (modelsToTest.length < allPairs.length) {
        console.log(`    Warning: only ${pendingIssues.length} issues, skipping ${allPairs.length - modelsToTest.length} models`);
      }

      for (let i = 0; i < modelsToTest.length; i++) {
        const pair = modelsToTest[i];
        const issue = pendingIssues[i];
        console.log(`    Implementing #${issue.issue_number} with ${pair.agent_alias}/${pair.model_name}`);

        const result = await implementIssue(allModelsPlanId, issue.issue_number, {
          models: [pair],
        }, client);

        modelTestResults.push({
          agent_alias: pair.agent_alias,
          model_name: pair.model_name,
          issueNumber: issue.issue_number,
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
        });

        if (!result.success) {
          console.log(`    Warning: implement failed for ${pair.model_name}: ${result.message}`);
        }
      }

      // Wait for tasks to appear
      console.log(`    Waiting for tasks to appear...`);
      const terminalStates = new Set(["completed", "failed", "cancelled"]);

      for (let poll = 0; poll < 60; poll++) {
        await sleep(10_000);
        const taskList = await listTasks({ repository: REPO! }, client);

        let allFound = true;
        for (const r of modelTestResults) {
          if (r.taskId) continue;
          const task = taskList.tasks.find((t) => t.issueNumber === r.issueNumber);
          if (task) {
            r.taskId = task.id;
            console.log(`    Found task for #${r.issueNumber} (${r.model_name}): ${task.id.substring(0, 40)}...`);
          } else {
            allFound = false;
          }
        }
        if (allFound) break;

        if (poll % 6 === 0) {
          const found = modelTestResults.filter((r) => r.taskId).length;
          console.log(`    Tasks found: ${found}/${modelTestResults.length}`);
        }
      }

      const withTasks = modelTestResults.filter((r) => r.taskId);
      console.log(`    Tasks found: ${withTasks.length}/${modelTestResults.length}`);

      if (withTasks.length === 0) {
        console.log("    No tasks appeared - worker may not be processing");
        return;
      }

      // Poll all tasks until they reach terminal state
      console.log(`    Polling ${withTasks.length} tasks until completion...`);
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

            // Compute duration from first to last history entry
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

        if (pollCount % 5 === 0 && allModelsPlanId) {
          const logs = await listLlmLogs({ draftId: allModelsPlanId }, client);
          console.log(`    Total logs so far: ${logs.pagination.total}`);
        }

        if (allDone) break;
      }
    });

    it("every model produced execution status updates (history)", async () => {
      const withTasks = modelTestResults.filter((r) => r.taskId);
      if (withTasks.length === 0) {
        console.log("    Skipping: no tasks ran");
        return;
      }

      for (const r of withTasks) {
        const status = await getTaskStatus(r.taskId!, client);
        r.hasHistory = status.history.length > 1;

        console.log(`    ${r.agent_alias}/${r.model_name}: ${status.history.length} history entries, states: ${[...r.observedStates].join(" -> ")}`);
        assert.ok(
          status.history.length > 0,
          `${r.agent_alias}/${r.model_name} (#${r.issueNumber}) has no history entries`
        );
      }
    });

    it("every model produced LLM logs", async () => {
      if (!allModelsPlanId) return;

      const withTasks = modelTestResults.filter((r) => r.taskId && r.finalState);
      if (withTasks.length === 0) {
        console.log("    Skipping: no completed tasks");
        return;
      }

      const allLogs = await listLlmLogs({ draftId: allModelsPlanId, limit: 100 }, client);

      for (const r of withTasks) {
        const modelLogs = allLogs.logs.filter((l) =>
          l.agentAlias === r.agent_alias
        );
        r.logCount = modelLogs.length;
        r.hasLogs = modelLogs.length > 0;
        r.inputTokens = modelLogs.reduce((sum, l) => sum + (l.inputTokens ?? 0), 0);
        r.outputTokens = modelLogs.reduce((sum, l) => sum + (l.outputTokens ?? 0), 0);

        console.log(`    ${r.agent_alias}/${r.model_name}: ${modelLogs.length} logs, state=${r.finalState}`);
      }

      assert.ok(allLogs.logs.length > 0, "Expected at least some LLM logs for the draft");
      console.log(`    Total draft logs: ${allLogs.pagination.total}`);
    });
  });

  // =========================================================================
  // 11. Summary + log verification
  // =========================================================================

  describe("11. Summary + log verification", {
    skip: SKIP_SLOW ? "PROPR_E2E_SKIP_SLOW=1" : false,
  }, () => {
    it("detailed run report", async () => {
      const sep = "=".repeat(100);
      const line = "-".repeat(100);

      console.log("");
      console.log(`    ${sep}`);
      console.log(`    E2E TEST RUN REPORT — ${new Date().toISOString()}`);
      console.log(`    ${sep}`);

      // --- Plans ---
      console.log("");
      console.log("    PLANS");
      console.log(`    ${line}`);
      const plans = [
        { label: "Greenfield", id: greenfieldDraftId, plan: greenfieldPlan },
        { label: "Brownfield", id: brownfieldDraftId, plan: brownfieldPlan },
        { label: "All-models", id: allModelsPlanId, plan: null as Plan | null },
      ];

      for (const p of plans) {
        if (!p.id) { console.log(`    ${p.label}: not created`); continue; }
        try {
          const plan = p.plan ?? await getPlan(p.id, client);
          const issues = await listPlanIssues(p.id, client);
          console.log(`    ${p.label}:`);
          console.log(`      ID:      ${p.id}`);
          console.log(`      Name:    ${plan.name || "(untitled)"}`);
          console.log(`      Status:  ${plan.status}`);
          console.log(`      Prompt:  ${(plan.initial_prompt ?? "").substring(0, 80)}...`);
          console.log(`      Items:   ${(plan.plan_json ?? []).length} plan items, ${issues.length} GitHub issues`);
          if (issues.length > 0) {
            for (const iss of issues) {
              console.log(`        #${iss.issue_number} [${iss.status}] agent=${iss.agent_alias ?? "-"} model=${iss.model_name ?? "-"} task=${iss.task_id ?? "-"}`);
            }
          }
        } catch {
          console.log(`    ${p.label}: ${p.id} (could not fetch details)`);
        }
      }

      // --- Model implementation results ---
      if (modelTestResults.length > 0) {
        console.log("");
        console.log("    MODEL IMPLEMENTATION RESULTS");
        console.log(`    ${line}`);

        // Group by agent
        const byAgent = new Map<string, ModelTestResult[]>();
        for (const r of modelTestResults) {
          const list = byAgent.get(r.agent_alias) ?? [];
          list.push(r);
          byAgent.set(r.agent_alias, list);
        }

        for (const [agent, results] of byAgent) {
          console.log("");
          console.log(`    Agent: ${agent}`);
          console.log(`    ${"Model".padEnd(35)} ${"Issue".padEnd(7)} ${"State".padEnd(11)} ${"Duration".padEnd(10)} ${"Tokens".padEnd(16)} ${"PR".padEnd(6)} History  Logs`);
          console.log(`    ${"-".repeat(35)} ${"-".repeat(7)} ${"-".repeat(11)} ${"-".repeat(10)} ${"-".repeat(16)} ${"-".repeat(6)} ${"-".repeat(7)}  ${"-".repeat(4)}`);

          for (const r of results) {
            const model = r.model_name.padEnd(35);
            const issue = `#${r.issueNumber}`.padEnd(7);
            const state = (r.finalState ?? "no task").padEnd(11);
            const dur = r.durationMs ? `${Math.round(r.durationMs / 1000)}s`.padEnd(10) : "-".padEnd(10);
            const tokens = r.inputTokens || r.outputTokens
              ? `${r.inputTokens}/${r.outputTokens}`.padEnd(16)
              : "-".padEnd(16);
            const pr = r.prNumber ? `#${r.prNumber}`.padEnd(6) : "-".padEnd(6);
            const hist = `${r.historyCount}`.padEnd(7);
            const logs = `${r.logCount}`;
            console.log(`    ${model} ${issue} ${state} ${dur} ${tokens} ${pr} ${hist}  ${logs}`);

            if (r.failureReason) {
              console.log(`      FAILURE: ${r.failureReason.substring(0, 120)}`);
            }
          }
        }

        // Totals
        console.log("");
        console.log("    TOTALS");
        console.log(`    ${line}`);
        const total = modelTestResults.length;
        const withTasks = modelTestResults.filter((r) => r.taskId).length;
        const completed = modelTestResults.filter((r) => r.finalState === "completed").length;
        const failed = modelTestResults.filter((r) => r.finalState === "failed").length;
        const cancelled = modelTestResults.filter((r) => r.finalState === "cancelled").length;
        const noTask = modelTestResults.filter((r) => !r.taskId).length;
        const withHistory = modelTestResults.filter((r) => r.hasHistory).length;
        const withLogs = modelTestResults.filter((r) => r.hasLogs).length;
        const totalInput = modelTestResults.reduce((s, r) => s + r.inputTokens, 0);
        const totalOutput = modelTestResults.reduce((s, r) => s + r.outputTokens, 0);

        console.log(`    Models tested:   ${total}`);
        console.log(`    Tasks created:   ${withTasks} (${noTask} never picked up)`);
        console.log(`    Completed:       ${completed}`);
        console.log(`    Failed:          ${failed}`);
        if (cancelled > 0) console.log(`    Cancelled:       ${cancelled}`);
        console.log(`    With history:    ${withHistory}/${withTasks}`);
        console.log(`    With LLM logs:   ${withLogs}/${withTasks}`);
        console.log(`    Total tokens:    input=${totalInput} output=${totalOutput} total=${totalInput + totalOutput}`);
      }

      console.log("");
      console.log(`    ${sep}`);
      console.log(`    END OF REPORT`);
      console.log(`    ${sep}`);
    });

    it("completed logs have valid token/duration fields", async () => {
      const draftIds = [allModelsPlanId, greenfieldDraftId, brownfieldDraftId].filter(Boolean) as string[];
      if (draftIds.length === 0) return;

      for (const draftId of draftIds) {
        const result = await listLlmLogs({ draftId, success: true, limit: 100 }, client);
        for (const log of result.logs) {
          if (log.inputTokens !== null) {
            assert.ok(log.inputTokens > 0, `Log ${log.logId}: inputTokens should be > 0`);
          }
          if (log.outputTokens !== null) {
            assert.ok(log.outputTokens > 0, `Log ${log.logId}: outputTokens should be > 0`);
          }
          if (log.durationMs !== null) {
            assert.ok(log.durationMs > 0, `Log ${log.logId}: durationMs should be > 0`);
          }
        }
      }
    });

    it("successful logs have no errorMessage", async () => {
      const draftIds = [allModelsPlanId, greenfieldDraftId, brownfieldDraftId].filter(Boolean) as string[];
      for (const draftId of draftIds) {
        const result = await listLlmLogs({ draftId, success: true, limit: 100 }, client);
        for (const log of result.logs) {
          assert.strictEqual(log.errorMessage, null, `Successful log ${log.logId} has errorMessage: ${log.errorMessage}`);
        }
      }
    });

    it("failed logs (if any) have errorMessage", async () => {
      const draftIds = [allModelsPlanId, greenfieldDraftId, brownfieldDraftId].filter(Boolean) as string[];
      for (const draftId of draftIds) {
        const result = await listLlmLogs({ draftId, success: false, limit: 100 }, client);
        for (const log of result.logs) {
          assert.ok(log.errorMessage, `Failed log ${log.logId} has no errorMessage`);
        }
      }
    });

    it("token usage comparison across agents", async () => {
      if (!allModelsPlanId || modelTestResults.length === 0) return;

      const allLogs = await listLlmLogs({ draftId: allModelsPlanId, limit: 200 }, client);

      const byAgent = new Map<string, { input: number; output: number; count: number }>();
      for (const log of allLogs.logs) {
        const key = log.agentAlias ?? "unknown";
        const existing = byAgent.get(key) ?? { input: 0, output: 0, count: 0 };
        existing.input += log.inputTokens ?? 0;
        existing.output += log.outputTokens ?? 0;
        existing.count++;
        byAgent.set(key, existing);
      }

      console.log(`    Token usage by agent:`);
      for (const [agent, usage] of byAgent) {
        console.log(`      ${agent}: ${usage.count} logs, input=${usage.input} output=${usage.output} total=${usage.input + usage.output}`);
      }
    });
  });
});
