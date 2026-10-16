import assert from "node:assert/strict";
import { test } from "node:test";
import type { RoutingResyncState } from "../api/index.js";
import { ROUTING_RESYNC_LABELS, summarizeRoutingResync } from "./routingResyncFormat.js";

function resync(overrides: Partial<RoutingResyncState> = {}): RoutingResyncState {
  return {
    state: "partial",
    installationId: 42,
    routingGeneration: 3,
    resumeGeneration: 7,
    gapStartedAt: "2026-10-10T00:00:00.000Z",
    gapEndedAt: "2026-10-12T00:00:00.000Z",
    startedAt: "2026-10-12T00:01:00.000Z",
    completedAt: null,
    acknowledgedAt: null,
    attempts: 2,
    lastAttemptAt: "2026-10-12T00:05:00.000Z",
    nextRetryAt: "2026-10-12T00:06:00.000Z",
    lastError: "acme/api labelled_issues: GitHub 502",
    running: false,
    repositories: { total: 3, reconciled: 1, inaccessible: 1, failed: 1, pending: 0 },
    failedRepositories: [{ repository: "acme/api", error: "GitHub 502" }],
    intakeWaiting: true,
    completionId: null,
    lastCompletionSentAt: null,
    lastRejection: null,
    ...overrides,
  };
}

test("summarizes a partial resync as needing attention with gap, progress and retry", () => {
  const summary = summarizeRoutingResync(resync());
  assert.equal(summary.healthy, false);
  assert.match(summary.attention ?? "", /partial; retrying/);
  const rows = Object.fromEntries(summary.rows);
  assert.equal(rows["Resume Resync"], "partial");
  assert.equal(rows["Resume Generation"], "3/7");
  assert.equal(rows["Resync Repositories"], "1/3 reconciled, 1 inaccessible, 1 failed, 0 pending");
  assert.equal(rows["Resync Last Error"], "acme/api labelled_issues: GitHub 502");
  assert.match(rows["Routed Intake"], /^waiting/);
  for (const [label] of summary.rows) assert.ok((ROUTING_RESYNC_LABELS as readonly string[]).includes(label));
});

test("reports a still-suspended gap, a failed resync and an acknowledged one", () => {
  const pending = summarizeRoutingResync(resync({ state: "pending", gapEndedAt: null, lastError: null, nextRetryAt: null }));
  assert.equal(pending.healthy, true);
  assert.match(Object.fromEntries(pending.rows)["Suspension Gap"], /still suspended/);
  assert.equal(summarizeRoutingResync(resync({ state: "failed" })).healthy, false);
  const acknowledged = summarizeRoutingResync(resync({ state: "acknowledged", intakeWaiting: false, lastError: null, nextRetryAt: null }));
  assert.equal(acknowledged.healthy, true);
  assert.equal(acknowledged.attention, null);
  assert.equal(Object.fromEntries(acknowledged.rows)["Routed Intake"], "flowing");
  assert.deepEqual(summarizeRoutingResync(resync({ state: "idle" })).rows, [["Resume Resync", "idle (no suspension gap recorded)"]]);
});
