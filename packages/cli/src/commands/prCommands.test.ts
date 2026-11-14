import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrCommand, formatReadiness } from "./prCommands.js";

test("pr readiness takes a number, an optional project and a JSON flag", () => {
  const command = createPrCommand().commands.find(sub => sub.name() === "readiness");
  assert.ok(command);
  assert.deepEqual(command.registeredArguments.map(argument => argument.name()), ["number"]);
  assert.deepEqual(command.options.map(option => option.long), ["--project", "--json"]);
});

test("readiness output lists every gate with its status and reason", () => {
  const lines = formatReadiness({
    repository: "acme/app", number: 42, head: "a".repeat(40), base: "main", state: "open", draft: false, verdict: "blocked",
    gates: [
      { gate: "open", status: "pass", reason: "pull_request_open" },
      { gate: "checks", status: "fail", reason: "checks_not_passing", detail: "Failed: lint" },
      { gate: "active_work", status: "waiting", reason: "propr_work_active" },
    ],
    blockingReasons: ["checks_not_passing"], waitingReasons: ["propr_work_active"],
    review: null, ultrafix: null,
    checks: { reason: "checks_not_passing", blockingFailed: ["lint"], blockingPending: [], nonBlockingCount: 0 },
    autoMerge: { eligible: "ineligible", reason: "no_auto_merge_label", policy: null },
    evaluatedAt: "2026-11-12T12:00:00.000Z",
  });
  assert.equal(lines[0], "acme/app#42 · BLOCKED · head aaaaaaaaaaaa → main");
  assert.ok(lines.includes("  checks       fail            checks_not_passing — Failed: lint"));
  assert.ok(lines.includes("Blocking: checks_not_passing"));
  assert.ok(lines.includes("Waiting:  propr_work_active"));
});
