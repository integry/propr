import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteTask, followupTask, getRevertPreview, importTasks, stopTask } from "./tasks.js";
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

  await stopTask("task.alpha_beta-42", client);

  assert.deepEqual(calls, [{
    method: "POST",
    endpoint: "/api/task/task.alpha_beta-42/stop",
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
