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
});
