import type { RequestOptions } from "../packages/cli/src/api/types.js";
import { ApiClient } from "../packages/cli/src/api/client.js";
import type { ConfigManager } from "../packages/cli/src/config/index.js";
import assert from "node:assert";
import { describe, test } from "node:test";
import { isProviderAuthenticationFailure } from "./e2e/providerAuthentication.js";
import {
  assertModelTasksSucceeded, withE2EWork, triggerSequentialImplementation,
  waitForPlanIssueCondition, waitForTasks, pollTasksToCompletion,
  isPlannerAuthenticationFailure,
  newModelResult,
  type ModelTestResult,
} from "./e2e/helpers.js";

function result(alias: string, model: string, finalState: string, failureReason: string | null = null): ModelTestResult {
  const value = newModelResult({ agent_alias: alias, model_name: model }, 42, "parallel");
  value.finalState = finalState;
  value.failureReason = failureReason;
  return value;
}

describe("E2E model task completion", () => {
  const invalidatedToken = "Task failed: Encountered invalidated oauth token for user, failing request";
  const expiredSession = "Task failed: Failed to authenticate: OAuth session expired and could not be refreshed";

  test("reports invalidated provider credentials when another model completed", (t) => {
    const warnings: string[] = [];
    t.mock.method(console, "log", (message: string) => warnings.push(message));
    assert.doesNotThrow(() => assertModelTasksSucceeded([
      result("codex", "gpt-6.1-sol", "completed"),
      result("opencode", "opencode-openai/gpt-5.6-luna", "failed", invalidatedToken),
    ]));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /reauthenticate the affected provider account/);
    assert.match(warnings[0], /opencode\/opencode-openai\/gpt-5\.6-luna: failed/);
  });

  test("tolerates a mix of provider quota and credential failures with live success", () => {
    assert.doesNotThrow(() => assertModelTasksSucceeded([
      result("claude", "claude-opus-5-5", "completed"),
      result("codex", "gpt-6.1-sol", "failed", "usage limit"),
      result("opencode", "opencode-openai/gpt-5.6-luna", "failed", invalidatedToken),
    ]));
  });

  test("fails when no model completed despite recognized provider failures", () => {
    for (const results of [
      [result("opencode", "opencode-openai/gpt-5.6-luna", "failed", invalidatedToken)],
      [
        result("opencode", "opencode-openai/gpt-5.6-luna", "failed", invalidatedToken),
        result("codex", "gpt-6.1-sol", "failed", "usage limit"),
      ],
    ]) {
      assert.throws(() => assertModelTasksSucceeded(results), /did not complete successfully/);
    }
  });

  test("credential rejection does not hide unexpected failures", () => {
    for (const reason of ["GitHub API authentication failed (401)", "HTTP 401 Unauthorized", "Agent authentication failed", "agy not found"]) {
      assert.throws(() => assertModelTasksSucceeded([
        result("claude", "claude-opus-5-5", "completed"),
        result("opencode", "opencode-openai/gpt-5.6-luna", "failed", invalidatedToken),
        result("codex", "gpt-6.1-sol", "failed", reason),
      ]), /2\/3 model task\(s\) did not complete successfully/);
    }
  });

  test("tolerates an expired Claude OAuth session when another model completed", () => {
    assert.doesNotThrow(() => assertModelTasksSucceeded([
      result("codex", "gpt-6.1-sol", "completed"),
      result("claude", "claude-opus-5-5", "failed", expiredSession),
    ]));
    assert.throws(() => assertModelTasksSucceeded([
      result("claude", "claude-opus-5-5", "failed", expiredSession),
    ]), /did not complete successfully/);
  });

  test("classifies only explicit credential rejections on failed tasks", () => {
    assert.equal(isProviderAuthenticationFailure("failed", invalidatedToken), true);
    assert.equal(isProviderAuthenticationFailure("failed", expiredSession), true);
    assert.equal(isProviderAuthenticationFailure("failed", invalidatedToken.toUpperCase()), true);
    for (const state of [null, "completed", "cancelled", "claude_execution"]) {
      assert.equal(isProviderAuthenticationFailure(state, invalidatedToken), false);
    }
    for (const reason of [null, "", "oauth token", "OAuth session expired", "HTTP 401 Unauthorized", "GitHub API authentication failed (401)"]) {
      assert.equal(isProviderAuthenticationFailure("failed", reason), false);
    }
    assert.throws(() => assertModelTasksSucceeded([
      result("claude", "claude-opus-5-5", "completed"),
      result("opencode", "opencode-openai/gpt-5.6-luna", "cancelled", invalidatedToken),
    ]), /cancelled/);
  });

  test("accepts only completed model tasks", () => {
    assert.doesNotThrow(() => assertModelTasksSucceeded([
      result("codex", "gpt-5.6-sol", "completed"),
      result("opencode", "opencode-nemotron-3-ultra-free", "completed"),
    ]));
  });

  test("fails with every unsuccessful alias, model, state, and reason", () => {
    assert.throws(
      () => assertModelTasksSucceeded([
        result("codex", "gpt-5.6-sol", "completed"),
        result("antigravity", "antigravity-gemini-3.8-flash", "failed", "agy not found\ninside image"),
        result("claude", "claude-sonnet-4-6", "cancelled"),
      ]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /2\/3 model task\(s\) did not complete successfully/);
        assert.match(error.message, /antigravity\/antigravity-gemini-3\.8-flash: failed — agy not found inside image/);
        assert.match(error.message, /claude\/claude-sonnet-4-6: cancelled/);
        return true;
      },
    );
  });

  test("tolerates provider usage limits when another model completed", () => {
    assert.doesNotThrow(() => assertModelTasksSucceeded([
      result("claude", "claude-opus-5", "completed"),
      result("codex", "gpt-6-astra", "failed", "Task failed: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 19th, 2026 8:12 AM."),
      result("opencode", "opencode-openai/gpt-5.6-luna", "failed", "Task failed: The usage limit has been reached"),
    ]));
  });

  test("still fails when a usage-limited run also has another failure", () => {
    assert.throws(
      () => assertModelTasksSucceeded([
        result("claude", "claude-opus-5", "completed"),
        result("codex", "gpt-6-astra", "failed", "Task failed: The usage limit has been reached"),
        result("antigravity", "antigravity-gemini-3.8-flash", "failed", "agy not found"),
      ]),
      /2\/3 model task\(s\) did not complete successfully/,
    );
  });

  test("fails when every model hit a provider usage limit", () => {
    assert.throws(
      () => assertModelTasksSucceeded([
        result("codex", "gpt-6-astra", "failed", "Task failed: The usage limit has been reached"),
      ]),
      /1\/1 model task\(s\) did not complete successfully/,
    );
  });

  test("does not treat cancelled tasks as usage limited", () => {
    assert.throws(
      () => assertModelTasksSucceeded([
        result("claude", "claude-opus-5", "completed"),
        result("codex", "gpt-6-astra", "cancelled", "usage limit"),
      ]),
      /codex\/gpt-6-astra: cancelled/,
    );
  });

  test("stops plan retries only on the planner's authentication failure summary", () => {
    assert.equal(isPlannerAuthenticationFailure("Plan generation could not authenticate with a required service."), true);
    for (const reason of [
      undefined,
      "",
      "Plan generation failed. Detailed diagnostics are available in server logs.",
      "Plan generation timed out.",
      "The plan generation service is rate limited. Please try again later.",
    ]) {
      assert.equal(isPlannerAuthenticationFailure(reason), false);
    }
  });
});


describe("E2E implementation job deadline", () => {
  const client = () => new ApiClient({} as ConfigManager, { baseUrl: "http://synthetic.invalid", token: "synthetic" });

  test("an expired job starts no implementation work", async () => {
    let started = false;
    await assert.rejects(withE2EWork(client(), new AbortController().signal, async () => {
      started = true;
    }, Date.now() - 1), /job deadline/);
    assert.equal(started, false);
  });

  test("cancellation during issue lookup prevents the sequential trigger", async (t) => {
    const api = client();
    const parent = new AbortController();
    const request = t.mock.method(api, "request", async () => {
      parent.abort(new Error("test cancelled"));
      return { data: [{ issue_number: 1, status: "pending" }] };
    });
    await assert.rejects(withE2EWork(api, parent.signal, scoped =>
      triggerSequentialImplementation("draft", scoped)), /test cancelled/);
    assert.equal(request.mock.callCount(), 1, "no implementation POST after the awaited lookup");
  });

  test("deadline expiry aborts an in-flight request and revokes the scoped client", async (t) => {
    const api = client();
    let scopedClient: ApiClient | undefined;
    const request = t.mock.method(api, "request", async (_endpoint: string, options: RequestOptions = {}) => {
      assert.ok(options.signal);
      assert.ok(options.timeout! <= 50);
      await new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }));
    });
    // Keep the process alive while the intentionally unref'd deadline timer fires.
    const keepAlive = setTimeout(() => {}, 1_000);
    try {
      await assert.rejects(withE2EWork(api, new AbortController().signal, async scoped => {
        scopedClient = scoped;
        await scoped.get("/slow");
      }, Date.now() + 50), /job deadline/);
      await assert.rejects(scopedClient!.post("/implement"), /job deadline/);
      assert.equal(request.mock.callCount(), 1);
    } finally { clearTimeout(keepAlive); }
  });

  for (const path of ["sequential", "task discovery", "task completion"] as const) {
    test(`${path} polling stops on cancellation during its wait`, async (t) => {
      const api = client();
      const parent = new AbortController();
      const request = t.mock.method(api, "request", async () => ({ data: [] }));
      const task = newModelResult({ agent_alias: "synthetic", model_name: "synthetic" }, 1, "single");
      task.taskId = path === "task completion" ? "task" : null;
      const pending = withE2EWork<unknown>(api, parent.signal, scoped => {
        if (path === "sequential") return waitForPlanIssueCondition("draft", scoped, () => false);
        if (path === "task discovery") return waitForTasks([task], "repo", scoped);
        return pollTasksToCompletion([task], scoped);
      });
      await new Promise(resolve => setImmediate(resolve));
      parent.abort(new Error("poll cancelled"));
      await assert.rejects(pending, /poll cancelled/);
      assert.equal(request.mock.callCount(), path === "sequential" ? 1 : 0);
    });
  }
});
