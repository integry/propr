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
  const pendingControl = { requestGeneration: 3, acknowledgedGeneration: 2, pending: true };
  assert.equal(observedGoalState({ ...base, startedAt: "now", control: pendingControl }), "resuming");
  assert.equal(observedGoalState({ ...base, control: pendingControl }), "starting");
});

test("a resumed goal that ran before stays resuming until the provider acknowledges the control", async () => {
  const awaitingAck = goalFixture({
    pausedAt: null,
    pausedMs: 120_000,
    control: { requestGeneration: 3, acknowledgedGeneration: 2, pending: true },
  });
  const resume = await run(["resume", "goal-1", "--json"], () => ({ body: { goal: awaitingAck } }));
  const resumed = JSON.parse(resume.stdout);
  assert.equal(resumed.confirmed, false);
  assert.equal(resumed.goal.lifecycle.requestedState, "running");
  assert.equal(resumed.goal.lifecycle.observedState, "resuming");
  assert.equal(resumed.goal.lifecycle.controlPending, true);

  const human = await run(["resume", "goal-1"], () => ({ body: { goal: awaitingAck } }));
  assert.match(human.stdout, /Resume requested/);
  assert.match(human.stdout, /State:\s+resuming \(requested: running\)/);
  assert.doesNotMatch(human.stdout, /State:\s+running/);

  const inspect = await run(["inspect", "goal-1", "--json"], () => ({
    body: { goal: awaitingAck, detail: { currentActivity: null, progress: null, pendingInput: null, pullRequests: [] } },
  }));
  assert.equal(JSON.parse(inspect.stdout).goal.lifecycle.observedState, "resuming");

  const acknowledged = await run(["resume", "goal-1", "--json"], () => ({
    body: { goal: goalFixture({ control: { requestGeneration: 3, acknowledgedGeneration: 3, pending: false } }) },
  }));
  const confirmed = JSON.parse(acknowledged.stdout);
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.goal.lifecycle.observedState, "running");
});

test("parser failures with --json print a versioned invalid_arguments goal-error document", async () => {
  for (const [args, command, pattern] of [
    [["inspect", "--json"], "inspect", /missing required argument 'goal-id'/],
    [["model", "goal-1", "--json"], "model", /missing required argument 'model'/],
    [["list", "--json", "--limit"], "list", /option '-l, --limit <limit>' argument missing/],
    [["input", "goal-1", "-j", "--canned"], "input", /option '--canned <request>' argument missing/],
    [["cancel", "goal-1", "--bogus", "--json"], "cancel", /unknown option '--bogus'/],
    [["inputs", "-j", "goal-1", "extra"], "inputs", /too many arguments/],
    [["bogus", "--json"], "goal", /unknown command 'bogus'/],
  ] as Array<[string[], string, RegExp]>) {
    const result = await run(args, () => ({ status: 500 }));
    assert.equal(result.exitCode, 1, args.join(" "));
    assert.equal(result.requests.length, 0);
    assert.equal(result.stderr, "", args.join(" "));
    const output = JSON.parse(result.stdout);
    assert.equal(output.version, 1);
    assert.equal(output.kind, "goal-error");
    assert.equal(output.command, command);
    assert.equal(output.error.code, "invalid_arguments");
    assert.match(output.error.message, pattern);
    assert.doesNotMatch(output.error.message, /^error:/);
  }
});

test("parser failures without --json keep Commander's plain error output", async () => {
  const stderr: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const result = await run(["inspect"], () => ({ status: 500 }));
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.match(stderr.join(""), /^error: missing required argument 'goal-id'/);
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

test("a login refusal after a lost response keeps the recovery key instead of reporting a plain failure", async () => {
  const lostThenRefused = (_request: RecordedRequest, attempt: number) =>
    attempt === 1 ? new TypeError("fetch failed") : { status: 401, body: { error: "Authentication required" } };

  const create = await run(["create", "Do it", "-p", "acme/repo", "-a", "codex", "-m", "model-a"], lostThenRefused);
  assert.equal(create.exitCode, 1);
  assert.equal(create.requests.length, 2);
  const key = create.requests[0].headers["Idempotency-Key"];
  assert.equal(create.requests[1].headers["Idempotency-Key"], key);
  assert.match(create.stderr, /Could not confirm the outcome/);
  assert.match(create.stderr, /propr login/);
  assert.match(create.stderr, new RegExp(`After 'propr login', re-run the same command with --idempotency-key ${key}`));

  const input = await run(["input", "goal-1", "Fix the tests", "--json"], lostThenRefused);
  assert.equal(input.exitCode, 1);
  const output = JSON.parse(input.stdout);
  assert.equal(output.error.code, "outcome_uncertain");
  assert.equal(output.error.status, 401);
  assert.deepEqual(output.error.refusal, { code: "unauthorized", status: 401 });
  assert.equal(output.error.idempotencyKey, input.requests[0].headers["Idempotency-Key"]);
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

test("goal attention lists blockers with the supported command for each action, and inspect shows them", async () => {
  const blocker = {
    id: "blocker-1", goalId: "goal-1", repository: "acme/repo", taskId: "goal-task-1",
    attempt: { generation: 1, claim: "claim-1", sessionId: "thread-1", turnId: "turn-1" },
    category: "question", provider: "codex", summary: "Which database should the migration target?",
    questions: [{ id: "db", header: "Database", question: "Which database should the migration target?", options: ["Postgres"], confidential: false }],
    detection: { kind: "provider_event", source: "codex_app_server:item/tool/requestUserInput" },
    firstObservedAt: "2026-09-05T12:05:00.000Z", lastObservedAt: "2026-09-05T12:05:00.000Z", status: "open",
    actionable: true, responseActions: ["send_input", "pause", "cancel"],
    responseHint: "Send goal input to answer; ProPR delivers it as the reply to this question.",
  };
  const entry = { goalId: "goal-1", repository: "acme/repo", title: "Ship reliable delivery", taskId: "goal-task-1",
    desiredState: "running", waitingForOperator: true, reason: "provider_question", blockers: [blocker] };
  const json = await run(["attention", "-p", "acme/repo", "--limit", "5", "--json"],
    () => ({ body: { goals: [entry], offset: 0, limit: 5, nextOffset: null } }));
  assert.equal(json.exitCode, undefined, json.stdout);
  assert.equal(json.requests[0].url.pathname, "/api/goals/attention");
  assert.deepEqual(Object.fromEntries(json.requests[0].url.searchParams), { repository: "acme/repo", offset: "0", limit: "5" });
  const output = JSON.parse(json.stdout);
  assert.equal(output.kind, "goal-attention");
  assert.deepEqual(output.goals[0].blockers[0].responseActions, ["send_input", "pause", "cancel"]);

  const human = await run(["attention"], () => ({ body: { goals: [entry], offset: 0, limit: 20, nextOffset: null } }));
  assert.match(human.stdout, /asked a question/);
  assert.match(human.stdout, /Which database should the migration target\?/);
  assert.match(human.stdout, /propr goal input goal-1 "<answer>"/);
  assert.match(human.stdout, /propr goal cancel goal-1/);
  assert.doesNotMatch(human.stdout, /approve/i);
  const empty = await run(["attention"], () => ({ body: { goals: [], offset: 0, limit: 20, nextOffset: null } }));
  assert.match(empty.stdout, /No goals are waiting on you/);
  const emptyPage = await run(["attention", "--limit", "1"], () => ({ body: { goals: [], offset: 0, limit: 1, nextOffset: 1 } }));
  assert.doesNotMatch(emptyPage.stdout, /No goals are waiting on you/);
  assert.match(emptyPage.stdout, /No goals on this page are waiting on you/);
  assert.match(emptyPage.stdout, /More goals: --offset 1/);

  const detail = {
    currentActivity: { currentFocus: null, entries: [], order: "newest_first" },
    progress: { tasks: { total: 1, active: 1, completed: 0, failed: 0, cancelled: 0 }, recentTerminalTransitions: [],
      startedAt: null, elapsedSeconds: 1, checkpoint: null },
    pendingInput: { waitingForOperator: true, reason: "provider_question", undeliveredInputs: 0, lastInputAt: null, lastInputDeliveredAt: null },
    pullRequests: [],
  };
  const goal = goalFixture({ attention: { waitingForOperator: true, reason: "provider_question", blockers: [blocker] } });
  const inspected = await run(["inspect", "goal-1", "--json"], () => ({ body: { goal, detail } }));
  assert.deepEqual(JSON.parse(inspected.stdout).goal.attention.blockers[0].id, "blocker-1");
  const inspectedHuman = await run(["inspect", "goal-1"], () => ({ body: { goal, detail } }));
  assert.match(inspectedHuman.stdout, /Waiting:\s+the goal needs you/);
  assert.match(inspectedHuman.stdout, /Which database should the migration target\?/);
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

function waitFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outcome: "timed_out",
    condition: "terminal",
    cursor: "gwc1.first",
    event: null,
    matchedImmediately: false,
    goal: {
      id: "goal-1", repository: "acme/repo", title: "Ship reliable delivery", lifecycleState: "running",
      requestedState: "running", resultState: null, terminal: false, goalCompleted: false, pauseConfirmed: false,
      currentTaskId: "goal-task-1", checkpoint: { count: 0, lastAt: null }, finalPr: null, failureReason: null,
      updatedAt: "2026-10-04T10:00:00.000Z", completedAt: null,
    },
    waitedMs: 30_000,
    timeoutSeconds: 30,
    ...overrides,
  };
}

test("goal wait chains bounded requests with the returned cursor until the condition matches", async () => {
  const completed = waitFixture({
    outcome: "matched", cursor: "gwc1.second",
    event: { cursor: "gwc1.second", sequence: 7, kind: "lifecycle", state: "completed", previousState: "running", checkpoint: null, occurredAt: "2026-10-04T10:01:00.000Z" },
    goal: { ...(waitFixture().goal as Record<string, unknown>), lifecycleState: "completed", resultState: "completed", terminal: true, goalCompleted: true },
  });
  const result = await run(["wait", "goal-1", "--until", "terminal", "--timeout", "120", "--json"],
    (_request, attempt) => ({ body: attempt === 1 ? waitFixture() : completed }));
  assert.equal(result.exitCode, undefined);
  assert.equal(result.requests.length, 2);
  assert.equal(result.requests[0].url.pathname, "/api/goals/goal-1/wait");
  assert.equal(result.requests[0].url.searchParams.get("until"), "terminal");
  assert.equal(result.requests[0].url.searchParams.get("afterCursor"), null, "the first request may match a state that already holds");
  assert.ok(Number(result.requests[0].url.searchParams.get("timeoutSeconds")) <= 30, "each request is bounded");
  assert.equal(result.requests[1].url.searchParams.get("afterCursor"), "gwc1.first", "the cursor carries across requests");
  const output = JSON.parse(result.stdout);
  assert.equal(output.version, 1);
  assert.equal(output.kind, "goal-wait");
  assert.equal(output.outcome, "matched");
  assert.equal(output.cursor, "gwc1.second");
  assert.equal(output.goal.goalCompleted, true);
  assert.equal(output.requests, 2);
  assert.equal(output.exitCode, 0);

  const human = await run(["wait", "goal-1", "--until", "terminal"], () => ({ body: completed }));
  assert.match(human.stdout, /Matched terminal: completed/);
  assert.match(human.stdout, /Cursor: gwc1\.second/);
});

test("goal wait reports timeout and unreachable outcomes with documented nonzero exits", async () => {
  const timedOut = await run(["wait", "goal-1", "--until", "completed", "--after-cursor", "gwc1.start", "--timeout", "0", "--json"],
    () => ({ body: waitFixture({ condition: "completed", timeoutSeconds: 0 }) }));
  assert.equal(timedOut.exitCode, 2);
  assert.equal(timedOut.requests.length, 1, "a zero deadline makes exactly one immediate check");
  assert.equal(timedOut.requests[0].url.searchParams.get("timeoutSeconds"), "0");
  assert.equal(timedOut.requests[0].url.searchParams.get("afterCursor"), "gwc1.start");
  assert.equal(JSON.parse(timedOut.stdout).outcome, "timed_out");

  const human = await run(["wait", "goal-1", "--timeout", "0"], () => ({ body: waitFixture({ condition: null }) }));
  assert.equal(human.exitCode, 2);
  assert.match(human.stdout, /Timed out waiting for a new event\. The goal is running; it has not failed\./);

  const unreachable = await run(["wait", "goal-1", "--until", "paused", "--json"], () => ({
    body: waitFixture({ outcome: "unreachable", condition: "paused",
      goal: { ...(waitFixture().goal as Record<string, unknown>), lifecycleState: "failed", resultState: "failed", terminal: true } }),
  }));
  assert.equal(unreachable.exitCode, 3);
  assert.equal(JSON.parse(unreachable.stdout).exitCode, 3);
});

test("goal wait rejects bad arguments locally and surfaces cursor errors with recovery", async () => {
  for (const args of [["wait", "goal-1", "--until", "done", "--json"], ["wait", "goal-1", "--timeout", "forever", "--json"], ["wait", "goal-1", "--timeout", "100000", "--json"]]) {
    const result = await run(args, () => ({ body: waitFixture() }));
    assert.equal(result.exitCode, 1, args.join(" "));
    assert.equal(result.requests.length, 0);
    assert.equal(JSON.parse(result.stdout).error.code, "invalid_arguments");
  }
  const invalid = await run(["wait", "goal-1", "--after-cursor", "gwc1.other", "--json"], () => ({
    status: 400, body: { error: "afterCursor was issued for a different goal.", code: "CURSOR_WRONG_GOAL", recovery: "Use a cursor returned by a wait on this goal." },
  }));
  assert.equal(invalid.exitCode, 1);
  const error = JSON.parse(invalid.stdout).error;
  assert.equal(error.code, "invalid_cursor");
  assert.match(error.recovery, /without --after-cursor/);
  const expired = await run(["wait", "goal-1", "--after-cursor", "gwc1.old", "--json"], () => ({
    status: 410, body: { error: "afterCursor refers to goal history that is no longer available.", code: "CURSOR_EXPIRED", recovery: "Read the goal." },
  }));
  assert.equal(JSON.parse(expired.stdout).error.code, "cursor_expired");
});

test("goal wait retries a transient failure with the same cursor", async () => {
  const result = await run(["wait", "goal-1", "--until", "terminal", "--after-cursor", "gwc1.keep", "--timeout", "60", "--json"], (_request, attempt) =>
    attempt === 1 ? { status: 503, body: { error: "Service unavailable" } }
      : { body: waitFixture({ outcome: "matched", cursor: "gwc1.next", event: { cursor: "gwc1.next", sequence: 2, kind: "lifecycle", state: "failed", previousState: "running", checkpoint: null, occurredAt: "now" } }) });
  assert.equal(result.exitCode, undefined);
  assert.deepEqual(result.requests.map((request) => request.url.searchParams.get("afterCursor")), ["gwc1.keep", "gwc1.keep"]);
});

test("Ctrl-C stops waiting, releases the request and prints a resumable cursor", async () => {
  const stderr: string[] = [];
  let exitCode: number | undefined;
  let attempts = 0;
  let aborted = false;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    attempts++;
    if (attempts === 1) {
      return new Response(JSON.stringify(waitFixture({ cursor: "gwc1.progress" })), { status: 200, headers: { "content-type": "application/json" } });
    }
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
      setTimeout(() => process.emit("SIGINT"), 10);
    });
  }) as typeof fetch;
  console.log = () => {};
  console.error = (...values: unknown[]) => { stderr.push(values.map(String).join(" ")); };
  process.exit = ((code?: string | number | null) => {
    exitCode = Number(code ?? 0);
    throw new CommandExit(exitCode);
  }) as typeof process.exit;
  const sigintListeners = process.listenerCount("SIGINT");
  try {
    await createGoalCommand().parseAsync(["wait", "goal-1", "--until", "completed", "--timeout", "600"], { from: "user" });
  } catch (error) {
    if (!(error instanceof CommandExit)) throw error;
  }
  assert.equal(exitCode, 130);
  assert.equal(aborted, true, "the in-flight request is aborted");
  assert.equal(attempts, 2, "an interrupted request is never retried");
  assert.match(stderr.join("\n"), /Stopped waiting\. The goal is unaffected\./);
  assert.match(stderr.join("\n"), /--until completed --after-cursor gwc1\.progress/);
  assert.equal(process.listenerCount("SIGINT"), sigintListeners, "the SIGINT handler is removed");
});
