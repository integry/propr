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

test("platform capabilities support Linux and macOS while Windows remains remote-only", () => {
  assert.deepEqual(getLocalSetupCapability("linux"), {
    supported: true,
    kind: "local",
    platform: "linux",
  });
  assert.deepEqual(getLocalSetupCapability("darwin"), { supported: true, kind: "local", platform: "darwin" });
  for (const platform of ["win32"] as const) {
    const capability = getLocalSetupCapability(platform);
    assert.equal(capability.supported, false);
    assert.equal(capability.kind, "remote-only");
    assert.match(capability.reason, /remote ProPR deployment/);
  }
});

for (const platform of ["darwin", "win32"] as const) {
  test(`the setup engine remains platform-neutral on ${platform}`, async () => {
    let checksRun = false;
    const actions = {
      runChecks: async () => {
        checksRun = true;
        return {
          rootDir: "/stack",
          anyFail: true,
          results: [{ name: "Docker daemon", group: "Docker", status: "fail", detail: "not running" }],
        };
      },
    } as unknown as SetupActions;
    const result = await runSetup({ root: "/stack", platform, actions });

    assert.equal(checksRun, true);
    assert.equal(result.completed, false);
    assert.equal(result.capability.kind, platform === "darwin" ? "local" : "remote-only");
    assert.notEqual(result.errors[0]?.code, "local-unsupported");
  });
}

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

test('Darwin remote Docker endpoint blocks provisioning with endpoint-specific recovery', async () => {
  const fix = 'Select a local Docker Desktop context; unset DOCKER_HOST pointing to a remote daemon.';
  let pulls = 0;
  const result = await runSetup({ root: '/stack', platform: 'darwin', actions: {
    runChecks: async () => ({ rootDir: '/stack', anyFail: true, results: [
      { name: 'Docker daemon', group: 'Docker', status: 'ok', detail: 'ready' },
      { name: 'Docker local endpoint', group: 'Docker', status: 'fail', detail: 'Remote endpoint', fix },
    ] }),
    pullImages: async () => { pulls++; throw new Error('must not pull'); },
  } as unknown as SetupActions });
  assert.equal(pulls, 0);
  assert.equal(result.completed, false);
  const check = result.state.steps.find(step => step.id === 'check');
  assert.equal(check?.status, 'failed');
  assert.equal(check?.detail, 'Remote endpoint');
  assert.equal(check?.nextAction, fix);
});
