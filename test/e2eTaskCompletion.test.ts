import assert from "node:assert";
import { describe, test } from "node:test";
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
