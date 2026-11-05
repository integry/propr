import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GoalMutationUncertainError,
  GoalWaitBoundaryError,
  createGoal,
  listGoalInputs,
  listGoals,
  pauseGoal,
  resolveIdempotencyKey,
  sendGoalInput,
  setGoalModel,
  waitGoalUntil,
} from "./goals.js";
import { ApiClient } from "./client.js";
import { ApiError, NetworkError, RequestCancelledError } from "./errors.js";
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

test("an access refusal after an unconfirmed attempt keeps the outcome uncertain with the same key", async () => {
  // Each mutation loses its first response, then the retry is refused because the login expired.
  const { client, requests, restore } = clientWith((_request, attempt) =>
    attempt % 2 === 1 ? new TypeError("socket hang up") : { status: 401, body: { error: "Authentication required" } });
  try {
    const mutations = [
      { key: "create-key-6", run: () => createGoal(createRequest, "create-key-6", { client, retryDelayMs: 0 }) },
      { key: "input-key-4", run: () => sendGoalInput("goal-1", { message: "Fix it" }, "input-key-4", { client, retryDelayMs: 0 }) },
    ];
    for (const mutation of mutations) {
      await assert.rejects(mutation.run(), (error) => {
        assert.ok(error instanceof GoalMutationUncertainError);
        assert.equal(error.idempotencyKey, mutation.key);
        assert.equal(error.attempts, 2);
        assert.ok(error.cause instanceof NetworkError);
        assert.ok(error.refusal instanceof ApiError);
        assert.equal(error.refusal.status, 401);
        assert.match(error.message, /refused \(401\)/);
        return true;
      });
    }
    assert.deepEqual(requests.map((request) => request.headers["Idempotency-Key"]),
      ["create-key-6", "create-key-6", "input-key-4", "input-key-4"]);
  } finally {
    restore();
  }
});

test("an access refusal on the first attempt stays definitive", async () => {
  const { client, requests, restore } = clientWith(() => ({ status: 403, body: { error: "Forbidden" } }));
  try {
    await assert.rejects(sendGoalInput("goal-1", { message: "Fix it" }, "input-key-5", { client, retryDelayMs: 0 }), (error) => {
      assert.ok(error instanceof ApiError && !(error instanceof GoalMutationUncertainError));
      assert.equal(error.status, 403);
      return true;
    });
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

/** A client whose responder may also leave a request hanging until it is aborted. */
function waitClient(responder: (url: URL, attempt: number) => { status?: number; body?: unknown } | Error | "hang") {
  const requests: URL[] = [];
  const aborted: number[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url);
    const attempt = requests.length;
    const result = responder(url, attempt);
    if (result === "hang") {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted.push(attempt);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const configManager = { getRemoteUrl: () => "http://propr.test", getGithubToken: () => "token" } as unknown as ConfigManager;
  return { client: new ApiClient(configManager), requests, aborted, restore: () => { globalThis.fetch = originalFetch; } };
}

const waitGoal = {
  id: "goal-1", repository: "acme/repo", title: null, lifecycleState: "running", requestedState: "running", resultState: null,
  terminal: false, goalCompleted: false, pauseConfirmed: false, currentTaskId: null, checkpoint: { count: 0, lastAt: null },
  finalPr: null, failureReason: null, updatedAt: null, completedAt: null,
};
const waitResponse = (overrides: Record<string, unknown> = {}) => ({
  outcome: "timed_out", condition: "checkpoint", cursor: "gwc1.base", event: null, matchedImmediately: false,
  goal: waitGoal, waitedMs: 0, timeoutSeconds: 0, ...overrides,
});
const checkpointMatch = waitResponse({
  outcome: "matched", cursor: "gwc1.checkpoint",
  event: { cursor: "gwc1.checkpoint", sequence: 9, kind: "checkpoint", state: null, previousState: null, checkpoint: null, occurredAt: "now" },
});

test("waitGoalUntil stops at the deadline while a request is unanswered and reports a timeout with the last cursor", async () => {
  const { client, requests, aborted, restore } = waitClient(() => "hang");
  const started = Date.now();
  try {
    const result = await waitGoalUntil("goal-1", { until: "checkpoint", afterCursor: "gwc1.keep", deadline: Date.now() + 100 },
      { client, replyGraceMs: 50 });
    assert.ok(Date.now() - started < 1_000, "the unanswered request is abandoned at the deadline, not after its HTTP timeout");
    assert.equal(result.outcome, "timed_out");
    assert.equal(result.cursor, "gwc1.keep");
    assert.equal(result.goal, null, "no request completed, so there is no goal projection");
    assert.equal(result.event, null);
    assert.deepEqual(aborted, [1], "the in-flight request is aborted");
    assert.equal(requests.length, 1);
  } finally {
    restore();
  }
});

test("waitGoalUntil's deadline also interrupts HTTP and wait-chain retry delays", async () => {
  const network = waitClient(() => new TypeError("fetch failed"));
  let started = Date.now();
  try {
    const result = await waitGoalUntil("goal-1", { afterCursor: "gwc1.keep", deadline: Date.now() + 100 }, { client: network.client, replyGraceMs: 50 });
    assert.equal(result.outcome, "timed_out");
    assert.equal(result.cursor, "gwc1.keep");
    assert.ok(Date.now() - started < 500, "the HTTP client's retry backoff is abandoned at the deadline");
  } finally {
    network.restore();
  }

  const gateway = waitClient((_url, attempt) => attempt === 1 ? { body: waitResponse({ cursor: "gwc1.progress" }) } : { status: 503, body: {} });
  started = Date.now();
  try {
    const result = await waitGoalUntil("goal-1", { afterCursor: "gwc1.keep", deadline: Date.now() + 150 },
      { client: gateway.client, replyGraceMs: 50, retryDelayMs: 60_000 });
    assert.equal(result.outcome, "timed_out");
    assert.equal(result.cursor, "gwc1.progress", "the last cursor the server returned is kept");
    assert.equal(result.goal?.lifecycleState, "running", "the last projection is kept when one was received");
    assert.ok(Date.now() - started < 1_000);
  } finally {
    gateway.restore();
  }
});

test("Ctrl-C during a wait-chain retry delay stops at once and is distinguished from the deadline", async () => {
  const { client, requests, restore } = waitClient(() => ({ status: 503, body: {} }));
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 30);
  try {
    await assert.rejects(
      waitGoalUntil("goal-1", { afterCursor: "gwc1.keep", deadline: Date.now() + 60_000 }, { client, signal: controller.signal, retryDelayMs: 60_000 }),
      RequestCancelledError,
    );
    assert.ok(Date.now() - started < 1_000, "the backoff does not delay interruption");
    assert.equal(requests.length, 1, "no request follows the interruption");
  } finally {
    restore();
  }
});

test("without a cursor, a non-blocking baseline request fixes the boundary every blocking retry keeps", async () => {
  // Attempt 1 is the baseline. The first blocking reply is lost three times
  // (exhausting the HTTP client's retries), then the wait-chain retry succeeds.
  const { client, requests, restore } = waitClient((_url, attempt) => {
    if (attempt === 1) return { body: waitResponse() };
    if (attempt <= 4) return new TypeError("socket hang up");
    return { body: checkpointMatch };
  });
  const cursors: string[] = [];
  try {
    const result = await waitGoalUntil("goal-1", { until: "checkpoint", deadline: Date.now() + 60_000 },
      { client, retryDelayMs: 1, onCursor: (cursor) => cursors.push(cursor) });
    assert.equal(result.outcome, "matched");
    assert.equal(result.cursor, "gwc1.checkpoint");
    assert.equal(requests[0].searchParams.get("afterCursor"), null);
    assert.equal(requests[0].searchParams.get("timeoutSeconds"), "0", "the cursorless request never blocks");
    assert.deepEqual(requests.slice(1).map((url) => url.searchParams.get("afterCursor")), ["gwc1.base", "gwc1.base", "gwc1.base", "gwc1.base"],
      "every blocking attempt, including HTTP and wait-chain retries, keeps the baseline cursor");
    assert.ok(requests.slice(1).every((url) => Number(url.searchParams.get("timeoutSeconds")) > 0));
    assert.deepEqual(cursors, ["gwc1.base", "gwc1.checkpoint"]);
  } finally {
    restore();
  }
});

test("a lost baseline reply is never retried, so a checkpoint published meanwhile cannot be skipped", async () => {
  // The server fixed boundary A, but its reply was lost. A checkpoint is then
  // published, so any second cursorless request would be answered with a later
  // boundary that already hides it. Neither retry layer may send that request.
  for (const lost of [new TypeError("socket hang up"), { status: 504, body: {} }]) {
    const { client, requests, restore } = waitClient((_url, attempt) =>
      attempt === 1 ? lost : { body: waitResponse({ cursor: "gwc1.after-checkpoint" }) });
    const cursors: string[] = [];
    try {
      await assert.rejects(
        waitGoalUntil("goal-1", { until: "checkpoint", deadline: Date.now() + 60_000 },
          { client, retryDelayMs: 1, onCursor: (cursor) => cursors.push(cursor) }),
        (error: unknown) => {
          assert.ok(error instanceof GoalWaitBoundaryError);
          assert.match(error.message, /Could not establish where this wait starts/);
          assert.ok(error.cause instanceof ApiError, "the transport failure is kept as the cause");
          return true;
        },
      );
      assert.equal(requests.length, 1, "the cursorless request is sent exactly once across both retry layers");
      assert.equal(requests[0].searchParams.get("afterCursor"), null);
      assert.deepEqual(cursors, [], "no later boundary is adopted");
    } finally {
      restore();
    }
  }
});

test("a cursorless wait abandoned at the deadline still reports a timeout without a cursor", async () => {
  const { client, requests, restore } = waitClient(() => "hang");
  try {
    const result = await waitGoalUntil("goal-1", { until: "checkpoint", deadline: Date.now() + 50 }, { client, replyGraceMs: 20 });
    assert.equal(result.outcome, "timed_out");
    assert.equal(result.cursor, null, "no boundary is claimed");
    assert.equal(requests.length, 1);
  } finally {
    restore();
  }
});
