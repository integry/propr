import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveAutomationRun,
  cancelAutomationRun,
  getAutomationRun,
  listAutomationRuns,
  listAutomations,
  rejectAutomationRun,
  triggerAutomationRun,
} from "./automations.js";
import { GoalMutationUncertainError } from "./goals.js";
import { ApiClient } from "./client.js";
import { NetworkError } from "./errors.js";
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

const run = { id: "run-1", definitionId: "agent-1", state: "queued", report: null };

test("triggerAutomationRun sends the Idempotency-Key and a cli trigger with the source", async () => {
  const { client, requests, restore } = clientWith(() => ({ status: 202, body: { run, created: true } }));
  try {
    const result = await triggerAutomationRun("agent-1", { idempotencyKey: "abc12345", source: "github-actions" }, { client });
    assert.equal(result.created, true);
    assert.equal(result.run.id, "run-1");
    assert.equal(result.idempotencyKey, "abc12345");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url.pathname, "/api/agent-definitions/agent-1/runs");
    assert.equal(requests[0].headers["Idempotency-Key"], "abc12345");
    assert.deepEqual(requests[0].body, { trigger: "cli", source: "github-actions" });
  } finally {
    restore();
  }
});

test("triggerAutomationRun omits an absent source and reports a replay as created: false", async () => {
  const { client, requests, restore } = clientWith(() => ({ status: 200, body: { run, created: false } }));
  try {
    const result = await triggerAutomationRun("agent-1", { idempotencyKey: "abc12345" }, { client });
    assert.equal(result.created, false);
    assert.deepEqual(requests[0].body, { trigger: "cli" });
  } finally {
    restore();
  }
});

test("triggerAutomationRun retries transient failures with the same key", async () => {
  const { client, requests, restore } = clientWith((_request, attempt) =>
    attempt === 1 ? new NetworkError("socket hang up")
      : attempt === 2 ? { status: 503, body: { error: "unavailable" } }
        : { status: 200, body: { run, created: false } });
  try {
    const result = await triggerAutomationRun("agent-1", { idempotencyKey: "retry-key-1" }, { client, retryDelayMs: 0 });
    assert.equal(result.attempts, 3);
    assert.equal(result.created, false);
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map((request) => request.headers["Idempotency-Key"]), ["retry-key-1", "retry-key-1", "retry-key-1"]);
  } finally {
    restore();
  }
});

test("triggerAutomationRun surfaces exhausted retries as uncertain with the key", async () => {
  const { client, restore } = clientWith(() => new NetworkError("offline"));
  try {
    await assert.rejects(
      triggerAutomationRun("agent-1", { idempotencyKey: "lost-key-1" }, { client, retryDelayMs: 0 }),
      (error: unknown) => error instanceof GoalMutationUncertainError && error.idempotencyKey === "lost-key-1" && error.attempts === 3,
    );
  } finally {
    restore();
  }
});

test("list, runs and run reads use the agent definition and run endpoints", async () => {
  const { client, requests, restore } = clientWith((request) => {
    if (request.url.pathname === "/api/agent-definitions") return { body: { definitions: [{ id: "agent-1" }], total: 1, limit: 50, offset: 0 } };
    if (request.url.pathname.endsWith("/runs")) return { body: { runs: [run], total: 1, limit: 5, offset: 0 } };
    return { body: { run: { ...run, report: "# Report" } } };
  });
  try {
    const page = await listAutomations({}, { client });
    assert.deepEqual(page.automations.map((item) => item.id), ["agent-1"]);
    const runs = await listAutomationRuns("agent 1", { limit: 5 }, { client });
    assert.equal(runs.runs.length, 1);
    assert.equal(requests[1].url.pathname, "/api/agent-definitions/agent%201/runs");
    assert.equal(requests[1].url.searchParams.get("limit"), "5");
    const detail = await getAutomationRun("run-1", { client });
    assert.equal(detail.report, "# Report");
    assert.equal(requests[2].url.pathname, "/api/agent-runs/run-1");
  } finally {
    restore();
  }
});

test("approve, reject and cancel post once to the run action endpoints", async () => {
  const { client, requests, restore } = clientWith(() => ({ body: { run: { ...run, state: "acting" } } }));
  try {
    await approveAutomationRun("run-1", { note: "Only the top finding" }, { client });
    await rejectAutomationRun("run-1", { client });
    await cancelAutomationRun("run-1", { client });
    assert.deepEqual(requests.map((request) => `${request.method} ${request.url.pathname}`), [
      "POST /api/agent-runs/run-1/approve",
      "POST /api/agent-runs/run-1/reject",
      "POST /api/agent-runs/run-1/cancel",
    ]);
    assert.deepEqual(requests[0].body, { note: "Only the top finding" });
    assert.deepEqual(requests[1].body, {});
  } finally {
    restore();
  }
});
