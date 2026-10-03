import assert from "node:assert";
import { describe, test } from "node:test";
import { isProviderAuthenticationFailure } from "./e2e/providerAuthentication.js";
import {
  assertModelTasksSucceeded,
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

  test("classifies only explicit credential rejections on failed tasks", () => {
    assert.equal(isProviderAuthenticationFailure("failed", invalidatedToken), true);
    assert.equal(isProviderAuthenticationFailure("failed", invalidatedToken.toUpperCase()), true);
    for (const state of [null, "completed", "cancelled", "claude_execution"]) {
      assert.equal(isProviderAuthenticationFailure(state, invalidatedToken), false);
    }
    for (const reason of [null, "", "oauth token", "HTTP 401 Unauthorized", "GitHub API authentication failed (401)"]) {
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
        result("antigravity", "antigravity-gemini-3.5-flash-medium", "failed", "agy not found\ninside image"),
        result("claude", "claude-sonnet-4-6", "cancelled"),
      ]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /2\/3 model task\(s\) did not complete successfully/);
        assert.match(error.message, /antigravity\/antigravity-gemini-3\.5-flash-medium: failed — agy not found inside image/);
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
        result("antigravity", "antigravity-gemini-3.8-flash-high", "failed", "agy not found"),
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
});
