import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getLocalSetupCapability,
  retrySetup,
  runSetup,
  type SetupActions,
  type SetupProgressEvent,
} from "./index.js";

const unusedActions = {} as SetupActions;

test("platform capabilities support Linux and make macOS/Windows explicitly remote-only", () => {
  assert.deepEqual(getLocalSetupCapability("linux"), {
    supported: true,
    kind: "local",
    platform: "linux",
  });
  for (const platform of ["darwin", "win32"] as const) {
    const capability = getLocalSetupCapability(platform);
    assert.equal(capability.supported, false);
    assert.equal(capability.kind, "remote-only");
    assert.match(capability.reason, /remote ProPR deployment/);
  }
});

test("unsupported hosts return a structured result without invoking host operations", async () => {
  let called = false;
  const actions = new Proxy({}, { get: () => () => { called = true; } }) as SetupActions;
  const result = await runSetup({ root: "/stack", platform: "darwin", actions });

  assert.equal(called, false);
  assert.equal(result.completed, false);
  assert.equal(result.capability.kind, "remote-only");
  assert.equal(result.errors[0]?.code, "local-unsupported");
  assert.equal(result.state.steps[0]?.status, "failed");
});

test("an already-aborted run is cancelled before invoking host operations", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runSetup({ root: "/stack", platform: "linux", actions: unusedActions, signal: controller.signal });

  assert.equal(result.cancelled, true);
  assert.equal(result.errors[0]?.code, "cancelled");
  assert.equal(result.completed, false);
});

test("cancellation between steps returns resumable state without starting the next host action", async () => {
  const controller = new AbortController();
  let inspected = false;
  const actions = {
    runChecks: async () => ({
      rootDir: "/stack",
      anyFail: false,
      results: [{ name: "Docker daemon", group: "Docker", status: "ok", detail: "ready" }],
    }),
    inspectStackInit: () => {
      inspected = true;
      throw new Error("must not inspect after cancellation");
    },
  } as unknown as SetupActions;
  const result = await runSetup({
    root: "/stack",
    platform: "linux",
    actions,
    signal: controller.signal,
    reporter: {
      onStepSettled: (step) => {
        if (step.id === "check") controller.abort();
      },
    },
  });

  assert.equal(inspected, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.state.steps.find((step) => step.id === "check")?.status, "done");
  assert.equal(result.state.steps.find((step) => step.id === "init-stack")?.status, "skipped");
});

test("progress and structured errors redact values identified as secrets", async () => {
  const events: SetupProgressEvent[] = [];
  const actions = {
    runChecks: async () => { throw new Error("token=very-secret-value"); },
  } as unknown as SetupActions;
  const result = await runSetup({
    root: "/stack",
    platform: "linux",
    actions,
    reporter: { onProgress: (event) => events.push(event) },
  });

  const serialized = JSON.stringify({ events, errors: result.errors, state: result.state });
  assert.doesNotMatch(serialized, /very-secret-value/);
  assert.match(serialized, /REDACTED/);
  assert.equal(result.errors[0]?.code, "step-failed");
});

test("retry preserves the previous root and re-evaluates platform capability", async () => {
  const previous = await runSetup({ root: "/chosen/root", platform: "win32", actions: unusedActions });
  const retried = await retrySetup(previous, { platform: "darwin", actions: unusedActions });
  assert.equal(retried.rootDir, "/chosen/root");
  assert.equal(retried.capability.platform, "darwin");
});
