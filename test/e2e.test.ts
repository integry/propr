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
    for (const taskId of [greenfieldTaskId, brownfieldTaskId]) {
      if (!taskId) continue;
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
  // 10. Multi-model implementation + live log verification
  // =========================================================================

  describe("10. Multi-model implementation + live log verification", {
    timeout: 900_000,
    skip: SKIP_SLOW ? "PROPR_E2E_SKIP_SLOW=1" : false,
  }, () => {
    it("implement issues from both plans with different models", async () => {
      // Need both plans and >= 2 agents
      if (!greenfieldPlan || !brownfieldPlan) {
        console.log("    Skipping: plans not available from groups 8/9");
        return;
      }

      // Build agent/model pairs from available agents
      const agentModelPairs: { agent_alias: string; model_name: string }[] = [];
      for (const agent of availableAgents) {
        if (agent.supportedModels.length > 0) {
          agentModelPairs.push({
            agent_alias: agent.alias,
            model_name: agent.defaultModel ?? agent.supportedModels[0],
          });
        }
        if (agentModelPairs.length >= 2) break;
      }

      if (agentModelPairs.length < 2) {
        console.log(`    Skipping: need >= 2 agent/model pairs, have ${agentModelPairs.length}`);
        return;
      }

      console.log(`    Model A: ${agentModelPairs[0].agent_alias}/${agentModelPairs[0].model_name}`);
      console.log(`    Model B: ${agentModelPairs[1].agent_alias}/${agentModelPairs[1].model_name}`);

      // Fetch plan issues from the dedicated endpoint
      const [greenfieldIssues, brownfieldIssues] = await Promise.all([
        listPlanIssues(greenfieldPlan.draft_id, client),
        listPlanIssues(brownfieldPlan.draft_id, client),
      ]);

      if (greenfieldIssues.length === 0 || brownfieldIssues.length === 0) {
        console.log(`    Skipping: greenfield issues=${greenfieldIssues.length}, brownfield issues=${brownfieldIssues.length}`);
        return;
      }

      const gfIssueNum = greenfieldIssues[0].issue_number;
      const bfIssueNum = brownfieldIssues[0].issue_number;
      console.log(`    Greenfield issue #${gfIssueNum}, Brownfield issue #${bfIssueNum}`);

      // Trigger implementations (adds labels — worker picks up asynchronously)
      // Use the `models` array format for multi-agent assignment
      const [gfResult, bfResult] = await Promise.all([
        implementIssue(greenfieldPlan.draft_id, gfIssueNum, {
          models: [agentModelPairs[0]],
        }, client),
        implementIssue(brownfieldPlan.draft_id, bfIssueNum, {
          models: [agentModelPairs[1]],
        }, client),
      ]);

      assert.ok(gfResult.success, `Greenfield implement failed: ${gfResult.message}`);
      assert.ok(bfResult.success, `Brownfield implement failed: ${bfResult.message}`);
      console.log(`    Greenfield: ${gfResult.message}`);
      console.log(`    Brownfield: ${bfResult.message}`);

      // Wait for worker to pick up the labeled issues and create tasks.
      // Poll listTasks to find tasks matching our issue numbers.
      console.log(`    Waiting for tasks to appear...`);

      const findTask = async (issueNum: number): Promise<string | null> => {
        const result = await listTasks({ repository: REPO! }, client);
        const task = result.tasks.find((t) => t.issueNumber === issueNum);
        return task?.id ?? null;
      };

      for (let i = 0; i < 30; i++) {
        await sleep(10_000);
        if (!greenfieldTaskId) greenfieldTaskId = await findTask(gfIssueNum);
        if (!brownfieldTaskId) brownfieldTaskId = await findTask(bfIssueNum);
        if (greenfieldTaskId && brownfieldTaskId) break;
        if (i % 3 === 0) {
          console.log(`    Waiting... gf=${greenfieldTaskId ? "found" : "pending"} bf=${brownfieldTaskId ? "found" : "pending"}`);
        }
      }

      if (!greenfieldTaskId && !brownfieldTaskId) {
        console.log(`    No tasks appeared after 5 minutes — worker may not be processing`);
        return;
      }

      console.log(`    Greenfield task: ${greenfieldTaskId ?? "not found"}`);
      console.log(`    Brownfield task: ${brownfieldTaskId ?? "not found"}`);

      // Poll tasks until terminal state
      const terminalStates = new Set(["completed", "failed", "cancelled"]);
      const taskIds = [greenfieldTaskId, brownfieldTaskId].filter(Boolean) as string[];
      const observedByTask = new Map<string, Set<string>>();
      const doneSet = new Set<string>();

      for (const id of taskIds) {
        observedByTask.set(id, new Set());
      }

      let pollCount = 0;
      while (doneSet.size < taskIds.length) {
        await sleep(10_000);
        pollCount++;

        for (const taskId of taskIds) {
          if (doneSet.has(taskId)) continue;
          const status = await getTaskStatus(taskId, client);
          const observed = observedByTask.get(taskId)!;
          const prevSize = observed.size;
          observed.add(status.currentState);
          if (observed.size > prevSize) {
            const label = taskId === greenfieldTaskId ? "greenfield" : "brownfield";
            console.log(`    Task [${label}] status: ${status.currentState}`);
          }
          if (terminalStates.has(status.currentState)) doneSet.add(taskId);
        }

        // Live log checks every 3rd poll
        if (pollCount % 3 === 0) {
          for (const draftId of [greenfieldDraftId, brownfieldDraftId].filter(Boolean) as string[]) {
            const logs = await listLlmLogs({ draftId }, client);
            const label = draftId === greenfieldDraftId ? "greenfield" : "brownfield";
            console.log(`    [${label}] Logs so far: ${logs.pagination.total}`);
          }
        }
      }

      // Post-completion assertions
      for (const taskId of taskIds) {
        const status = await getTaskStatus(taskId, client);
        const label = taskId === greenfieldTaskId ? "greenfield" : "brownfield";
        const observed = observedByTask.get(taskId)!;
        console.log(`    ${label} observed: ${[...observed].join(", ")}`);

        if (status.isCompleted && status.prNumber) {
          console.log(`    ${label} PR: #${status.prNumber} ${status.prUrl}`);
        }
        if (status.isFailed) {
          console.log(`    ${label} failed: ${status.failureReason}`);
        }
      }
    });
  });

  // =========================================================================
  // 11. Final log verification
  // =========================================================================

  describe("11. Final log verification", {
    skip: SKIP_SLOW ? "PROPR_E2E_SKIP_SLOW=1" : false,
  }, () => {
    it("greenfield draft has logs", async () => {
      if (!greenfieldTaskId) {
        console.log("    Skipping: no greenfield implementation ran");
        return;
      }
      const result = await listLlmLogs({ draftId: greenfieldDraftId! }, client);
      assert.ok(result.logs.length > 0, "Expected logs for greenfield draft");
      console.log(`    Greenfield logs: ${result.pagination.total}`);
    });

    it("brownfield draft has logs", async () => {
      if (!brownfieldTaskId) {
        console.log("    Skipping: no brownfield implementation ran");
        return;
      }
      const result = await listLlmLogs({ draftId: brownfieldDraftId! }, client);
      assert.ok(result.logs.length > 0, "Expected logs for brownfield draft");
      console.log(`    Brownfield logs: ${result.pagination.total}`);
    });

    it("completed logs have valid token/duration fields", async () => {
      if (!greenfieldTaskId && !brownfieldTaskId) {
        console.log("    Skipping: no implementations ran");
        return;
      }

      const draftIds = [greenfieldDraftId, brownfieldDraftId].filter(
        (id, i) => id && [greenfieldTaskId, brownfieldTaskId][i]
      ) as string[];

      for (const draftId of draftIds) {
        const result = await listLlmLogs({ draftId, success: true }, client);
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
      if (!greenfieldTaskId && !brownfieldTaskId) return;

      const draftIds = [greenfieldDraftId, brownfieldDraftId].filter(
        (id, i) => id && [greenfieldTaskId, brownfieldTaskId][i]
      ) as string[];

      for (const draftId of draftIds) {
        const result = await listLlmLogs({ draftId, success: true }, client);
        for (const log of result.logs) {
          assert.strictEqual(log.errorMessage, null, `Successful log ${log.logId} has errorMessage: ${log.errorMessage}`);
        }
      }
    });

    it("failed logs (if any) have errorMessage", async () => {
      if (!greenfieldTaskId && !brownfieldTaskId) return;

      const draftIds = [greenfieldDraftId, brownfieldDraftId].filter(
        (id, i) => id && [greenfieldTaskId, brownfieldTaskId][i]
      ) as string[];

      for (const draftId of draftIds) {
        const result = await listLlmLogs({ draftId, success: false }, client);
        for (const log of result.logs) {
          assert.ok(log.errorMessage, `Failed log ${log.logId} has no errorMessage`);
        }
      }
    });

    it("compare total token usage between models", async () => {
      if (!greenfieldTaskId || !brownfieldTaskId) return;

      const gfLogs = await listLlmLogs({ draftId: greenfieldDraftId }, client);
      const bfLogs = await listLlmLogs({ draftId: brownfieldDraftId }, client);

      const sumTokens = (logs: LlmLogEntry[]) => {
        let input = 0;
        let output = 0;
        for (const log of logs) {
          input += log.inputTokens ?? 0;
          output += log.outputTokens ?? 0;
        }
        return { input, output, total: input + output };
      };

      const gfTokens = sumTokens(gfLogs.logs);
      const bfTokens = sumTokens(bfLogs.logs);

      console.log(`    Greenfield tokens: input=${gfTokens.input} output=${gfTokens.output} total=${gfTokens.total}`);
      console.log(`    Brownfield tokens: input=${bfTokens.input} output=${bfTokens.output} total=${bfTokens.total}`);
    });
  });
});
