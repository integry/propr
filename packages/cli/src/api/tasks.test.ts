import assert from "node:assert/strict";
import { test } from "node:test";
import { followupTask, getRevertPreview, importTasks } from "./tasks.js";
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
  } as unknown as ApiClient;
  return { client, calls };
}

test("followupTask posts the task follow-up body", async () => {
  const { client, calls } = clientWithCalls({ success: true, message: "queued", commentId: 12, jobId: "job-1" });

  await followupTask("task/id", "Please add tests", client);

  assert.deepEqual(calls, [{
    method: "POST",
    endpoint: "/api/tasks/task%2Fid/followup",
    options: { body: { body: "Please add tests" } },
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
