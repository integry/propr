import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseModelPairLimit, selectAgentModelPairs } from "./e2e/modelMatrix.js";

describe("E2E model matrix selection", () => {
  const agents = [
    { alias: "zeta", supportedModels: ["z2", "z1"] },
    { alias: "alpha", supportedModels: ["a2", "a1", "a1"], defaultModel: "a2" },
    { alias: "empty", supportedModels: [] },
  ];

  test("uses each configured default as the representative before remaining models", () => {
    assert.deepEqual(selectAgentModelPairs(agents, 3), [
      { agent_alias: "alpha", model_name: "a2" },
      { agent_alias: "zeta", model_name: "z1" },
      { agent_alias: "alpha", model_name: "a1" },
    ]);
  });

  test("falls back to the first deterministic model when the default is unavailable", () => {
    assert.deepEqual(selectAgentModelPairs([
      { alias: "alpha", supportedModels: ["a2", "a1"], defaultModel: "removed" },
    ], 1), [
      { agent_alias: "alpha", model_name: "a1" },
    ]);
  });

  test("zero selects the complete deduplicated matrix", () => {
    assert.deepEqual(selectAgentModelPairs(agents, 0), [
      { agent_alias: "alpha", model_name: "a2" },
      { agent_alias: "zeta", model_name: "z1" },
      { agent_alias: "alpha", model_name: "a1" },
      { agent_alias: "zeta", model_name: "z2" },
    ]);
  });

  test("parses explicit limits and falls back for invalid input", () => {
    assert.equal(parseModelPairLimit("12"), 12);
    assert.equal(parseModelPairLimit("0"), 0);
    assert.equal(parseModelPairLimit("invalid", 6), 6);
    assert.equal(parseModelPairLimit("-1", 6), 6);
  });
});
