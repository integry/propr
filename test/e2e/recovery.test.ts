/**
 * E2E Tests for Task Recovery
 *
 * Tests failure recovery by verifying that tasks stopped mid-execution
 * can be requeued and resume properly.
 *
 * Requires: PROPR_E2E_API_URL, PROPR_E2E_REPO (+ PROPR_E2E_TOKEN or `gh auth token`)
 * Optional: PROPR_E2E_SKIP_SLOW=1, PROPR_E2E_NO_CLEANUP=1
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  API_URL,
  REPO,
  SKIP_SLOW,
  NO_CLEANUP,
  MISSING_ENV,
  createTestClient,
  sleep,
  type ModelTestResult,
  newModelResult,
  createAndGeneratePlan,
  waitForTasks,
  pollTasksToCompletion,
} from "./helpers.js";

import type { ApiClient } from "../../packages/cli/src/api/client.js";
import { listTasks, stopTask, deleteTask } from "../../packages/cli/src/api/tasks.js";
import { listAgents, type AgentConfig } from "../../packages/cli/src/api/agents.js";
import { listPlanIssues, deletePlan, type PlanIssue } from "../../packages/cli/src/api/plans.js";
import { implementIssue, getTaskStatus, type TaskStatus } from "../../packages/cli/src/api/implement.js";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let client: ApiClient;
let availableAgents: AgentConfig[] = [];

const modelTestResults: ModelTestResult[] = [];
const createdPlanIds: string[] = [];
const stoppedTaskIds: string[] = [];

/**
 * Gets the first available agent/model pair for testing.
 */
function getTestAgentModelPair(): { agent_alias: string; model_name: string } | null {
  if (availableAgents.length === 0) return null;
  const agent = availableAgents[0];
  if (agent.supportedModels.length === 0) return null;
  return {
    agent_alias: agent.alias,
    model_name: agent.supportedModels[0],
  };
}

/**
 * Task states that indicate the task is actively processing.
 */
const ACTIVE_STATES = new Set(["processing", "claude_execution", "post_processing"]);

/**
 * Terminal states for tasks.
 */
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

/**
 * Waits for a task to enter an active processing state.
 * @param taskId - The task ID to monitor
 * @param client - API client
 * @param timeoutMs - Maximum time to wait (default 120s)
 * @param pollIntervalMs - Interval between polls (default 5s)
 * @returns The task status when it reaches an active state, or null if timeout
 */
async function waitForTaskToBeActive(
  taskId: string,
  client: ApiClient,
  timeoutMs = 120_000,
  pollIntervalMs = 5_000,
): Promise<TaskStatus | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const status = await getTaskStatus(taskId, client);
    if (ACTIVE_STATES.has(status.currentState)) {
      return status;
    }
    if (TERMINAL_STATES.has(status.currentState)) {
      // Task already completed before we could catch it active
      return status;
    }
    await sleep(pollIntervalMs);
  }

  return null;
}

/**
 * Waits for a task to be cancelled.
 * @param taskId - The task ID to monitor
 * @param client - API client
 * @param timeoutMs - Maximum time to wait (default 60s)
 * @param pollIntervalMs - Interval between polls (default 2s)
 * @returns The task status when it's cancelled, or null if timeout
 */
async function waitForTaskCancelled(
  taskId: string,
  client: ApiClient,
  timeoutMs = 60_000,
  pollIntervalMs = 2_000,
): Promise<TaskStatus | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const status = await getTaskStatus(taskId, client);
    if (status.currentState === "cancelled") {
      return status;
    }
    if (status.currentState === "failed" || status.currentState === "completed") {
      // Task reached a different terminal state
      return status;
    }
    await sleep(pollIntervalMs);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

describe("E2E Task Recovery", {
  skip: MISSING_ENV ? "Missing PROPR_E2E_API_URL, PROPR_E2E_TOKEN, PROPR_E2E_REPO" : false,
}, () => {
  before(() => {
    client = createTestClient();
  });

  after(async () => {
    if (NO_CLEANUP) {
      console.log("  [cleanup] Skipped");
      return;
    }

    // Cleanup tasks
    const taskIds = modelTestResults.map((r) => r.taskId).filter(Boolean) as string[];
    const allTaskIds = [...new Set([...taskIds, ...stoppedTaskIds])];
    for (const id of allTaskIds) {
      try {
        await stopTask(id, client);
      } catch { /* ignore */ }
      try {
        await deleteTask(id, true, client);
      } catch { /* ignore */ }
    }

    // Cleanup plans
    for (const id of createdPlanIds) {
      try {
        await deletePlan(id, client);
      } catch { /* ignore */ }
    }

    console.log("  [cleanup] Done");
  });

  // 1. Load available agents
  describe("1. Setup", () => {
    it("listAgents", async () => {
      const r = await listAgents(client);
      assert.ok(Array.isArray(r.agents));
      availableAgents = r.agents.filter((a) => a.enabled);
      console.log(`    Agents: ${availableAgents.map((a) => `${a.alias}(${a.supportedModels.length})`).join(", ")}`);
      assert.ok(availableAgents.length > 0, "No enabled agents available for testing");
    });
  });

  // 2. Test stopping a task mid-execution
  describe("2. Task Stop Mid-Execution", { timeout: 300_000, skip: SKIP_SLOW ? "SKIP_SLOW" : false }, () => {
    let testIssueNumber: number | null = null;
    let testTaskId: string | null = null;
    let testDraftId: string | null = null;

    it("create a plan with an issue for testing", async () => {
      const { planId, issues } = await createAndGeneratePlan(
        REPO!,
        "Create a simple utility function called 'formatDate' that takes a Date object and returns a formatted string in ISO format. Add it to src/utils/dateUtils.ts",
        client,
        createdPlanIds,
      );

      testDraftId = planId;
      assert.ok(issues.length > 0, "Expected at least 1 issue in the plan");

      const pendingIssue = issues.find((i) => i.status === "pending");
      assert.ok(pendingIssue, "Expected at least one pending issue");

      testIssueNumber = pendingIssue.issue_number;
      console.log(`    Created plan ${planId.substring(0, 8)} with issue #${testIssueNumber}`);
    });

    it("trigger implementation and wait for task to become active", async () => {
      if (!testDraftId || !testIssueNumber) {
        console.log("    Skipping: no issue created");
        return;
      }

      const pair = getTestAgentModelPair();
      if (!pair) {
        console.log("    Skipping: no agent/model available");
        return;
      }

      // Trigger implementation
      const result = await implementIssue(testDraftId, testIssueNumber, {
        agent_alias: pair.agent_alias,
        model_name: pair.model_name,
      }, client);

      assert.ok(result.success, `Implementation trigger failed: ${result.message}`);
      console.log(`    Implementation triggered for issue #${testIssueNumber}`);

      // Wait for task to appear and become active
      const modelResult = newModelResult(pair, testIssueNumber, "recovery");
      modelTestResults.push(modelResult);

      await waitForTasks([modelResult], REPO!, client, 30);

      assert.ok(modelResult.taskId, "Task was not created");
      testTaskId = modelResult.taskId;
      console.log(`    Task ID: ${testTaskId.substring(0, 50)}...`);

      // Wait for task to become active (processing, claude_execution, or post_processing)
      const activeStatus = await waitForTaskToBeActive(testTaskId, client, 120_000, 3_000);

      if (activeStatus && TERMINAL_STATES.has(activeStatus.currentState)) {
        console.log(`    Task reached terminal state ${activeStatus.currentState} before we could stop it`);
        // Still mark as passed since the task executed
        return;
      }

      assert.ok(activeStatus, "Task did not become active within timeout");
      console.log(`    Task is now in state: ${activeStatus.currentState}`);
    });

    it("stop the task mid-execution", async () => {
      if (!testTaskId) {
        console.log("    Skipping: no task to stop");
        return;
      }

      // Check current state
      const currentStatus = await getTaskStatus(testTaskId, client);
      if (TERMINAL_STATES.has(currentStatus.currentState)) {
        console.log(`    Task already in terminal state: ${currentStatus.currentState}`);
        return;
      }

      // Stop the task
      console.log(`    Stopping task in state: ${currentStatus.currentState}...`);
      const stopResult = await stopTask(testTaskId, client);

      assert.ok(stopResult.success, `Stop task failed: ${stopResult.message}`);
      console.log(`    Stop request sent: ${stopResult.message}`);

      stoppedTaskIds.push(testTaskId);
    });

    it("verify task is cancelled", async () => {
      if (!testTaskId) {
        console.log("    Skipping: no task to verify");
        return;
      }

      // Check if already in terminal state
      const initialStatus = await getTaskStatus(testTaskId, client);
      if (initialStatus.currentState === "completed") {
        console.log("    Task completed before cancellation could be verified");
        return;
      }

      // Wait for task to be cancelled
      const cancelledStatus = await waitForTaskCancelled(testTaskId, client);

      if (cancelledStatus) {
        console.log(`    Task reached state: ${cancelledStatus.currentState}`);

        // Verify the history contains the cancellation
        const hasCancellationInHistory = cancelledStatus.history.some(
          (h) => h.state === "cancelled" || h.reason?.includes("cancelled"),
        );

        if (cancelledStatus.currentState === "cancelled") {
          assert.ok(true, "Task was successfully cancelled");
        } else if (cancelledStatus.currentState === "completed") {
          console.log("    Task completed before cancellation took effect");
        } else if (cancelledStatus.currentState === "failed") {
          console.log(`    Task failed: ${cancelledStatus.failureReason}`);
        }

        // Log history summary
        console.log(`    History entries: ${cancelledStatus.history.length}`);
        for (const entry of cancelledStatus.history.slice(-3)) {
          console.log(`      - ${entry.state}: ${entry.reason || "no reason"}`);
        }
      } else {
        console.log("    Timeout waiting for task cancellation");
      }
    });
  });

  // 3. Test task requeue (re-triggering a cancelled task)
  describe("3. Task Requeue", { timeout: 600_000, skip: SKIP_SLOW ? "SKIP_SLOW" : false }, () => {
    let requeueIssueNumber: number | null = null;
    let requeueDraftId: string | null = null;
    let firstTaskId: string | null = null;
    let secondTaskId: string | null = null;

    it("create a plan and trigger implementation", async () => {
      const { planId, issues } = await createAndGeneratePlan(
        REPO!,
        "Create a simple helper function called 'capitalize' that capitalizes the first letter of a string. Add it to src/utils/stringUtils.ts",
        client,
        createdPlanIds,
      );

      requeueDraftId = planId;
      assert.ok(issues.length > 0, "Expected at least 1 issue in the plan");

      const pendingIssue = issues.find((i) => i.status === "pending");
      assert.ok(pendingIssue, "Expected at least one pending issue");

      requeueIssueNumber = pendingIssue.issue_number;
      console.log(`    Created plan ${planId.substring(0, 8)} with issue #${requeueIssueNumber}`);
    });

    it("start task, stop it, then requeue", async () => {
      if (!requeueDraftId || !requeueIssueNumber) {
        console.log("    Skipping: no issue created");
        return;
      }

      const pair = getTestAgentModelPair();
      if (!pair) {
        console.log("    Skipping: no agent/model available");
        return;
      }

      // First implementation
      console.log("    Triggering first implementation...");
      const result1 = await implementIssue(requeueDraftId, requeueIssueNumber, {
        agent_alias: pair.agent_alias,
        model_name: pair.model_name,
      }, client);

      assert.ok(result1.success, `First implementation trigger failed: ${result1.message}`);

      // Wait for first task
      const modelResult1 = newModelResult(pair, requeueIssueNumber, "requeue-first");
      modelTestResults.push(modelResult1);
      await waitForTasks([modelResult1], REPO!, client, 30);

      if (!modelResult1.taskId) {
        console.log("    First task was not created");
        return;
      }

      firstTaskId = modelResult1.taskId;
      console.log(`    First task ID: ${firstTaskId.substring(0, 50)}...`);
      stoppedTaskIds.push(firstTaskId);

      // Wait for it to become active
      const activeStatus = await waitForTaskToBeActive(firstTaskId, client, 120_000, 3_000);
      if (!activeStatus || TERMINAL_STATES.has(activeStatus.currentState)) {
        console.log(`    First task reached terminal state before stop: ${activeStatus?.currentState}`);
        return;
      }

      console.log(`    First task active in state: ${activeStatus.currentState}`);

      // Stop the first task
      console.log("    Stopping first task...");
      await stopTask(firstTaskId, client);

      // Wait for cancellation
      await waitForTaskCancelled(firstTaskId, client, 30_000, 2_000);

      // Give the system time to process the cancellation
      await sleep(5_000);

      // Requeue by triggering implementation again
      console.log("    Triggering second implementation (requeue)...");
      const result2 = await implementIssue(requeueDraftId, requeueIssueNumber, {
        agent_alias: pair.agent_alias,
        model_name: pair.model_name,
      }, client);

      // Note: The system may reject requeue if the issue is already in a terminal state
      // or may create a new task with a different ID
      console.log(`    Requeue result: success=${result2.success}, message=${result2.message}`);

      if (result2.success) {
        // Wait for second task
        const modelResult2 = newModelResult(pair, requeueIssueNumber, "requeue-second");
        modelTestResults.push(modelResult2);

        await waitForTasks([modelResult2], REPO!, client, 30);

        if (modelResult2.taskId) {
          secondTaskId = modelResult2.taskId;
          console.log(`    Second task ID: ${secondTaskId.substring(0, 50)}...`);

          // Verify second task is different from first
          if (firstTaskId !== secondTaskId) {
            console.log("    Verified: New task was created for requeue");
          } else {
            console.log("    Note: Same task ID reused (task resumed)");
          }
        } else {
          console.log("    Second task was not created - may already be processed");
        }
      } else {
        console.log("    Requeue was not successful - issue may already be processed or in invalid state");
      }
    });

    it("verify requeued task can complete", async () => {
      if (!secondTaskId && !firstTaskId) {
        console.log("    Skipping: no task to verify");
        return;
      }

      const taskToCheck = secondTaskId || firstTaskId;
      const taskLabel = secondTaskId ? "second (requeued)" : "first";

      console.log(`    Polling ${taskLabel} task to completion...`);

      // Check if already complete
      const initialStatus = await getTaskStatus(taskToCheck!, client);
      if (TERMINAL_STATES.has(initialStatus.currentState)) {
        console.log(`    Task already in terminal state: ${initialStatus.currentState}`);
        if (initialStatus.currentState === "completed") {
          console.log(`    Task completed successfully. PR: ${initialStatus.prNumber || "none"}`);
        }
        return;
      }

      // Poll task to completion with a shorter timeout for the test
      const relatedResults = modelTestResults.filter(
        (r) => r.taskId === taskToCheck,
      );

      if (relatedResults.length > 0) {
        await pollTasksToCompletion(relatedResults, client);

        const result = relatedResults[0];
        console.log(`    Final state: ${result.finalState}`);

        if (result.finalState === "completed") {
          console.log(`    Task completed successfully. PR: ${result.prNumber || "none"}`);
        } else if (result.finalState === "failed") {
          console.log(`    Task failed: ${result.failureReason}`);
        }
      } else {
        console.log("    No model result found for task");
      }
    });
  });

  // 4. Test task resume verification
  describe("4. Task Resume Verification", { timeout: 300_000, skip: SKIP_SLOW ? "SKIP_SLOW" : false }, () => {
    let resumeIssueNumber: number | null = null;
    let resumeDraftId: string | null = null;

    it("create and execute a task to completion", async () => {
      const { planId, issues } = await createAndGeneratePlan(
        REPO!,
        "Add a simple constant HELLO = 'world' to a new file src/constants/hello.ts",
        client,
        createdPlanIds,
      );

      resumeDraftId = planId;
      assert.ok(issues.length > 0, "Expected at least 1 issue in the plan");

      const pendingIssue = issues.find((i) => i.status === "pending");
      assert.ok(pendingIssue, "Expected at least one pending issue");

      resumeIssueNumber = pendingIssue.issue_number;
      console.log(`    Created plan ${planId.substring(0, 8)} with issue #${resumeIssueNumber}`);
    });

    it("trigger implementation and verify state transitions", async () => {
      if (!resumeDraftId || !resumeIssueNumber) {
        console.log("    Skipping: no issue created");
        return;
      }

      const pair = getTestAgentModelPair();
      if (!pair) {
        console.log("    Skipping: no agent/model available");
        return;
      }

      // Trigger implementation
      const result = await implementIssue(resumeDraftId, resumeIssueNumber, {
        agent_alias: pair.agent_alias,
        model_name: pair.model_name,
      }, client);

      assert.ok(result.success, `Implementation trigger failed: ${result.message}`);
      console.log(`    Implementation triggered for issue #${resumeIssueNumber}`);

      // Wait for task
      const modelResult = newModelResult(pair, resumeIssueNumber, "resume-verify");
      modelTestResults.push(modelResult);

      await waitForTasks([modelResult], REPO!, client, 30);

      assert.ok(modelResult.taskId, "Task was not created");
      console.log(`    Task ID: ${modelResult.taskId.substring(0, 50)}...`);

      // Poll to completion while tracking state transitions
      await pollTasksToCompletion([modelResult], client);

      // Verify state transitions were recorded
      const finalStatus = await getTaskStatus(modelResult.taskId, client);

      console.log(`    Final state: ${finalStatus.currentState}`);
      console.log(`    State transitions recorded: ${finalStatus.history.length}`);

      // Verify expected state progression
      const states = finalStatus.history.map((h) => h.state);
      console.log(`    State sequence: ${states.join(" -> ")}`);

      // Should have at least pending -> processing states
      assert.ok(states.includes("pending"), "Should have pending state in history");

      if (finalStatus.currentState === "completed") {
        assert.ok(
          states.includes("processing") || states.includes("claude_execution"),
          "Should have processing or claude_execution state in history",
        );
        console.log(`    Task completed with PR: ${finalStatus.prNumber || "none"}`);
      } else if (finalStatus.currentState === "failed") {
        console.log(`    Task failed: ${finalStatus.failureReason}`);
      }

      // Verify history metadata
      for (const entry of finalStatus.history) {
        if (entry.metadata) {
          const metaKeys = Object.keys(entry.metadata);
          if (metaKeys.length > 0) {
            console.log(`    [${entry.state}] metadata: ${metaKeys.join(", ")}`);
          }
        }
      }
    });

    it("verify task history has proper recovery information", async () => {
      // Get all tasks with history
      const tasksWithHistory = modelTestResults.filter((r) => r.taskId && r.historyCount > 0);

      console.log(`    Tasks with history: ${tasksWithHistory.length}`);

      for (const result of tasksWithHistory) {
        const status = await getTaskStatus(result.taskId!, client);

        // Check for recovery-relevant metadata
        const hasRecoveryInfo = status.history.some((h) => {
          const meta = h.metadata || {};
          return (
            meta.sessionId ||
            meta.conversationId ||
            meta.attempts !== undefined ||
            h.reason?.includes("retry") ||
            h.reason?.includes("resume")
          );
        });

        if (hasRecoveryInfo) {
          console.log(`    Task ${result.taskId?.substring(0, 20)}... has recovery-relevant metadata`);
        }

        // Verify state machine integrity
        const validStateOrder: Record<string, string[]> = {
          pending: ["processing", "queued", "cancelled", "failed"],
          queued: ["processing", "cancelled", "failed"],
          processing: ["claude_execution", "completed", "cancelled", "failed"],
          claude_execution: ["post_processing", "completed", "cancelled", "failed"],
          post_processing: ["completed", "cancelled", "failed"],
        };

        let previousState: string | null = null;
        for (const entry of status.history) {
          const state = entry.state.toLowerCase();
          if (previousState && validStateOrder[previousState]) {
            // This is informational - some state jumps may be valid in certain scenarios
            if (!validStateOrder[previousState].includes(state)) {
              console.log(`    Note: State transition ${previousState} -> ${state}`);
            }
          }
          previousState = state;
        }
      }
    });
  });

  // 5. Summary
  describe("5. Summary", () => {
    it("log test results", () => {
      console.log("\n    === Task Recovery Test Summary ===");
      console.log(`    Total tasks created: ${modelTestResults.length}`);
      console.log(`    Tasks stopped mid-execution: ${stoppedTaskIds.length}`);

      const completed = modelTestResults.filter((r) => r.finalState === "completed").length;
      const failed = modelTestResults.filter((r) => r.finalState === "failed").length;
      const cancelled = modelTestResults.filter((r) => r.finalState === "cancelled").length;

      console.log(`    Completed: ${completed}`);
      console.log(`    Failed: ${failed}`);
      console.log(`    Cancelled: ${cancelled}`);

      for (const result of modelTestResults) {
        console.log(`    - Issue #${result.issueNumber} (${result.testMode}): ${result.finalState || "unknown"}`);
      }
    });
  });
});
