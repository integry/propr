import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ACTIVE_TASK_LIFECYCLE_STATES } from "@propr/shared";
import { createTaskCommand } from "./taskCommands.js";

const originalFetch = globalThis.fetch;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalProcessExit = process.exit;

class CommandExit extends Error {
  constructor(readonly code: number) {
    super(`Command exited with ${code}`);
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  process.exit = originalProcessExit;
});

function taskSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-1",
    repository: "integry/propr",
    repositoryOwner: "integry",
    repositoryName: "propr",
    issueNumber: 1946,
    prNumber: null,
    linkedIssueNumber: null,
    title: "Focused task inspection",
    subtitle: null,
    status: "queued",
    createdAt: "2026-08-25T19:00:00.000Z",
    updatedAt: "2026-08-25T20:00:00.000Z",
    completedAt: null,
    processedAt: null,
    failedReason: null,
    progress: 0,
    modelName: "gpt-5.6-sol",
    llmProvider: "codex",
    planIssueStatus: null,
    critiqueScore: null,
    ...overrides,
  };
}

async function runInspect(
  args: string[],
  responder: (url: URL) => { status?: number; body: unknown }
): Promise<{ stdout: string[]; stderr: string[]; requests: URL[]; exitCode?: number }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: URL[] = [];
  let exitCode: number | undefined;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    const response = responder(url);
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  console.log = (...values: unknown[]) => { stdout.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]) => { stderr.push(values.map(String).join(" ")); };
  process.exit = ((code?: string | number | null) => {
    exitCode = Number(code ?? 0);
    throw new CommandExit(exitCode);
  }) as typeof process.exit;

  try {
    await createTaskCommand().parseAsync(["inspect", ...args], { from: "user" });
  } catch (error) {
    if (!(error instanceof CommandExit)) throw error;
  }
  return { stdout, stderr, requests, exitCode };
}

test("task inspect sends an exact state filter to the server", async () => {
  const result = await runInspect(["--state", "queued"], () => ({
    body: { tasks: [taskSummary()], total: 1, offset: 0, limit: 50 },
  }));

  assert.equal(result.exitCode, undefined);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].pathname, "/api/tasks");
  assert.equal(result.requests[0].searchParams.get("status"), "queued");
  assert.match(result.stdout.join("\n"), /Queued/);
  assert.match(result.stdout.join("\n"), /codex \/ gpt-5\.6-sol/);
});

test("task inspect defaults to every canonical active state, including queued work", async () => {
  const result = await runInspect(["--json"], (url) => ({
    body: {
      tasks: url.searchParams.get("status") === "claude_execution"
        ? [taskSummary({ id: "executing-1", status: "claude_execution" })]
        : [],
      total: url.searchParams.get("status") === "claude_execution" ? 1 : 0,
      offset: 0,
      limit: 50,
    },
  }));

  assert.deepEqual(
    result.requests.map((url) => url.searchParams.get("status")),
    [...ACTIVE_TASK_LIFECYCLE_STATES]
  );
  const output = JSON.parse(result.stdout.join("\n"));
  assert.deepEqual(output.states, [...ACTIVE_TASK_LIFECYCLE_STATES]);
  assert.equal(output.tasks[0].state, "claude_execution");
});

test("task inspect JSON has the deterministic list shape and handles empty results", async () => {
  const result = await runInspect(["--state", "pending", "--json"], () => ({
    body: { tasks: [], total: 0, offset: 0, limit: 50 },
  }));

  assert.deepEqual(JSON.parse(result.stdout.join("\n")), {
    version: 1,
    kind: "task-list",
    states: ["pending"],
    tasks: [],
    total: 0,
  });
});

test("task inspect with an ID uses task details and returns full run history", async () => {
  const result = await runInspect(["task/id", "--json"], () => ({
    body: {
      taskId: "task/id",
      taskInfo: {
        repoOwner: "integry",
        repoName: "propr",
        number: 1946,
        type: "issue",
        title: "Focused task inspection",
        agentAlias: "codex",
        modelName: "gpt-5.6-sol",
      },
      history: [
        { state: "pending", timestamp: "2026-08-25T19:00:00.000Z", reason: "Task created" },
        { state: "claude_execution", timestamp: "2026-08-25T20:00:00.000Z", metadata: { model: "gpt-5.6-sol" } },
      ],
    },
  }));

  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].pathname, "/api/task/task%2Fid/history");
  const output = JSON.parse(result.stdout.join("\n"));
  assert.equal(output.version, 1);
  assert.equal(output.kind, "task-detail");
  assert.equal(output.task.state, "claude_execution");
  assert.equal(output.task.details.agentAlias, "codex");
  assert.equal(output.task.history.length, 2);
  assert.equal(typeof output.task.elapsedMs, "number");
});

test("task inspect reports invalid and not-found task IDs", async () => {
  const invalid = await runInspect(["invalid/id"], () => ({
    status: 400,
    body: { error: "Task ID contains invalid characters" },
  }));
  assert.equal(invalid.exitCode, 1);
  assert.match(invalid.stderr.join("\n"), /Error inspecting task: Task ID contains invalid characters/);

  const missing = await runInspect(["missing-task"], () => ({
    status: 404,
    body: { error: "Task not found" },
  }));
  assert.equal(missing.exitCode, 1);
  assert.deepEqual(missing.stderr, ["Error: Task not found: missing-task"]);

  const absentLegacy = await runInspect(["absent-task"], () => ({
    body: { taskId: "absent-task", history: [], taskInfo: null },
  }));
  assert.equal(absentLegacy.exitCode, 1);
  assert.deepEqual(absentLegacy.stderr, ["Error: Task not found: absent-task"]);
});

test("task inspect uses standard API failure presentation", async () => {
  const result = await runInspect(["--state", "processing"], () => ({
    status: 503,
    body: { error: "Task service unavailable" },
  }));

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.stderr, ["Error inspecting tasks: Task service unavailable"]);
});
