import { readFileSync } from "node:fs";
import { MODEL_MATRIX_PLAN_BUDGET_MS, planDeadline, abortableSleep } from "./e2e/planGeneration.js";
import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MODEL_TASK_TIMEOUT_MS,
  parseModelTaskTimeoutMs, modelPhaseBudgetMs, modelMatrixSuiteTimeoutMs,
  MODEL_MATRIX_FOLLOWUP_BUDGET_MS,
} from "./e2e/modelTaskTimeout.js";

import { ApiClient } from "../packages/cli/src/api/client.js";
import type { ConfigManager } from "../packages/cli/src/config/index.js";
import type { RequestOptions } from "../packages/cli/src/api/types.js";
import { withE2EWork, waitForTasks, pollTasksToCompletion, newModelResult, assertModelTasksSucceeded } from "./e2e/helpers.js";


describe("E2E model-task timeout configuration", () => {
  test("defaults to a bounded 30-minute polling budget", () => {
    assert.equal(DEFAULT_MODEL_TASK_TIMEOUT_MS, 1_800_000);
    assert.equal(parseModelTaskTimeoutMs(undefined), DEFAULT_MODEL_TASK_TIMEOUT_MS);
    assert.equal(parseModelTaskTimeoutMs("   "), DEFAULT_MODEL_TASK_TIMEOUT_MS);
  });

  test("accepts a positive integer override", () => {
    assert.equal(parseModelTaskTimeoutMs("1500000"), 1_500_000);
  });

  test("falls back safely for invalid, zero, and negative overrides", () => {
    const fallback = 1_800_000;
    for (const value of ["invalid", "0", "-1", "1.5", "Infinity", "9007199254740992"]) {
      assert.equal(parseModelTaskTimeoutMs(value, fallback), fallback, value);
    }
  });
});

// Exercise the real discovery and execution loops with a synthetic API and clock.
// No provider calls, credentials or live suite import are needed.

async function advanceUntilSettled(t: TestContext, work: Promise<unknown>) {
  let settled = false;
  const outcome = work.then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  for (let seconds = 0; !settled && seconds < 130 * 60; seconds++) {
    t.mock.timers.tick(1_000);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.ok(settled, "bounded work must settle");
  const result = await outcome;
  if ("error" in result) throw result.error;
}

for (const executionMs of [1_500_000, DEFAULT_MODEL_TASK_TIMEOUT_MS]) {
  for (const jobLimited of [false, true]) {
    test(`delayed discovery and both execution phases (${executionMs}ms, job limit=${jobLimited})`, async t => {
      t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
      t.mock.method(console, "log", () => {});
      const api = new ApiClient({} as ConfigManager, { baseUrl: "http://synthetic.invalid", token: "synthetic" });
      const suite = new AbortController();
      const backstop = setTimeout(() => suite.abort(new Error("matrix suite backstop")), modelMatrixSuiteTimeoutMs(executionMs));
      const jobDeadline = jobLimited ? 110 * 60_000 : undefined;
      const discoveries: number[] = [];
      const executions: number[] = [];
      let phase = -1;
      let executionStart = 0;
      let followups = 0;
      t.mock.method(api, "request", async (endpoint: string, options: RequestOptions = {}) => {
        // Include real simulated request latency, beyond the discovery sleeps.
        await abortableSleep(endpoint === "/submit" ? 120_000 : 1_000, options.signal);
        if (endpoint === "/api/tasks") {
          discoveries[phase]++;
          const found = discoveries[phase] === 60;
          if (found) executionStart = Date.now();
          return { data: { tasks: found ? [{ id: "task-agent-model-id", issueNumber: 42 }] : [] } };
        }
        if (endpoint.includes("/history")) {
          const completed = Date.now() - executionStart >= executionMs - 11_000;
          return { data: { taskId: "task-agent-model-id", history: [{ state: completed ? "completed" : "claude_execution", timestamp: new Date().toISOString() }] } };
        }
        return { data: {} };
      });
      const work = (async () => {
        await abortableSleep(MODEL_MATRIX_PLAN_BUDGET_MS, suite.signal);
        for (phase = 0; phase < 2; phase++) {
          discoveries.push(0);
          await withE2EWork(api, suite.signal, async scoped => {
            await scoped.post("/submit");
            const results = [newModelResult({ agent_alias: "agent", model_name: "model" }, 42, phase === 0 ? "parallel" : "single")];
            await waitForTasks(results, "repo", scoped);
            await pollTasksToCompletion(results, scoped, executionMs);
            executions.push(Date.now() - executionStart);
            assertModelTasksSucceeded(results);
          }, planDeadline(modelPhaseBudgetMs(executionMs), jobDeadline));
        }
        for (const endpoint of ["/check-history", "/collect-logs"]) {
          await withE2EWork(api, suite.signal, async (scoped, sleep) => {
            await sleep(MODEL_MATRIX_FOLLOWUP_BUDGET_MS - 10_000);
            await scoped.get(endpoint);
            followups++;
          }, planDeadline(MODEL_MATRIX_FOLLOWUP_BUDGET_MS, jobDeadline));
        }
      })();
      try {
        if (jobLimited && executionMs === DEFAULT_MODEL_TASK_TIMEOUT_MS) {
          await assert.rejects(advanceUntilSettled(t, work), /job deadline/);
          assert.equal(Date.now(), jobDeadline);
          assert.equal(followups, 0);
        } else {
          await advanceUntilSettled(t, work);
          assert.deepEqual(discoveries, [60, 60]);
          assert.equal(executions.length, 2);
          for (const elapsed of executions) assert.ok(elapsed >= executionMs - 11_000, "discovery must not consume execution polling time");
          assert.equal(followups, 2);
          assert.ok(Date.now() > 90 * 60_000, "regression scenario exceeds the former suite backstop");
        }
        assert.equal(suite.signal.aborted, false, "the suite must not preempt its composed budgets");
      } finally { clearTimeout(backstop); }
    });
  }
}

test("the live matrix uses whole-phase and follow-up deadlines with separate execution polling", () => {
  const source = readFileSync(new URL("./e2e.test.ts", import.meta.url), "utf8");
  assert.match(source, /describe\("11\. Model matrix", \{ timeout: modelMatrixSuiteTimeoutMs\(MODEL_TASK_TIMEOUT_MS\)/);
  assert.match(source, /MODEL_PHASE_BUDGET_MS = modelPhaseBudgetMs\(MODEL_TASK_TIMEOUT_MS\)/);
  assert.equal(source.match(/planDeadline\(MODEL_PHASE_BUDGET_MS\)/g)?.length, 2);
  assert.equal(source.match(/planDeadline\(MODEL_MATRIX_FOLLOWUP_BUDGET_MS\)/g)?.length, 2);
  assert.match(source, /await waitForTasks\(pr, REPO!, client\);\s+await pollTasksToCompletion\(pr, client\)/);
  assert.match(source, /await waitForTasks\(sr, REPO!, client\);\s+await pollTasksToCompletion\(sr, client\)/);
});

for (const failure of ["discovery", "execution", "submission"] as const) {
  test(`${failure} exhaustion remains a failure and permits independent cleanup`, async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    t.mock.method(console, "log", () => {});
    const api = new ApiClient({} as ConfigManager, { baseUrl: "http://synthetic.invalid", token: "synthetic" });
    let discoveries = 0;
    let polls = 0;
    let cleanup = false;
    let revoked: ApiClient | undefined;
    t.mock.method(api, "request", async (endpoint: string, options: RequestOptions = {}) => {
      if (endpoint === "/cleanup") { cleanup = true; return { data: {} }; }
      if (endpoint === "/submit") {
        await abortableSleep(modelPhaseBudgetMs(DEFAULT_MODEL_TASK_TIMEOUT_MS) + 1, options.signal);
        assert.fail("submission must be cancelled by the whole-phase deadline");
      }
      if (endpoint === "/api/tasks") {
        discoveries++;
        return { data: { tasks: failure === "discovery" ? [] : [{ id: "task-agent-model-id", issueNumber: 42 }] } };
      }
      polls++;
      return { data: { taskId: "task-agent-model-id", history: [{ state: "claude_execution", timestamp: new Date().toISOString() }] } };
    });
    const work = withE2EWork(api, new AbortController().signal, async scoped => {
      revoked = scoped;
      if (failure === "submission") await scoped.post("/submit");
      const results = [newModelResult({ agent_alias: "agent", model_name: "model" }, 42, "single")];
      await waitForTasks(results, "repo", scoped);
      await pollTasksToCompletion(results, scoped, DEFAULT_MODEL_TASK_TIMEOUT_MS);
    }, planDeadline(modelPhaseBudgetMs(DEFAULT_MODEL_TASK_TIMEOUT_MS)));
    await assert.rejects(advanceUntilSettled(t, work), failure === "submission" ? /job deadline/ : /Timed out waiting for 1\/1 model task/);
    if (failure === "discovery") { assert.equal(discoveries, 60); assert.equal(polls, 0); }
    if (failure === "execution") { assert.equal(polls, 180); assert.equal(Date.now(), 10_000 + DEFAULT_MODEL_TASK_TIMEOUT_MS); }
    if (failure === "submission") assert.equal(Date.now(), modelPhaseBudgetMs(DEFAULT_MODEL_TASK_TIMEOUT_MS));
    await assert.rejects(revoked!.post("/submit"));
    await api.post("/cleanup");
    assert.equal(cleanup, true);
  });
}
