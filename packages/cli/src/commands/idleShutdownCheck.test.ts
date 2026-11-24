import assert from "node:assert/strict";
import { test } from "node:test";
import { checkIdleShutdown } from "./idleShutdownCheck.js";

test("reports idle shutdown as off unless set, without a running backend", async () => {
  const rows = await checkIdleShutdown({}, async () => { throw new Error("ECONNREFUSED"); });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Idle shutdown");
  assert.equal(rows[0].status, "ok");
  assert.match(rows[0].detail, /off unless turned on in Settings/);
});

test("shows the environment value and warns about invalid ones", async () => {
  assert.match((await checkIdleShutdown({ PROPR_IDLE_SHUTDOWN: "on", PROPR_IDLE_SHUTDOWN_AFTER: "20m" }))[0].detail, /^on, after 20m/);
  const invalid = (await checkIdleShutdown({ PROPR_IDLE_SHUTDOWN: "sometimes" }))[0];
  assert.equal(invalid.status, "warn");
  assert.match(invalid.fix ?? "", /not "on" or "off"/);
});

test("warns that polling intake never idles", async () => {
  const rows = await checkIdleShutdown({ PROPR_IDLE_SHUTDOWN: "on", GITHUB_EVENT_INTAKE_MODE: "polling" });
  assert.ok(rows.some(row => row.name === "Idle shutdown intake" && row.status === "warn"));
});

test("adds the daemon's live status: blockers, last shutdown and last wake", async () => {
  const rows = await checkIdleShutdown({}, async () => ({
    idleShutdown: {
      enabled: true, afterMs: 900_000, source: "settings", idle: false, idleSince: null, shutdownAt: null,
      blockers: [{ signal: "queue_jobs", detail: "github-issue-processor: 1 active" }],
      nextDueAt: "2026-11-24T14:00:00.000Z", checkedAt: "2026-11-24T12:00:00.000Z",
      lastShutdown: { shutdownAt: "2026-11-24T02:00:00.000Z", reason: "idle for 900s", idleForMs: 900_000, nextDueAt: null },
      lastWake: { wokeAt: "2026-11-24T08:00:00.000Z", source: "connect_ping", coldStartMs: 6200, sleptMs: 21_600_000, shutdownAt: "2026-11-24T02:00:00.000Z" },
    },
  }));
  const live = rows.find(row => row.name === "Idle shutdown (live)");
  assert.match(live?.detail ?? "", /on after 15m \(settings\); busy — github-issue-processor: 1 active/);
  assert.equal(rows.find(row => row.name === "Last wake")?.detail, "2026-11-24T08:00:00.000Z via connect_ping, cold start 6200 ms");
  assert.ok(rows.some(row => row.name === "Last idle shutdown"));
  assert.ok(rows.some(row => row.name === "Next scheduled work"));
});

test("leaves the backend alone on a direct-webhook stack that does not turn it on", async () => {
  let reads = 0;
  const readStatus = async () => { reads++; return { idleShutdown: null }; };
  await checkIdleShutdown({ GITHUB_EVENT_INTAKE_MODE: "direct_webhook" }, readStatus);
  assert.equal(reads, 0);
  await checkIdleShutdown({ GITHUB_EVENT_INTAKE_MODE: "direct_webhook", PROPR_IDLE_SHUTDOWN: "on" }, readStatus);
  await checkIdleShutdown({}, readStatus);
  assert.equal(reads, 2);
});
