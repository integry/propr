import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, test } from "node:test";
import { createGoalCommand, observedGoalState } from "./goalCommands.js";

const originalFetch = globalThis.fetch;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalProcessExit = process.exit;
const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin")!;

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
  Object.defineProperty(process, "stdin", originalStdin);
});

interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

type Responder = (request: RecordedRequest, attempt: number) => { status?: number; body?: unknown } | Error;

function goalFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "goal-1",
    owner: "alice",
    repository: "acme/repo",
    title: "Ship reliable delivery",
    objective: "Ship it",
    launchStrategy: "direct",
    baseBranch: null,
    branchName: "goal/ship-it",
    agent: { id: "codex", alias: "codex", type: "codex" },
    requestedModel: "model-a",
    effectiveModel: "model-a",
    maxParallelTasks: null,
    ultrafix: false,
    desiredState: "running",
    resultState: null,
    failureReason: null,
    pausePending: false,
    control: { requestGeneration: 1, acknowledgedGeneration: 1, pending: false },
    taskId: "goal-task-1",
    sessionId: "thread-1",
    conversationId: null,
    finalPr: null,
    checkpoint: null,
    taskState: "claude_execution",
    createdAt: "2026-09-05T12:00:00.000Z",
    updatedAt: "2026-09-05T12:10:00.000Z",
    startedAt: "2026-09-05T12:00:01.000Z",
    pausedAt: null,
    completedAt: null,
    elapsedMs: 600_000,
    pausedMs: 0,
    activeMs: 600_000,
    ...overrides,
  };
}

async function run(
  args: string[],
  responder: Responder,
): Promise<{ stdout: string; stderr: string; requests: RecordedRequest[]; exitCode?: number }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: RecordedRequest[] = [];
  let exitCode: number | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    const result = responder(request, requests.length);
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
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
    await createGoalCommand().parseAsync(args, { from: "user" });
  } catch (error) {
    if (!(error instanceof CommandExit)) throw error;
  }
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), requests, exitCode };
}

function useStdin(text: string): void {
  const stream = Readable.from([Buffer.from(text)]) as Readable & { isTTY?: boolean };
  stream.isTTY = false;
  Object.defineProperty(process, "stdin", { value: stream, configurable: true });
}

test("observed state separates the requested lifecycle from what the provider confirmed", () => {
  const base = { resultState: null, desiredState: "running", pausePending: false, startedAt: null } as const;
  assert.equal(observedGoalState(base), "starting");
  assert.equal(observedGoalState({ ...base, startedAt: "now" }), "running");
  assert.equal(observedGoalState({ ...base, desiredState: "paused", pausePending: true }), "pausing");
  assert.equal(observedGoalState({ ...base, desiredState: "paused" }), "paused");
  assert.equal(observedGoalState({ ...base, desiredState: "cancelled" }), "cancelling");
  assert.equal(observedGoalState({ ...base, desiredState: "cancelled", resultState: "cancelled" }), "cancelled");
});

test("goal create reads the objective from stdin, maps options and says that work started", async () => {
  useStdin("Add rate limiting\n");
  const result = await run([
    "create", "--stdin", "-p", "acme/repo", "-a", "codex", "-m", "model-a", "--strategy", "orchestrate",
    "--max-parallel-tasks", "3", "--base-branch", "develop", "--ultrafix", "--idempotency-key", "create-key-001",
  ], () => ({ status: 201, body: { goal: goalFixture({ launchStrategy: "orchestrate" }) } }));
  assert.equal(result.exitCode, undefined, result.stderr);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].headers["Idempotency-Key"], "create-key-001");
  assert.deepEqual(result.requests[0].body, {
    repository: "acme/repo", objective: "Add rate limiting", agentId: "codex", model: "model-a",
    launchStrategy: "orchestrate", baseBranch: "develop", maxParallelTasks: 3, ultrafix: true,
  });
  assert.match(result.stdout, /Goal created and started\./);
  assert.match(result.stdout, /Idempotency key: create-key-001/);
});

test("goal create reads a file, fills the default model from capabilities and prints versioned JSON", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "propr-goal-"));
  try {
    const file = path.join(dir, "objective.md");
    await writeFile(file, "Migrate billing\n");
    const result = await run(
      ["create", "--file", file, "-p", "acme/repo", "-a", "codex", "--checkpoint-interval", "30", "--json"],
      (request) => request.url.pathname === "/api/goals/capabilities"
        ? { body: { agents: [{ agentId: "codex", agentAlias: "codex", agentType: "codex", goalCapable: true, models: ["model-a", "model-b"], defaultModel: "model-b" }] } }
        : { status: 201, body: { goal: goalFixture({ requestedModel: "model-b", effectiveModel: null, startedAt: null }) } },
    );
    assert.equal(result.exitCode, undefined, result.stdout);
    const create = result.requests.find((request) => request.method === "POST")!;
    assert.deepEqual(create.body, {
      repository: "acme/repo", objective: "Migrate billing", agentId: "codex", model: "model-b",
      launchStrategy: "direct", checkpointIntervalMinutes: 30,
    });
    assert.match(create.headers["Idempotency-Key"], /^cli-/);
    const output = JSON.parse(result.stdout);
    assert.equal(output.version, 1);
    assert.equal(output.kind, "goal-create");
    assert.equal(output.outcome, "created");
    assert.equal(output.workStarted, true);
    assert.equal(output.goalId, "goal-1");
    assert.equal(output.idempotencyKey, create.headers["Idempotency-Key"]);
    assert.deepEqual(output.goal.model, { requested: "model-b", effective: null, confirmed: false });
    assert.equal(output.goal.lifecycle.observedState, "starting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("goal create rejects conflicting objective sources and invalid options before calling the API", async () => {
  for (const args of [
    ["create", "Inline", "--stdin", "-p", "acme/repo", "-a", "codex", "-m", "m", "--json"],
    ["create", "Inline", "-p", "acme/repo", "-a", "codex", "-m", "m", "--strategy", "bogus", "--json"],
    ["create", "Inline", "-p", "acme/repo", "-a", "codex", "-m", "m", "--strategy", "orchestrate", "--checkpoint-interval", "10", "--json"],
    ["create", "Inline", "-p", "acme/repo", "-a", "codex", "-m", "m", "--idempotency-key", "bad key", "--json"],
  ]) {
    const result = await run(args, () => ({ status: 500 }));
    assert.equal(result.exitCode, 1);
    assert.equal(result.requests.length, 0);
    assert.equal(JSON.parse(result.stdout).error.code, "invalid_arguments");
  }
});

test("goal create passes server validation through with a machine-readable code", async () => {
  const result = await run(["create", "Do it", "-p", "acme/repo", "-a", "codex", "-m", "nope", "--json"],
    () => ({ status: 400, body: { error: "Selected model is not supported by this agent" } }));
  assert.equal(result.exitCode, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.kind, "goal-error");
  assert.equal(output.error.code, "validation_failed");
  assert.equal(output.error.message, "Selected model is not supported by this agent");

  const capability = await run(["create", "Do it", "-p", "acme/repo", "-a", "vibe", "-m", "m"],
    () => ({ status: 409, body: { error: "Selected agent does not support the required goal/session contract" } }));
  assert.equal(capability.exitCode, 1);
  assert.match(capability.stderr, /does not support the required goal/);
});

test("an uncertain create gives the idempotency key as a recovery path instead of starting another goal", async () => {
  const result = await run(
    ["create", "Do it", "-p", "acme/repo", "-a", "codex", "-m", "model-a", "--idempotency-key", "recover-key-01"],
    () => new TypeError("fetch failed"),
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.requests.length, 3);
  assert.ok(result.requests.every((request) => request.headers["Idempotency-Key"] === "recover-key-01"));
  assert.match(result.stderr, /Could not confirm the outcome/);
  assert.match(result.stderr, /--idempotency-key recover-key-01/);

  const json = await run(
    ["create", "Do it", "-p", "acme/repo", "-a", "codex", "-m", "model-a", "--json"],
    (_request, attempt) => (attempt < 3 ? { status: 504 } : { status: 500, body: { error: "boom" } }),
  );
  const output = JSON.parse(json.stdout);
  assert.equal(output.error.code, "outcome_uncertain");
  assert.match(output.error.idempotencyKey, /^cli-/);
  assert.match(output.error.recovery, new RegExp(output.error.idempotencyKey));
});

test("goal list sends filters and pagination and reports the next offset", async () => {
  const result = await run(["list", "-p", "acme/repo", "--state", "paused", "--limit", "1", "--offset", "4", "--json"],
    () => ({ body: { goals: [goalFixture({ desiredState: "paused", pausePending: true })], offset: 4, limit: 1, nextOffset: 5 } }));
  assert.equal(result.exitCode, undefined, result.stdout);
  assert.deepEqual(Object.fromEntries(result.requests[0].url.searchParams),
    { repository: "acme/repo", state: "paused", offset: "4", limit: "1" });
  const output = JSON.parse(result.stdout);
  assert.equal(output.kind, "goal-list");
  assert.equal(output.nextOffset, 5);
  assert.deepEqual(output.filters, { repository: "acme/repo", state: "paused" });
  assert.equal(output.goals[0].lifecycle.requestedState, "paused");
  assert.equal(output.goals[0].lifecycle.observedState, "pausing");

  const human = await run(["list"], () => ({ body: { goals: [goalFixture()], offset: 0, limit: 20, nextOffset: 20 } }));
  assert.match(human.stdout, /goal-1/);
  assert.match(human.stdout, /More goals: --offset 20/);
  assert.equal((await run(["list", "--state", "bogus"], () => ({}))).exitCode, 1);
});

test("goal inspect distinguishes goal completion from task completion and includes failure and checkpoint detail", async () => {
  const detail = {
    currentActivity: { currentFocus: "Running tests", entries: [{ timestamp: "2026-09-05T12:09:00.000Z", message: "Fixing the flaky retry test" }], order: "newest_first" },
    progress: {
      tasks: { total: 3, active: 1, completed: 1, failed: 1, cancelled: 0 },
      recentTerminalTransitions: [{ taskId: "child-1", state: "failed", at: "2026-09-05T12:05:00.000Z", reason: "Tests failed" }],
      startedAt: "2026-09-05T12:00:01.000Z", elapsedSeconds: 600, checkpoint: null,
    },
    pendingInput: { waitingForOperator: false, reason: null, undeliveredInputs: 1, lastInputAt: null, lastInputDeliveredAt: null },
    pullRequests: [{ number: 41, state: null, role: "final" }],
  };
  const goal = goalFixture({
    taskState: "completed",
    requestedModel: "model-b",
    control: { requestGeneration: 3, acknowledgedGeneration: 2, pending: true },
    finalPr: { number: 41, url: "https://github.com/acme/repo/pull/41" },
    checkpoint: { intervalMinutes: 15, count: 2, lastAt: "2026-09-05T12:08:00.000Z", lastCommitSha: "abc1234def", error: "push rejected", pending: false, latest: null },
  });
  const result = await run(["inspect", "goal-1", "--json"], () => ({ body: { goal, detail } }));
  assert.equal(result.requests[0].url.pathname, "/api/goals/goal-1/detail");
  const output = JSON.parse(result.stdout);
  assert.equal(output.kind, "goal-detail");
  assert.equal(output.goal.lifecycle.goalCompleted, false);
  assert.equal(output.goal.currentTask.taskCompleted, true);
  assert.equal(output.goal.lifecycle.controlPending, true);
  assert.deepEqual(output.goal.model, { requested: "model-b", effective: "model-a", confirmed: false });
  assert.equal(output.goal.failure.failedTasks[0].reason, "Tests failed");
  assert.equal(output.goal.checkpoint.error, "push rejected");
  assert.equal(output.goal.pendingInput.undeliveredInputs, 1);
  assert.equal(output.goal.narration.entries[0].message, "Fixing the flaky retry test");
  assert.equal(output.goal.pullRequests[0].number, 41);

  const human = await run(["inspect", "goal-1"], () => ({ body: { goal, detail } }));
  assert.match(human.stdout, /Goal done:\s+no/);
  assert.match(human.stdout, /change to model-b requested/);
  assert.match(human.stdout, /Task child-1 failed.*Tests failed/);
  assert.match(human.stdout, /Error:\s+push rejected/);
  assert.match(human.stdout, /#41 final/);

  const missing = await run(["inspect", "goal-x", "--json"], () => ({ status: 404, body: { error: "Goal not found" } }));
  assert.equal(missing.exitCode, 1);
  assert.equal(JSON.parse(missing.stdout).error.code, "not_found");
  const human404 = await run(["inspect", "goal-x"], () => ({ status: 404, body: { error: "Goal not found" } }));
  assert.match(human404.stderr, /Goal not found: goal-x/);
});

test("goal input reports queued, not acted-on, and goal inputs paginates history", async () => {
  const sent = await run(["input", "goal-1", "Use", "the", "helper", "--idempotency-key", "input-key-001", "--json"], () => ({
    body: { goal: goalFixture({ inputs: [{ id: "input-9", message: "Use the helper", attachmentCount: 0, state: "pending", createdAt: null, deliveredAt: null }] }) },
  }));
  assert.equal(sent.requests[0].url.pathname, "/api/goals/goal-1/input");
  assert.deepEqual(sent.requests[0].body, { message: "Use the helper" });
  const output = JSON.parse(sent.stdout);
  assert.equal(output.kind, "goal-input");
  assert.equal(output.accepted, true);
  assert.deepEqual([output.input.id, output.input.queued, output.input.delivered, output.input.actedOn], ["input-9", true, false, null]);

  const canned = await run(["input", "goal-1", "--canned", "done"], () => ({ body: { goal: goalFixture() } }));
  assert.deepEqual(canned.requests[0].body, { canned: "done" });
  assert.match(canned.stdout, /queued for the next provider boundary/);

  const conflict = await run(["input", "goal-1", "Different", "--idempotency-key", "input-key-001", "--json"],
    () => ({ status: 409, body: { error: "Idempotency-Key was already used for a different goal, operation, or payload" } }));
  assert.equal(JSON.parse(conflict.stdout).error.code, "idempotency_conflict");

  const history = await run(["inputs", "goal-1", "--limit", "2", "--offset", "2", "--json"], () => ({
    body: { inputs: [{ id: "input-1", message: "First", attachmentCount: 0, state: "delivered", createdAt: null, deliveredAt: "2026-09-05T12:00:05.000Z" }], order: "newest_first", nextOffset: null },
  }));
  assert.deepEqual(Object.fromEntries(history.requests[0].url.searchParams), { offset: "2", limit: "2" });
  const page = JSON.parse(history.stdout);
  assert.equal(page.kind, "goal-inputs");
  assert.equal(page.nextOffset, null);
  assert.deepEqual([page.inputs[0].delivered, page.inputs[0].actedOn], [true, null]);
});

test("pause, resume, cancel and model report requested controls separately from confirmed state", async () => {
  const pause = await run(["pause", "goal-1", "--json"], () => ({ body: { goal: goalFixture({ desiredState: "paused", pausePending: true }) } }));
  assert.equal(pause.requests[0].url.pathname, "/api/goals/goal-1/pause");
  assert.match(pause.requests[0].headers["Idempotency-Key"], /^cli-/);
  const paused = JSON.parse(pause.stdout);
  assert.deepEqual([paused.kind, paused.action, paused.accepted, paused.confirmed], ["goal-control", "pause", true, false]);
  assert.deepEqual(paused.requested, { desiredState: "paused" });

  const resume = await run(["resume", "goal-1"], () => ({ body: { goal: goalFixture() } }));
  assert.equal(resume.requests[0].url.pathname, "/api/goals/goal-1/resume");
  assert.match(resume.stdout, /Goal is running\./);

  const cancel = await run(["cancel", "goal-1", "--json"], () => ({ body: { goal: goalFixture({ desiredState: "cancelled" }) } }));
  const cancelled = JSON.parse(cancel.stdout);
  assert.equal(cancelled.confirmed, false);
  assert.equal(cancelled.goal.lifecycle.observedState, "cancelling");

  const model = await run(["model", "goal-1", "model-b", "--idempotency-key", "model-key-001", "--json"],
    () => ({ body: { goal: goalFixture({ requestedModel: "model-b", control: { requestGeneration: 2, acknowledgedGeneration: 1, pending: true } }) } }));
  assert.equal(model.requests[0].method, "PATCH");
  assert.deepEqual(model.requests[0].body, { model: "model-b" });
  assert.equal(model.requests[0].headers["Idempotency-Key"], "model-key-001");
  const changed = JSON.parse(model.stdout);
  assert.deepEqual([changed.action, changed.confirmed, changed.requested.model], ["model", false, "model-b"]);

  const terminal = await run(["pause", "goal-1", "--json"], () => ({ status: 409, body: { error: "Goal is terminal" } }));
  assert.equal(JSON.parse(terminal.stdout).error.code, "state_conflict");
  const denied = await run(["cancel", "goal-1"], () => ({ status: 401, body: { error: "Authentication required" } }));
  assert.equal(denied.exitCode, 1);
  assert.match(denied.stderr, /propr login/);
});

test("goal capabilities lists support and actionable reasons", async () => {
  const result = await run(["capabilities", "--recheck"], () => ({
    body: { agents: [
      { agentId: "codex", agentAlias: "codex", agentType: "codex", goalCapable: true, models: ["model-a"], defaultModel: "model-a" },
      { agentId: "vibe", agentAlias: "vibe", agentType: "vibe", goalCapable: false, reason: "Vibe image is missing session resume", models: [], defaultModel: null },
    ] },
  }));
  assert.equal(result.requests[0].url.searchParams.get("recheck"), "true");
  assert.match(result.stdout, /codex\s+codex\s+supported/);
  assert.match(result.stdout, /vibe: Vibe image is missing session resume/);
  const json = await run(["capabilities", "--json"], () => ({ body: { agents: [] } }));
  assert.deepEqual(JSON.parse(json.stdout), { version: 1, kind: "goal-capabilities", agents: [] });
});
