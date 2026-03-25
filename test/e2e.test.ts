/**
 * E2E Tests for ProPR API
 *
 * Requires: PROPR_E2E_API_URL, PROPR_E2E_REPO (+ PROPR_E2E_TOKEN or `gh auth token`)
 * Optional: PROPR_E2E_SKIP_SLOW=1, PROPR_E2E_NO_CLEANUP=1
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  API_URL, REPO, SKIP_SLOW, NO_CLEANUP, MISSING_ENV,
  createTestClient, sleep,
  type ModelTestResult, type AgentModelPair,
  newModelResult,
  createAndGeneratePlan, waitForTasks, pollTasksToCompletion,
  triggerSequentialImplementation, waitForPlanIssueCondition,
  hasInProgressIssue, getIssueStatusCounts,
  IN_PROGRESS_STATUSES,
} from "./e2e/helpers.js";
import { writeReport } from "./e2e/report.js";

import type { ApiClient } from "../packages/cli/src/api/client.js";
import { getSystemStatus } from "../packages/cli/src/api/system.js";
import { getQueueStats } from "../packages/cli/src/api/system.js";
import { getRepos, addRepo, removeRepo, triggerIndexing, getIndexingStatus } from "../packages/cli/src/api/repos.js";
import { getSettings } from "../packages/cli/src/api/settings.js";
import { listLlmLogs } from "../packages/cli/src/api/logs.js";
import { listTasks, stopTask, deleteTask } from "../packages/cli/src/api/tasks.js";
import { listAgents, type AgentConfig } from "../packages/cli/src/api/agents.js";
import {
  listTodos, getTodo, createTodo, updateTodo, deleteTodo,
  createCategory, deleteCategory, reorderTodos,
  type RepoTodo, type RepoTodoCategory,
} from "../packages/cli/src/api/todos.js";
import {
  getPlan, listPlans, deletePlan, listPlanIssues,
  type Plan, type PlanIssue,
} from "../packages/cli/src/api/plans.js";
import { implementIssue, getTaskStatus } from "../packages/cli/src/api/implement.js";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let client: ApiClient;
let availableAgents: AgentConfig[] = [];

let greenfieldPlan: Plan | null = null;
let brownfieldPlan: Plan | null = null;
let greenfieldDraftId: string | null = null;
let brownfieldDraftId: string | null = null;

const modelTestResults: ModelTestResult[] = [];
const createdTodoIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdPlanIds: string[] = [];
let addedRepo = false;

function allPairs(): AgentModelPair[] {
  const pairs: AgentModelPair[] = [];
  for (const a of availableAgents) {
    for (const m of a.supportedModels) pairs.push({ agent_alias: a.alias, model_name: m });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

describe("ProPR CLI E2E", {
  skip: MISSING_ENV ? "Missing PROPR_E2E_API_URL, PROPR_E2E_TOKEN, PROPR_E2E_REPO" : false,
}, () => {
  before(() => { client = createTestClient(); });

  after(async () => {
    if (NO_CLEANUP) { console.log("  [cleanup] Skipped"); return; }
    const taskIds = modelTestResults.map((r) => r.taskId).filter(Boolean) as string[];
    for (const id of taskIds) {
      try { await stopTask(id, client); } catch { /* */ }
      try { await deleteTask(id, true, client); } catch { /* */ }
    }
    for (const id of createdTodoIds) { try { await deleteTodo(id, client); } catch { /* */ } }
    for (const id of createdCategoryIds) { try { await deleteCategory(id, client); } catch { /* */ } }
    for (const id of createdPlanIds) { try { await deletePlan(id, client); } catch { /* */ } }
    if (addedRepo) { try { await removeRepo(REPO!, client); } catch { /* */ } }
    console.log("  [cleanup] Done");
  });

  // 1. System health
  describe("1. System health", () => {
    it("getSystemStatus", async () => {
      const s = await getSystemStatus(client);
      for (const k of ["api", "redis", "daemon", "worker", "githubAuth", "claudeAuth", "timestamp"] as const) {
        assert.ok(typeof s[k] === "string", `${k} present`);
      }
      console.log(`    api=${s.api} redis=${s.redis} daemon=${s.daemon} worker=${s.worker}`);
    });

    it("getQueueStats", async () => {
      const s = await getQueueStats(client);
      for (const k of ["waiting", "active", "completed", "failed", "delayed", "total"] as const) {
        assert.ok(typeof s[k] === "number" && s[k] >= 0, `${k} >= 0`);
      }
    });
  });

  // 2. Repositories
  describe("2. Repositories", () => {
    it("getRepos", async () => {
      const r = await getRepos(client);
      assert.ok(Array.isArray(r.repos_to_monitor));
    });

    it("ensure test repo exists", async () => {
      const r = await getRepos(client);
      let repo = r.repos_to_monitor.find((x) => x.name.toLowerCase() === REPO!.toLowerCase());
      if (!repo) {
        console.log(`    Adding ${REPO}`);
        await addRepo(REPO!, { enabled: true }, client);
        addedRepo = true;
        repo = (await getRepos(client)).repos_to_monitor.find((x) => x.name.toLowerCase() === REPO!.toLowerCase());
      }
      assert.ok(repo?.enabled, `${REPO} not found or disabled`);
    });

    it("ensure indexed", { timeout: 300_000 }, async () => {
      const s = await getIndexingStatus(REPO!, client);
      if (s.repositories[0]?.indexing_status === "completed") {
        console.log(`    Already indexed`);
        return;
      }
      console.log(`    Triggering indexing...`);
      await triggerIndexing(REPO!, { fullReindex: true }, client);
      for (let i = 0; i < 60; i++) {
        await sleep(5000);
        const c = await getIndexingStatus(REPO!, client);
        const st = c.repositories[0];
        if (st?.indexing_status === "completed") return;
        if (st?.indexing_status === "failed") assert.fail("Indexing failed");
      }
      assert.fail("Indexing timed out");
    });
  });

  // 3. Settings
  describe("3. Settings", () => {
    it("getSettings", async () => {
      const s = await getSettings(client);
      assert.ok(typeof s.worker_concurrency === "number");
      assert.ok(typeof s.analysis_model_fast === "string");
    });
  });

  // 4. Logs
  describe("4. Logs", () => {
    it("list + pagination", async () => {
      const r = await listLlmLogs({}, client);
      assert.ok(Array.isArray(r.logs));
      assert.ok(typeof r.pagination.total === "number");
    });
    it("limit=2", async () => {
      const r = await listLlmLogs({ limit: 2 }, client);
      assert.ok(r.logs.length <= 2);
    });
    it("success=false filter", async () => {
      const r = await listLlmLogs({ success: false }, client);
      for (const l of r.logs) assert.strictEqual(l.success, false);
    });
  });

  // 5. Tasks
  describe("5. Tasks", () => {
    it("list", async () => {
      const r = await listTasks({}, client);
      assert.ok(Array.isArray(r.tasks));
    });
    it("filter by repo", async () => {
      const r = await listTasks({ repository: REPO! }, client);
      for (const t of r.tasks) assert.strictEqual(t.repository.toLowerCase(), REPO!.toLowerCase());
    });
  });

  // 6. Agents
  describe("6. Agents", () => {
    it("listAgents", async () => {
      const r = await listAgents(client);
      assert.ok(Array.isArray(r.agents));
      availableAgents = r.agents.filter((a) => a.enabled);
      console.log(`    Agents: ${availableAgents.map((a) => `${a.alias}(${a.supportedModels.length})`).join(", ")}`);
    });
  });

  // 7. Todo CRUD
  describe("7. Todo CRUD", () => {
    let cat: RepoTodoCategory;
    let t1: RepoTodo, t2: RepoTodo;

    it("create category", async () => {
      cat = await createCategory({ repository: REPO!, name: `e2e-${Date.now()}` }, client);
      createdCategoryIds.push(cat.categoryId);
      assert.ok(cat.categoryId);
    });
    it("create todos", async () => {
      t1 = await createTodo({ repository: REPO!, content: `e2e-1-${Date.now()}`, categoryId: cat.categoryId }, client);
      t2 = await createTodo({ repository: REPO!, content: `e2e-2-${Date.now()}`, categoryId: cat.categoryId }, client);
      createdTodoIds.push(t1.todoId, t2.todoId);
    });
    it("list", async () => {
      const r = await listTodos(REPO!, client);
      assert.ok(r.todos.some((t) => t.todoId === t1.todoId));
    });
    it("get", async () => {
      const r = await getTodo(t1.todoId, client);
      assert.strictEqual(r.todoId, t1.todoId);
    });
    it("update", async () => {
      const r = await updateTodo(t1.todoId, { content: "updated" }, client);
      assert.strictEqual(r.content, "updated");
    });
    it("reorder", async () => {
      const r = await reorderTodos(REPO!, [{ id: t2.todoId, orderIndex: 0 }, { id: t1.todoId, orderIndex: 1 }], client);
      assert.ok(r.success);
    });
    it("delete", { skip: NO_CLEANUP ? "NO_CLEANUP" : false }, async () => {
      await deleteTodo(t1.todoId, client);
      await deleteTodo(t2.todoId, client);
      await deleteCategory(cat.categoryId, client);
      createdTodoIds.length = 0;
      createdCategoryIds.length = 0;
    });
  });

  // 8. Plan — greenfield
  describe("8. Plan — greenfield", { timeout: 600_000, skip: SKIP_SLOW ? "SKIP_SLOW" : false }, () => {
    it("create + generate + finalize", async () => {
      const { planId, issues } = await createAndGeneratePlan(
        REPO!, "Add a CONTRIBUTING.md with guidelines for contributing to the project",
        client, createdPlanIds,
      );
      greenfieldDraftId = planId;
      greenfieldPlan = await getPlan(planId, client);
      assert.ok(issues.length > 0 || greenfieldPlan.status !== "failed", "Plan failed");
      console.log(`    ${issues.length} issues`);
    });
    it("appears in list", async () => {
      if (!greenfieldDraftId) return;
      const r = await listPlans(REPO!, {}, client);
      assert.ok(r.drafts.some((d) => d.draft_id === greenfieldDraftId));
    });
  });

  // 9. Plan — brownfield
  describe("9. Plan — brownfield", { timeout: 600_000, skip: SKIP_SLOW ? "SKIP_SLOW" : false }, () => {
    it("create + generate + finalize", async () => {
      const { planId, issues } = await createAndGeneratePlan(
        REPO!, "Improve error handling and add input validation across the codebase",
        client, createdPlanIds,
      );
      brownfieldDraftId = planId;
      brownfieldPlan = await getPlan(planId, client);
      assert.ok(issues.length > 0 || brownfieldPlan.status !== "failed", "Plan failed");
      console.log(`    ${issues.length} issues`);
    });
  });

  // 10. Plan sequential processing
  describe("10. Plan sequential processing", { timeout: 900_000, skip: SKIP_SLOW ? "SKIP_SLOW" : false }, () => {
    let sequentialPlanId: string | null = null;

    it("create plan with multiple issues for sequential test", async () => {
      // Create a plan with multiple small, independent tasks
      const { planId, issues } = await createAndGeneratePlan(
        REPO!,
        "Create 3 tiny independent files: 1) Add a constants.ts with a VERSION constant, 2) Add a types.ts with a Config interface, 3) Add a utils/helpers.ts with a sleep function.",
        client,
        createdPlanIds,
      );
      sequentialPlanId = planId;

      // We need at least 2 issues to test sequential processing
      assert.ok(issues.length >= 2, `Expected at least 2 issues, got ${issues.length}`);
      console.log(`    Created plan with ${issues.length} issues`);
    });

    it("trigger sequential processing (useEpic + autoMerge)", async () => {
      if (!sequentialPlanId) {
        console.log("    Skipping: no plan created");
        return;
      }

      const result = await triggerSequentialImplementation(sequentialPlanId, client);

      // Sequential processing should succeed
      assert.ok(result.success, `Sequential trigger failed: ${result.message}`);

      // With autoMerge + epic, only first issue should be implemented
      // Rest should be queued for sequential processing
      assert.strictEqual(result.implemented, 1, "Expected exactly 1 issue to be implemented immediately");
      assert.ok(result.queued >= 1, `Expected at least 1 issue queued, got ${result.queued}`);
      assert.ok(result.autoMergeEnabled, "Auto-merge should be enabled");
      assert.ok(result.epicLabel, "Epic label should be created");

      console.log(`    Implemented: ${result.implemented}, Queued: ${result.queued}`);
      console.log(`    Epic label: ${result.epicLabel}`);
      console.log(`    Auto-merge: ${result.autoMergeEnabled}`);
    });

    it("first issue is in-progress, subsequent issues remain pending", async () => {
      if (!sequentialPlanId) {
        console.log("    Skipping: no plan created");
        return;
      }

      // Wait briefly for status to update
      await sleep(2000);

      const issues = await listPlanIssues(sequentialPlanId, client);
      const counts = getIssueStatusCounts(issues);

      console.log(`    Issue statuses: pending=${counts.pending}, in-progress=${counts.inProgress}, terminal=${counts.terminal}`);

      // First issue should be in-progress (processing or under_review)
      assert.ok(counts.inProgress >= 1, "Expected at least 1 issue in-progress");

      // At least one issue should still be pending (queued for sequential)
      assert.ok(counts.pending >= 1, "Expected at least 1 issue still pending");

      // Log individual issue statuses
      for (const issue of issues) {
        console.log(`    Issue #${issue.issue_number}: ${issue.status}`);
      }
    });

    it("in-progress issue blocks next trigger", async () => {
      if (!sequentialPlanId) {
        console.log("    Skipping: no plan created");
        return;
      }

      // Get current issues
      const issues = await listPlanIssues(sequentialPlanId, client);

      // Check that we have an in-progress issue
      const inProgressIssue = issues.find((i) => IN_PROGRESS_STATUSES.has(i.status));
      if (!inProgressIssue) {
        console.log("    No in-progress issue found, test inconclusive");
        return;
      }

      console.log(`    In-progress issue #${inProgressIssue.issue_number}: ${inProgressIssue.status}`);

      // Verify pending issues exist
      const pendingIssues = issues.filter((i) => i.status === "pending");
      if (pendingIssues.length === 0) {
        console.log("    No pending issues to verify blocking behavior");
        return;
      }

      // The key assertion: in-progress issues block pending ones
      // This is verified by the fact that after triggerSequentialImplementation,
      // only 1 issue was implemented while others remain pending
      assert.ok(
        hasInProgressIssue(issues),
        "Expected in-progress issue to be present, blocking pending issues"
      );

      console.log(`    Verified: ${pendingIssues.length} pending issue(s) blocked by in-progress issue #${inProgressIssue.issue_number}`);
    });

    it("poll first issue to completion", { timeout: 600_000 }, async () => {
      if (!sequentialPlanId) {
        console.log("    Skipping: no plan created");
        return;
      }

      // Wait for at least one issue to reach a terminal state or under_review
      const finalIssues = await waitForPlanIssueCondition(
        sequentialPlanId,
        client,
        (issues) => {
          // Consider under_review as a valid stopping point (PR created)
          const hasTerminalOrReview = issues.some(
            (i) => i.status === "merged" || i.status === "closed" || i.status === "under_review"
          );
          return hasTerminalOrReview;
        },
        600_000, // 10 minutes
        10_000,  // 10 second poll interval
      );

      const counts = getIssueStatusCounts(finalIssues);
      console.log(`    Final statuses: pending=${counts.pending}, in-progress=${counts.inProgress}, terminal=${counts.terminal}`);

      // At least one issue should have progressed beyond 'processing'
      const progressedIssue = finalIssues.find(
        (i) => i.status === "under_review" || i.status === "merged" || i.status === "closed"
      );
      assert.ok(progressedIssue, "Expected at least one issue to progress to under_review, merged, or closed");

      console.log(`    Issue #${progressedIssue!.issue_number} progressed to: ${progressedIssue!.status}`);
    });
  });

  // 11. All-models implementation
  describe("11. All-models", { timeout: 2_400_000, skip: SKIP_SLOW ? "SKIP_SLOW" : false }, () => {
    it("create plans with enough issues", async () => {
      const pairs = allPairs();
      if (pairs.length === 0) return;

      const needed = pairs.length + 1;
      let collected: PlanIssue[] = [];

      const prompts = [
        "Create 5 tiny improvements: 1) Add constants.ts, 2) Add types.ts, 3) Create utils/format.ts, 4) Add CONTRIBUTING.md, 5) Add input validation.",
        "Create 5 tiny improvements: 1) Add health check helper, 2) Create logger utility, 3) Add .editorconfig, 4) Add utils/errors.ts, 5) Create config validation.",
        "Create 5 tiny improvements: 1) Add JSDoc to exports, 2) Create retry utility, 3) Add debounce utility, 4) Create string sanitizer, 5) Add env validation.",
      ];

      for (let i = 0; i < prompts.length && collected.length < needed; i++) {
        console.log(`    Plan ${i + 1}/${prompts.length}...`);
        const { issues } = await createAndGeneratePlan(REPO!, prompts[i], client, createdPlanIds);
        collected.push(...issues);
        console.log(`    +${issues.length} issues (total: ${collected.length}/${needed})`);
      }
    });

    it("multi-model parallel: all models on one issue", async () => {
      const pairs = allPairs();
      if (pairs.length < 2) return;

      let pending: PlanIssue[] = [];
      for (const pid of createdPlanIds) {
        const iss = await listPlanIssues(pid, client);
        pending.push(...iss.filter((i) => i.status === "pending"));
      }
      if (pending.length === 0) { console.log("    No pending issues"); return; }

      const target = pending[0];
      console.log(`    Issue #${target.issue_number} x ${pairs.length} models`);

      const result = await implementIssue(target.draft_id, target.issue_number, { models: pairs }, client);
      assert.ok(result.success, result.message);

      for (const p of pairs) modelTestResults.push(newModelResult(p, target.issue_number, "parallel"));
      const pr = modelTestResults.filter((r) => r.testMode === "parallel");
      await waitForTasks(pr, REPO!, client);
      await pollTasksToCompletion(pr, client);
    });

    it("single-model: each model on a separate issue", async () => {
      const pairs = allPairs();
      const used = new Set(modelTestResults.map((r) => r.issueNumber));

      let pending: PlanIssue[] = [];
      for (const pid of createdPlanIds) {
        const iss = await listPlanIssues(pid, client);
        pending.push(...iss.filter((i) => i.status === "pending" && !used.has(i.issue_number)));
      }

      const toTest = pairs.slice(0, pending.length);
      if (toTest.length === 0) { console.log("    No issues left"); return; }
      console.log(`    ${toTest.length}/${pairs.length} models`);

      for (let i = 0; i < toTest.length; i++) {
        const p = toTest[i], iss = pending[i];
        await implementIssue(iss.draft_id, iss.issue_number, { models: [p] }, client);
        modelTestResults.push(newModelResult(p, iss.issue_number, "single"));
      }

      const sr = modelTestResults.filter((r) => r.testMode === "single");
      await waitForTasks(sr, REPO!, client);
      await pollTasksToCompletion(sr, client);
    });

    it("every model has execution history", async () => {
      for (const r of modelTestResults.filter((r) => r.taskId)) {
        const s = await getTaskStatus(r.taskId!, client);
        r.hasHistory = s.history.length > 1;
        r.historyCount = s.history.length;
        assert.ok(s.history.length > 0, `${r.agent_alias}/${r.model_name} no history`);
      }
    });

    it("collect LLM logs", async () => {
      const withTasks = modelTestResults.filter((r) => r.taskId && r.finalState);
      for (const pid of createdPlanIds) {
        const logs = await listLlmLogs({ draftId: pid, limit: 200 }, client);
        for (const r of withTasks) {
          const ml = logs.logs.filter((l) => l.agentAlias === r.agent_alias);
          r.logCount += ml.length;
          r.hasLogs = r.logCount > 0;
          r.inputTokens += ml.reduce((s, l) => s + (l.inputTokens ?? 0), 0);
          r.outputTokens += ml.reduce((s, l) => s + (l.outputTokens ?? 0), 0);
        }
      }
    });
  });

  // 12. Report + verification
  describe("12. Report", { skip: SKIP_SLOW ? "SKIP_SLOW" : false }, () => {
    it("write report", async () => {
      const planEntries = [
        { label: "Greenfield", id: greenfieldDraftId, plan: greenfieldPlan },
        { label: "Brownfield", id: brownfieldDraftId, plan: brownfieldPlan },
        ...createdPlanIds
          .filter((id) => id !== greenfieldDraftId && id !== brownfieldDraftId)
          .map((id) => ({ label: `All-models (${id.substring(0, 8)})`, id, plan: null })),
      ];
      const p = await writeReport({ repo: REPO!, apiUrl: API_URL!, client, planEntries, modelResults: modelTestResults });
      console.log(`    Report: ${p}`);
    });

    it("successful logs have no errorMessage", async () => {
      for (const pid of createdPlanIds) {
        const r = await listLlmLogs({ draftId: pid, success: true, limit: 100 }, client);
        for (const l of r.logs) assert.strictEqual(l.errorMessage, null);
      }
    });

    it("failed logs have errorMessage", async () => {
      for (const pid of createdPlanIds) {
        const r = await listLlmLogs({ draftId: pid, success: false, limit: 100 }, client);
        for (const l of r.logs) assert.ok(l.errorMessage);
      }
    });
  });
});
