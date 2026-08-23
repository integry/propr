import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MODEL_TASK_TIMEOUT_MS,
  parseModelTaskTimeoutMs,
} from "./e2e/modelTaskTimeout.js";

describe("E2E model-task timeout configuration", () => {
  test("defaults to a bounded 20-minute polling budget", () => {
    assert.equal(DEFAULT_MODEL_TASK_TIMEOUT_MS, 1_200_000);
    assert.equal(parseModelTaskTimeoutMs(undefined), DEFAULT_MODEL_TASK_TIMEOUT_MS);
    assert.equal(parseModelTaskTimeoutMs("   "), DEFAULT_MODEL_TASK_TIMEOUT_MS);
  });

  test("accepts a positive integer override", () => {
    assert.equal(parseModelTaskTimeoutMs("1500000"), 1_500_000);
  });

  test("falls back safely for invalid, zero, and negative overrides", () => {
    const fallback = 1_200_000;
    for (const value of ["invalid", "0", "-1", "1.5", "Infinity", "9007199254740992"]) {
      assert.equal(parseModelTaskTimeoutMs(value, fallback), fallback, value);
    }
  });
});
