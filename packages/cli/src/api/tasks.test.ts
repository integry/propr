import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteTask, followupTask, getRevertPreview, importTasks, listTasks, stopTask } from "./tasks.js";
import { getTaskStatus } from "./implement.js";
import type { ApiClient } from "./client.js";

function clientWithCalls(responseData: unknown) {
  const calls: Array<{ method: string; endpoint: string; options?: unknown }> = [];
  const client = {
    async get(endpoint: string, options?: unknown) {
      calls.push({ method: "GET", endpoint, options });
      return { data: responseData, status: 200, headers: new Headers() };
    },
    async post(endpoint: string, options?: unknown) {
      calls.push({ method: "POST", endpoint, options });
      return { data: responseData, status: 200, headers: new Headers() };
    },
    async delete(endpoint: string, options?: unknown) {
      calls.push({ method: "DELETE", endpoint, options });
      return { data: responseData, status: 204, headers: new Headers() };
    },
  } as unknown as ApiClient;
  return { client, calls };
}

test("followupTask posts the task follow-up body", async () => {
  const { client, calls } = clientWithCalls({ success: true, message: "queued", commentId: 12, jobId: "job-1" });

  await followupTask("task-123", "Please add tests", client);

  assert.deepEqual(calls, [{
    method: "POST",
    endpoint: "/api/tasks/task-123/followup",
    options: { body: { body: "Please add tests" } },
  }]);
});

test("stopTask posts to the canonical stop endpoint with encoded task IDs", async () => {
  const { client, calls } = clientWithCalls({ success: true, message: "stopped" });

  await stopTask("task/id?attempt=2", client);

  assert.deepEqual(calls, [{
    method: "POST",
    endpoint: "/api/task/task%2Fid%3Fattempt%3D2/stop",
    options: undefined,
  }]);
});

test("importTasks posts repository and task description", async () => {
  const { client, calls } = clientWithCalls({ jobId: "job-1" });

  await importTasks("owner/repo", "Recover missing tasks", client);

  assert.deepEqual(calls, [{
    method: "POST",
    endpoint: "/api/import-tasks",
    options: { body: { repository: "owner/repo", taskDescription: "Recover missing tasks" } },
  }]);
});

test("getRevertPreview sends expected query parameters", async () => {
  const { client, calls } = clientWithCalls({ success: true });

  await getRevertPreview("owner", "repo", 42, "abc123", client);

  assert.deepEqual(calls, [{
    method: "GET",
    endpoint: "/api/tasks/revert-preview",
    options: { params: { owner: "owner", repo: "repo", pr: "42", commit: "abc123" } },
  }]);
});

test("deleteTask safely encodes the task ID path segment with force query", async () => {
  const { client, calls } = clientWithCalls(undefined);
  const taskId = "task/id?x=1";

  await deleteTask(taskId, true, client);

  assert.deepEqual(calls, [{
    method: "DELETE",
    endpoint: "/api/tasks/task%2Fid%3Fx%3D1",
    options: { params: { force: "true" } },
  }]);
});

test("listTasks sends lifecycle-state filters to the server", async () => {
  const response = { tasks: [], total: 0, offset: 0, limit: 25 };
  const { client, calls } = clientWithCalls(response);

  await listTasks({ status: "claude_execution", limit: 25 }, client);

  assert.deepEqual(calls, [{
    method: "GET",
    endpoint: "/api/tasks",
    options: { params: { status: "claude_execution", limit: "25" } },
  }]);
});

test("getTaskStatus uses the task detail/history path for a supplied ID", async () => {
  const { client, calls } = clientWithCalls({
    taskId: "task/id?attempt=2",
    history: [{ state: "processing", timestamp: "2026-08-25T20:00:00.000Z" }],
    taskInfo: null,
  });

  const result = await getTaskStatus("task/id?attempt=2", client);

  assert.equal(result.currentState, "processing");
  assert.deepEqual(calls, [{
    method: "GET",
    endpoint: "/api/task/task%2Fid%3Fattempt%3D2/history",
    options: undefined,
  }]);
});

test("getTaskStatus exposes the automatic-replacement lineage for task get --json", async () => {
  const { client } = clientWithCalls({
    taskId: "attempt-2",
    history: [
      { state: "failed", timestamp: "2026-10-06T09:00:00.000Z", reason: "Task failed: 529 Overloaded" },
      { state: "failed", timestamp: "2026-10-06T09:00:01.000Z", reason: "Replacement attempt 3 dispatched", metadata: { event: "replacement.dispatched" } },
    ],
    taskInfo: {
      repoOwner: "integry", repoName: "propr", number: 2739, type: "issue",
      attemptNumber: 2, replacesTaskId: "attempt-1", replacedByTaskId: "attempt-3",
    },
  });

  const result = await getTaskStatus("attempt-2", client);

  assert.equal(result.replacesTaskId, "attempt-1");
  assert.equal(result.replacedByTaskId, "attempt-3");
  assert.equal(result.attemptNumber, 2);
  assert.equal(result.failureReason, "Task failed: 529 Overloaded", "timeline events do not replace the failure reason");
  const json = JSON.parse(JSON.stringify(result));
  assert.deepEqual([json.replacesTaskId, json.replacedByTaskId, json.attemptNumber], ["attempt-1", "attempt-3", 2]);
});

test("getTaskStatus reports a task outside a lineage as attempt 1", async () => {
  const { client } = clientWithCalls({ taskId: "task-1", history: [], taskInfo: null });
  const result = await getTaskStatus("task-1", client);
  assert.deepEqual([result.replacesTaskId, result.replacedByTaskId, result.attemptNumber], [null, null, 1]);
});
