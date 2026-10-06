import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTaskBudget, resolveFollowupBodyArgument, selectBodySource } from "./taskCommands.js";

test("resolveFollowupBodyArgument preserves multi-word follow-up text", () => {
  assert.equal(
    resolveFollowupBodyArgument(["Please", "also", "add", "tests"]),
    "Please also add tests"
  );
});

test("resolveFollowupBodyArgument leaves absent body undefined", () => {
  assert.equal(resolveFollowupBodyArgument(undefined), undefined);
});

test("selectBodySource picks the single provided source", () => {
  assert.equal(selectBodySource({ argument: "text" }), "argument");
  assert.equal(selectBodySource({ file: "notes.md" }), "file");
  assert.equal(selectBodySource({ stdin: true }), "stdin");
  assert.equal(selectBodySource({}), "none");
});

test("selectBodySource treats an empty positional argument as absent", () => {
  assert.equal(selectBodySource({ argument: "", file: "notes.md" }), "file");
  assert.equal(selectBodySource({ argument: "" }), "none");
});

test("selectBodySource rejects conflicting sources instead of silently dropping input", () => {
  assert.throws(
    () => selectBodySource({ argument: "text", file: "notes.md" }),
    /only one of: argument, --file, or --stdin/
  );
  assert.throws(
    () => selectBodySource({ argument: "text", stdin: true }),
    /only one of: argument, --file, or --stdin/
  );
  assert.throws(
    () => selectBodySource({ file: "notes.md", stdin: true }),
    /only one of: argument, --file, or --stdin/
  );
});

test("formatTaskBudget shows the spend beside the run's cap and where it came from", () => {
  assert.equal(
    formatTaskBudget({ spentUsd: 1.2, capUsd: 5, percent: 24, source: "workflow", exceeded: false }),
    "$1.20 of $5.00 cap (24%, .propr/workflow.yml)",
  );
  assert.equal(
    formatTaskBudget({ spentUsd: 5.3, capUsd: 5, percent: 106, source: "override", exceeded: true }),
    "$5.30 of $5.00 cap (106%, task override) - stopped at cap",
  );
  assert.equal(formatTaskBudget({ spentUsd: 0.4, capUsd: null, percent: null, source: null, exceeded: false }), "$0.40 (no spend cap)");
});
