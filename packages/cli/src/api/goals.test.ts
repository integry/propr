import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GoalMutationUncertainError,
  createGoal,
  listGoalInputs,
  listGoals,
  pauseGoal,
  resolveIdempotencyKey,
  sendGoalInput,
  setGoalModel,
} from "./goals.js";
import { ApiClient } from "./client.js";
import { ApiError, NetworkError } from "./errors.js";
import type { ConfigManager } from "../config/index.js";

interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = (request: RecordedRequest, attempt: number) => { status?: number; body?: unknown } | Error;

function clientWith(responder: Responder): { client: ApiClient; requests: RecordedRequest[]; restore: () => void } {
  const requests: RecordedRequest[] = [];
  const originalFetch = globalThis.fetch;
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
  const configManager = { getRemoteUrl: () => "http://propr.test", getGithubToken: () => "token" } as unknown as ConfigManager;
  return { client: new ApiClient(configManager), requests, restore: () => { globalThis.fetch = originalFetch; } };
}

const goal = { id: "goal-1", desiredState: "running", resultState: null };
const createRequest = {
  repository: "acme/repo", objective: "Ship it", agentId: "codex", model: "model-a", launchStrategy: "direct" as const,
};

test("idempotency keys are validated and generated when omitted", () => {
  assert.match(resolveIdempotencyKey(undefined), /^cli-[0-9a-f-]{36}$/);
  assert.notEqual(resolveIdempotencyKey(undefined), resolveIdempotencyKey(undefined));
  assert.equal(resolveIdempotencyKey("my-key.0001"), "my-key.0001");
  assert.throws(() => resolveIdempotencyKey("short"), /8-128 characters/);
  assert.throws(() => resolveIdempotencyKey("has spaces in it"), /8-128 characters/);
});

test("createGoal maps the request body and Idempotency-Key and reports a fresh creation", async () => {
  const { client, requests, restore } = clientWith(() => ({ status: 201, body: { goal } }));
  try {
    const result = await createGoal({ ...createRequest, maxParallelTasks: 3, ultrafix: true }, "create-key-1", { client });
    assert.equal(result.outcome, "created");
    assert.equal(result.goalId, "goal-1");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url.pathname, "/api/goals");
    assert.equal(requests[0].headers["Idempotency-Key"], "create-key-1");
    assert.deepEqual(requests[0].body, { ...createRequest, maxParallelTasks: 3, ultrafix: true });
  } finally {
    restore();
  }
});

test("createGoal retries transient failures with the same key and reports a replay", async () => {
  const { client, requests, restore } = clientWith((_request, attempt) =>
    attempt === 1 ? new TypeError("fetch failed") : attempt === 2 ? { status: 502 } : { status: 200, body: { goal } });
  try {
    const result = await createGoal(createRequest, "create-key-2", { client, retryDelayMs: 0 });
    assert.equal(result.outcome, "replayed");
    assert.equal(result.attempts, 3);
    assert.deepEqual(requests.map((request) => request.headers["Idempotency-Key"]),
      ["create-key-2", "create-key-2", "create-key-2"]);
    assert.ok(requests.every((request) => JSON.stringify(request.body) === JSON.stringify(createRequest)));
  } finally {
    restore();
  }
});

test("createGoal surfaces an uncertain outcome with the recovery key after exhausting retries", async () => {
  const { client, requests, restore } = clientWith(() => new TypeError("socket hang up"));
  try {
    await assert.rejects(createGoal(createRequest, "create-key-3", { client, attempts: 2, retryDelayMs: 0 }), (error) => {
      assert.ok(error instanceof GoalMutationUncertainError);
      assert.equal(error.idempotencyKey, "create-key-3");
      assert.equal(error.attempts, 2);
      assert.ok(error.cause instanceof NetworkError);
      return true;
    });
    assert.equal(requests.length, 2);
  } finally {
    restore();
  }
});

test("createGoal treats a 503 with a goal ID as saved and never retries it", async () => {
  const { client, requests, restore } = clientWith(() => ({
    status: 503, body: { error: "Goal was saved but its first attempt could not be queued", goalId: "goal-9" },
  }));
  try {
    const result = await createGoal(createRequest, "create-key-4", { client, retryDelayMs: 0 });
    assert.equal(result.outcome, "saved_queue_pending");
    assert.equal(result.goalId, "goal-9");
    assert.equal(result.goal, null);
    assert.equal(requests.length, 1);
  } finally {
    restore();
  }
});

test("definitive answers are not retried: validation and idempotency conflicts surface unchanged", async () => {
  const { client, requests, restore } = clientWith((request) => request.url.pathname === "/api/goals"
    ? { status: 400, body: { error: "Selected model is not supported by this agent" } }
    : { status: 409, body: { error: "Idempotency-Key was already used for a different goal, operation, or payload" } });
  try {
    await assert.rejects(createGoal(createRequest, "create-key-5", { client, retryDelayMs: 0 }), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 400);
      assert.match(error.message, /not supported/);
      return true;
    });
    await assert.rejects(sendGoalInput("goal-1", { message: "Other text" }, "input-key-1", { client, retryDelayMs: 0 }), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 409);
      return true;
    });
    assert.equal(requests.length, 2);
  } finally {
    restore();
  }
});

test("a server error after a mutation is reported as uncertain rather than as a failure", async () => {
  const { client, requests, restore } = clientWith(() => ({ status: 500, body: { error: "boom" } }));
  try {
    await assert.rejects(pauseGoal("goal-1", "pause-key-1", { client, retryDelayMs: 0 }), GoalMutationUncertainError);
    assert.equal(requests.length, 1);
  } finally {
    restore();
  }
});

test("lifecycle mutations use the goal endpoints with encoded IDs and the caller key", async () => {
  const { client, requests, restore } = clientWith(() => ({ body: { goal } }));
  try {
    await sendGoalInput("goal/1", { message: "Fix the tests" }, "input-key-2", { client });
    await sendGoalInput("goal-1", { canned: "left" }, "input-key-3", { client });
    await setGoalModel("goal-1", "model-b", "model-key-1", { client });
    assert.deepEqual(requests.map((request) => [request.method, request.url.pathname, request.headers["Idempotency-Key"], request.body]), [
      ["POST", "/api/goals/goal%2F1/input", "input-key-2", { message: "Fix the tests" }],
      ["POST", "/api/goals/goal-1/input", "input-key-3", { canned: "left" }],
      ["PATCH", "/api/goals/goal-1/model", "model-key-1", { model: "model-b" }],
    ]);
  } finally {
    restore();
  }
});

test("list and input history requests carry filters and bounded pages", async () => {
  const { client, requests, restore } = clientWith((request) => request.url.pathname === "/api/goals"
    ? { body: { goals: [goal], offset: 20, limit: 10, nextOffset: 30 } }
    : { body: { inputs: [], order: "newest_first", nextOffset: null } });
  try {
    const page = await listGoals({ repository: "acme/repo", state: "paused", offset: 20, limit: 10 }, { client });
    assert.equal(page.nextOffset, 30);
    await listGoals({ state: "all" }, { client });
    const inputs = await listGoalInputs("goal-1", { offset: 5, limit: 5 }, { client });
    assert.equal(inputs.nextOffset, null);
    assert.equal(inputs.offset, 5);
    assert.deepEqual(Object.fromEntries(requests[0].url.searchParams), { repository: "acme/repo", state: "paused", offset: "20", limit: "10" });
    assert.deepEqual(Object.fromEntries(requests[1].url.searchParams), { offset: "0", limit: "20" });
    assert.equal(requests[2].url.pathname, "/api/goals/goal-1/inputs");
    assert.deepEqual(Object.fromEntries(requests[2].url.searchParams), { offset: "5", limit: "5" });
  } finally {
    restore();
  }
});
