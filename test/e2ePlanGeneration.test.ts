import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiClient } from "../packages/cli/src/api/client.js";
import type { ConfigManager } from "../packages/cli/src/config/index.js";
import type { PlanIssue } from "../packages/cli/src/api/plans.js";
import {
  PLAN_GENERATION_TIMEOUT_MS,
  PLAN_ISSUES_TIMEOUT_MS,
  PLAN_REQUEST_TIMEOUT_MS,
  PLAN_RETRY_MIN_REMAINING_MS,
  PLAN_SUITE_CLEANUP_MS,
  PLAN_TEST_BUDGET_MS,
  PLAN_TEST_TIMEOUT_MS,
  PlanDeadlineError,
  PlanWorkTracker,
  abortableSleep,
  createAndGeneratePlan,
  createPlanWithRetries,
  parseJobDeadline,
  planDeadline,
  type PlanApi,
  type PlanRequest,
} from "./e2e/planGeneration.js";

const client = {} as ApiClient;
// Duration of the successful brownfield generation that the former 600s
// polling window (and 600s suite timeout) cancelled on the nightly server.
const OBSERVED_SLOW_GENERATION_MS = 621_117;

/** A virtual clock whose sleeps advance time and honour abort signals. */
function virtualClock() {
  let time = 0;
  return {
    now: () => time,
    advance: (ms: number) => { time += ms; },
    sleep: async (ms: number, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      time += ms;
      await Promise.resolve();
      signal?.throwIfAborted();
    },
  };
}

interface FakePlanServer {
  api: PlanApi;
  calls: string[];
  created: string[];
  requests: PlanRequest[];
}

/**
 * A planner that reaches review `generationMs` after generation starts (or
 * fails when `failGeneration` is set) and creates one issue per plan entry on
 * finalization.
 */
function fakePlanServer(
  clock: ReturnType<typeof virtualClock>,
  { generationMs, failGeneration = false, onGetPlan, latency = () => 0 }: {
    generationMs: number;
    failGeneration?: boolean;
    onGetPlan?: (count: number) => void;
    /** Virtual time a request spends in flight before it answers. */
    latency?: (call: string) => number;
  },
): FakePlanServer {
  const calls: string[] = [];
  const created: string[] = [];
  const requests: PlanRequest[] = [];
  const respond = (call: string, request: PlanRequest) => {
    calls.push(call);
    requests.push(request);
    clock.advance(latency(call));
  };
  const startedAt = new Map<string, number>();
  const finalized = new Set<string>();
  let getPlanCount = 0;
  const api: PlanApi = {
    async createPlan(_repo, _prompt, _client, request) {
      const id = `plan-${created.length + 1}-0000`;
      created.push(id);
      respond(`create:${id}`, request);
      return { draft_id: id };
    },
    async generatePlan(id, _client, request) {
      startedAt.set(id, clock.now());
      respond(`generate:${id}`, request);
    },
    async getPlan(id, _client, request) {
      respond(`get:${id}`, request);
      onGetPlan?.(++getPlanCount);
      const elapsed = clock.now() - startedAt.get(id)!;
      const plan_json = [{}, {}];
      if (finalized.has(id)) return { status: "approved", plan_json, generation_trace: {} };
      if (failGeneration) return { status: "failed", plan_json: [], generation_trace: { error: "Plan generation failed." } };
      return { status: elapsed >= generationMs ? "review" : "generating", plan_json, generation_trace: {} };
    },
    async finalizePlan(id, _client, request) {
      respond(`finalize:${id}`, request);
      finalized.add(id);
    },
    async listPlanIssues(id, _client, request) {
      respond(`issues:${id}`, request);
      return finalized.has(id) ? ([{ issue_number: 1 }, { issue_number: 2 }] as unknown as PlanIssue[]) : [];
    },
  };
  return { api, calls, created, requests };
}

describe("E2E plan generation budget", () => {
  test("the plan budget exceeds the observed slow generation and fits inside its test timeout", () => {
    assert.ok(PLAN_GENERATION_TIMEOUT_MS > OBSERVED_SLOW_GENERATION_MS);
    assert.ok(PLAN_TEST_BUDGET_MS >= PLAN_GENERATION_TIMEOUT_MS + PLAN_ISSUES_TIMEOUT_MS);
    assert.equal(PLAN_TEST_TIMEOUT_MS, PLAN_TEST_BUDGET_MS + PLAN_SUITE_CLEANUP_MS);
  });

  test("the job deadline caps a test budget", () => {
    assert.equal(planDeadline(1_000, undefined, 10), 1_010);
    assert.equal(planDeadline(1_000, 500, 10), 500);
    assert.equal(parseJobDeadline(undefined), undefined);
    assert.equal(parseJobDeadline("soon"), undefined);
    assert.equal(parseJobDeadline("1760000000000"), 1_760_000_000_000);
  });
});

describe("E2E plan creation", () => {
  test("a successful generation slower than the former 600s window is finalized and yields its issues", async () => {
    const clock = virtualClock();
    const server = fakePlanServer(clock, { generationMs: OBSERVED_SLOW_GENERATION_MS });
    const createdPlanIds: string[] = [];

    const result = await createPlanWithRetries("repo", "Brownfield", "prompt", client, createdPlanIds, {
      api: server.api, now: clock.now, sleep: clock.sleep, log: () => {}, deadline: PLAN_TEST_BUDGET_MS,
    });

    assert.equal(result.issues.length, 2);
    assert.deepEqual(createdPlanIds, ["plan-1-0000"]);
    assert.ok(server.calls.includes("finalize:plan-1-0000"));
    assert.ok(clock.now() > 600_000, "generation finished after the former polling window");
    assert.ok(clock.now() < PLAN_TEST_BUDGET_MS);
  });

  test("a generation that never reaches review fails at its deadline instead of returning no issues", async () => {
    const clock = virtualClock();
    const server = fakePlanServer(clock, { generationMs: Number.POSITIVE_INFINITY });
    const createdPlanIds: string[] = [];

    await assert.rejects(
      createPlanWithRetries("repo", "Brownfield", "prompt", client, createdPlanIds, {
        api: server.api, now: clock.now, sleep: clock.sleep, log: () => {}, deadline: PLAN_TEST_BUDGET_MS,
      }),
      (error: unknown) => error instanceof PlanDeadlineError && /still generating/.test(error.message),
    );
    assert.equal(server.created.length, 1, "no further plan is created after the deadline");
    assert.ok(!server.calls.some((call) => call.startsWith("finalize:")));
    assert.ok(clock.now() <= PLAN_TEST_BUDGET_MS - PLAN_ISSUES_TIMEOUT_MS);
  });

  test("a quick generation failure is retried only while a full attempt still fits", async () => {
    const clock = virtualClock();
    const server = fakePlanServer(clock, { generationMs: 0, failGeneration: true });
    const logs: string[] = [];
    // Each failed attempt takes one 5s poll: the second still fits, the third does not.
    const deadline = PLAN_RETRY_MIN_REMAINING_MS + 7_000;

    const result = await createPlanWithRetries("repo", "Brownfield", "prompt", client, [], {
      api: server.api, now: clock.now, sleep: clock.sleep, log: (line) => logs.push(line), deadline, attempts: 3,
    });

    assert.equal(result.issues.length, 0);
    assert.equal(server.created.length, 2);
    assert.ok(logs.some((line) => /not starting attempt/.test(line)));
  });

  test("cancellation stops polling and prevents any further retry or plan creation", async () => {
    const clock = virtualClock();
    const controller = new AbortController();
    const server = fakePlanServer(clock, {
      generationMs: Number.POSITIVE_INFINITY,
      // The enclosing suite times out while the first plan is still generating.
      onGetPlan: (count) => { if (count === 3) controller.abort(new Error("suite timed out")); },
    });
    const createdPlanIds: string[] = [];

    await assert.rejects(
      createPlanWithRetries("repo", "Brownfield", "prompt", client, createdPlanIds, {
        api: server.api, now: clock.now, sleep: clock.sleep, log: () => {}, signal: controller.signal,
        deadline: PLAN_TEST_BUDGET_MS,
      }),
      /suite timed out/,
    );
    const callsAtCancellation = server.calls.length;
    // Let any stray continuation run, as the next suite would.
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));

    assert.equal(server.calls.length, callsAtCancellation);
    assert.deepEqual(server.created, ["plan-1-0000"]);
    assert.deepEqual(createdPlanIds, ["plan-1-0000"], "the created plan is still recorded for cleanup");
    assert.equal(server.calls.filter((call) => call.startsWith("get:")).length, 3);
    assert.ok(!server.calls.some((call) => call.startsWith("finalize:")));
  });

  test("an already cancelled test creates no plan", async () => {
    const clock = virtualClock();
    const server = fakePlanServer(clock, { generationMs: 0 });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await assert.rejects(
      createAndGeneratePlan("repo", "prompt", client, [], {
        api: server.api, now: clock.now, sleep: clock.sleep, signal: controller.signal, deadline: PLAN_TEST_BUDGET_MS,
      }),
      /cancelled/,
    );
    assert.deepEqual(server.calls, []);
  });

  test("an elapsed job deadline creates no plan", async () => {
    const clock = virtualClock();
    clock.advance(10);
    const server = fakePlanServer(clock, { generationMs: 0 });

    await assert.rejects(
      createAndGeneratePlan("repo", "prompt", client, [], {
        api: server.api, now: clock.now, sleep: clock.sleep, deadline: 10,
      }),
      PlanDeadlineError,
    );
    assert.deepEqual(server.calls, []);
  });
});

describe("E2E plan request boundaries", () => {
  // Generation reports generating at the 5s poll and review at the 10s poll;
  // the deadline leaves 120s after that for the issue wait. Each case makes
  // one request answer only after the deadline.
  const GENERATION_MS = 7_000;
  const DEADLINE = 130_000;
  for (const [step, prefix, before] of [
    ["the status poll that reports review", "get:", []],
    ["finalization", "finalize:", ["create", "generate", "get"]],
    ["the issue listing", "issues:", ["create", "generate", "get", "finalize"]],
  ] as const) {
    test(`a response to ${step} that arrives after the deadline is not accepted`, async () => {
      const clock = virtualClock();
      let late = false;
      const server = fakePlanServer(clock, {
        generationMs: GENERATION_MS,
        // The slow request starts before the deadline and answers at 131s.
        latency: (call) => {
          if (late || !call.startsWith(prefix) || clock.now() < GENERATION_MS) return 0;
          late = true;
          return DEADLINE + 1_000 - clock.now();
        },
      });
      const createdPlanIds: string[] = [];

      await assert.rejects(
        createAndGeneratePlan("repo", "prompt", client, createdPlanIds, {
          api: server.api, now: clock.now, sleep: clock.sleep, log: () => {}, deadline: DEADLINE,
        }),
        (error: unknown) => error instanceof PlanDeadlineError && /E2E deadline/.test(error.message),
      );
      assert.ok(late, "the slow request was made");
      assert.equal(clock.now(), DEADLINE + 1_000);
      // Nothing is requested once the late response arrives.
      assert.ok(server.calls.at(-1)!.startsWith(prefix), `last call: ${server.calls.at(-1)}`);
      for (const call of before) assert.ok(server.calls.some((made) => made.startsWith(`${call}:`)));
      if (prefix === "get:") assert.ok(!server.calls.some((call) => call.startsWith("finalize:")));
      assert.deepEqual(createdPlanIds, ["plan-1-0000"]);
    });
  }

  test("every request carries the operation's signal and a timeout capped by the remaining deadline", async () => {
    const clock = virtualClock();
    const controller = new AbortController();
    // Finalization answers 20s before the deadline, so the reads after it get
    // shortened timeouts.
    const server = fakePlanServer(clock, {
      generationMs: 7_000,
      latency: (call) => (call.startsWith("finalize:") ? 110_000 - clock.now() : 0),
    });
    let signalsDuringRun: boolean[] = [];
    const api: PlanApi = {
      ...server.api,
      listPlanIssues: async (id, plannerClient, request) => {
        const issues = await server.api.listPlanIssues(id, plannerClient, request);
        // Cancelling the test now must reach the requests already made.
        controller.abort(new Error("cancelled"));
        signalsDuringRun = server.requests.map((made) => made.signal.aborted);
        return issues;
      },
    };

    await assert.rejects(
      createAndGeneratePlan("repo", "prompt", client, [], {
        api, now: clock.now, sleep: clock.sleep, log: () => {}, signal: controller.signal, deadline: 130_000,
      }),
      /cancelled/,
      "a response that arrives after cancellation is not accepted",
    );

    assert.equal(server.requests[0].timeout, PLAN_REQUEST_TIMEOUT_MS);
    assert.equal(server.requests.at(-1)!.timeout, 20_000);
    assert.ok(server.requests.every((request) => request.timeout > 0 && request.timeout <= PLAN_REQUEST_TIMEOUT_MS));
    assert.ok(signalsDuringRun.length >= 6 && signalsDuringRun.every(Boolean), "cancellation reaches every request");
  });

  test("cancellation interrupts a pending request without waiting for it", async () => {
    const clock = virtualClock();
    const controller = new AbortController();
    const tracker = new PlanWorkTracker();
    const server = fakePlanServer(clock, { generationMs: 0 });
    let release!: () => void;
    let generateRequest: PlanRequest | undefined;
    const api: PlanApi = {
      ...server.api,
      // A generation request that ignores its signal and hangs until released.
      generatePlan: (id, plannerClient, request) => {
        generateRequest = request;
        return new Promise<void>((resolve) => { release = resolve; })
          .then(() => server.api.generatePlan(id, plannerClient, request));
      },
    };
    const createdPlanIds: string[] = [];

    const pending = createAndGeneratePlan("repo", "prompt", client, createdPlanIds, {
      api, now: clock.now, sleep: clock.sleep, log: () => {}, signal: controller.signal, deadline: PLAN_TEST_BUDGET_MS, tracker,
    });
    while (!generateRequest) await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("suite timed out"));

    // The helper rejects while the request is still pending.
    await assert.rejects(pending, /suite timed out/);
    assert.equal(generateRequest.signal.aborted, true, "the pending request was asked to abort");
    assert.equal(tracker.size, 1, "the abandoned request is still tracked");
    assert.equal(await tracker.settle(5), false, "cleanup keeps waiting while the request is in flight");

    const callsBeforeRelease = server.calls.length;
    release();
    assert.equal(await tracker.settle(1_000), true);
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    // Only the released request itself completes; nothing follows it.
    assert.deepEqual(server.calls.slice(callsBeforeRelease), ["generate:plan-1-0000"]);
    assert.deepEqual(createdPlanIds, ["plan-1-0000"]);
    assert.ok(!server.calls.some((call) => call.startsWith("get:") || call.startsWith("finalize:")));
  });

  test("a plan created after cancellation is still recorded for cleanup", async () => {
    const clock = virtualClock();
    const controller = new AbortController();
    const tracker = new PlanWorkTracker();
    const server = fakePlanServer(clock, { generationMs: 0 });
    let release!: () => void;
    let creating = false;
    const api: PlanApi = {
      ...server.api,
      // The server creates the plan, but its answer arrives after the abort.
      createPlan: (repo, prompt, plannerClient, request) => {
        creating = true;
        return new Promise<void>((resolve) => { release = resolve; })
          .then(() => server.api.createPlan(repo, prompt, plannerClient, request));
      },
    };
    const createdPlanIds: string[] = [];

    const pending = createAndGeneratePlan("repo", "prompt", client, createdPlanIds, {
      api, now: clock.now, sleep: clock.sleep, log: () => {}, signal: controller.signal, deadline: PLAN_TEST_BUDGET_MS, tracker,
    });
    while (!creating) await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("suite timed out"));
    await assert.rejects(pending, /suite timed out/);
    assert.deepEqual(createdPlanIds, []);

    release();
    assert.equal(await tracker.settle(1_000), true);
    // Cleanup, which runs after settle(), sees the plan; nothing else was requested.
    assert.deepEqual(createdPlanIds, ["plan-1-0000"]);
    assert.deepEqual(server.calls, ["create:plan-1-0000"]);
  });

  test("the live client aborts a pending read at the deadline instead of retrying it", async () => {
    const originalFetch = globalThis.fetch;
    const fetches: string[] = [];
    // A server that accepts every write and never answers a read.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      fetches.push(`${method} ${String(input)}`);
      if (method === "POST") {
        return new Response(JSON.stringify({ draft_id: "live-plan-0000" }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as typeof fetch;
    try {
      const configManager = { getRemoteUrl: () => undefined, getGithubToken: () => undefined } as unknown as ConfigManager;
      const liveClient = new ApiClient(configManager, { baseUrl: "http://propr.invalid", token: "test" });
      const createdPlanIds: string[] = [];
      const startedAt = Date.now();

      // Too little time is left for the generation poll, so the helper reads
      // the plan status once; that read hangs past the deadline.
      await assert.rejects(
        createAndGeneratePlan("repo", "prompt", liveClient, createdPlanIds, { deadline: startedAt + 300, log: () => {} }),
        PlanDeadlineError,
      );
      const elapsed = Date.now() - startedAt;
      const fetchesAtDeadline = fetches.length;
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      assert.ok(elapsed < 5_000, `rejected after ${elapsed}ms`);
      assert.deepEqual(createdPlanIds, ["live-plan-0000"]);
      assert.equal(fetches.filter((call) => call.startsWith("GET ")).length, 1, "the read is not retried");
      assert.equal(fetches.length, fetchesAtDeadline, "nothing is requested after the deadline");
      assert.ok(!fetches.some((call) => call.endsWith("/api/planner/finalize")));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("E2E plan cleanup", () => {
  test("abortableSleep rejects immediately when its signal aborts", async () => {
    const controller = new AbortController();
    const pending = abortableSleep(60_000, controller.signal);
    controller.abort(new Error("stop"));
    await assert.rejects(pending, /stop/);
  });

  test("cleanup waits for cancelled plan work to settle", async () => {
    const tracker = new PlanWorkTracker();
    let finished = false;
    void tracker.track(new Promise<void>((_, reject) => setTimeout(() => { finished = true; reject(new Error("aborted")); }, 5)))
      .catch(() => {});

    assert.equal(await tracker.settle(1_000), true);
    assert.equal(finished, true);
    assert.equal(tracker.size, 0);
  });

  test("cleanup does not wait forever for work that never settles", async () => {
    const tracker = new PlanWorkTracker();
    void tracker.track(new Promise(() => {}));
    assert.equal(await tracker.settle(5), false);
    assert.equal(tracker.size, 1);
  });
});
