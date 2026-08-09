import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { findUnclaimedModelTask } from "./e2e/taskMatching.js";

describe("E2E model task matching", () => {
  const tasks = [
    {
      id: "integry-propr-test-715-codex-gpt-5.6-sol-correlation-one",
      issueNumber: 715,
    },
    {
      id: "integry-propr-test-715-codex2-gpt-5.6-sol-correlation-two",
      issueNumber: 715,
    },
  ];

  test("distinguishes aliases that run the same model on the same issue", () => {
    assert.equal(findUnclaimedModelTask(tasks, {
      agent_alias: "codex2",
      model_name: "gpt-5.6-sol",
      issueNumber: 715,
    }, new Set())?.id, tasks[1].id);

    assert.equal(findUnclaimedModelTask(tasks, {
      agent_alias: "codex",
      model_name: "gpt-5.6-sol",
      issueNumber: 715,
    }, new Set([tasks[1].id]))?.id, tasks[0].id);
  });

  test("does not reuse claimed tasks or match the wrong issue", () => {
    const result = {
      agent_alias: "codex",
      model_name: "gpt-5.6-sol",
      issueNumber: 715,
    };
    assert.equal(findUnclaimedModelTask(tasks, result, new Set([tasks[0].id])), undefined);
    assert.equal(findUnclaimedModelTask(tasks, { ...result, issueNumber: 716 }, new Set()), undefined);
  });
});
