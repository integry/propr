import { test } from "node:test";
import assert from "node:assert";
import { startOrRestartTunnelStack } from "../packages/cli/src/commands/tunnelCommand.js";
import type {
  OrchestratorConfig,
  OrchestratorModule,
  StackStatus,
} from "../packages/cli/src/orchestrator/index.js";

const cfg = {
  docsEnabled: false,
  stack: "propr",
} as OrchestratorConfig;

const emptyStatus: StackStatus = {
  stack: "propr",
  network: "propr-net",
  running: false,
  services: [],
};

function makeOrchestrator(overrides: {
  running?: boolean;
  stopFailed?: string[];
}) {
  const calls: string[] = [];
  const orch = {
    isStackRunningAsync: async () => {
      calls.push("isStackRunningAsync");
      return overrides.running ?? false;
    },
    stopStack: () => {
      calls.push("stopStack");
      return { failed: overrides.stopFailed ?? [] };
    },
    ensureNetworkAsync: async () => {
      calls.push("ensureNetworkAsync");
    },
    startStackAsync: async (_cfg: OrchestratorConfig, options?: { ui?: boolean; docs?: boolean }) => {
      calls.push(`startStackAsync:${String(options?.ui)}:${String(options?.docs)}`);
      return emptyStatus;
    },
  } as unknown as OrchestratorModule;

  return { orch, calls };
}

test("tunnel setup --start starts a stopped stack with tunnel settings", async () => {
  const { orch, calls } = makeOrchestrator({ running: false });

  await startOrRestartTunnelStack(
    orch,
    cfg,
    { getUiEnabled: () => true },
    () => undefined
  );

  assert.deepEqual(calls, [
    "isStackRunningAsync",
    "ensureNetworkAsync",
    "startStackAsync:true:false",
  ]);
});

test("tunnel setup --start recreates an already-running stack", async () => {
  const { orch, calls } = makeOrchestrator({ running: true });

  await startOrRestartTunnelStack(
    orch,
    cfg,
    { getUiEnabled: () => true },
    () => undefined
  );

  assert.deepEqual(calls, [
    "isStackRunningAsync",
    "stopStack",
    "ensureNetworkAsync",
    "startStackAsync:true:false",
  ]);
});

test("tunnel setup --start fails before starting when existing stack cannot stop", async () => {
  const { orch, calls } = makeOrchestrator({
    running: true,
    stopFailed: ["propr-api"],
  });

  await assert.rejects(
    startOrRestartTunnelStack(
      orch,
      cfg,
      { getUiEnabled: () => true },
      () => undefined
    ),
    /Failed to stop existing stack services: propr-api/
  );

  assert.deepEqual(calls, ["isStackRunningAsync", "stopStack"]);
});
