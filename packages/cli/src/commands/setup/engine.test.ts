/**
 * Engine tests. Run with: `npx tsx --test src/commands/setup/engine.test.ts`
 * (from packages/cli). Every side effect is mocked, so these run without
 * Docker, the network, or a TTY.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runSetup, type SetupActions, type SetupPrompts } from "./engine.js";
import type { ChecksOutcome } from "../checkCommands.js";
import type { GithubAuthModeResult } from "@propr/shared";
import { getStep } from "./state.js";
import type { SetupState } from "./types.js";

/** A passing environment-check outcome (Docker present, daemon up). */
function okChecks(rootDir: string): ChecksOutcome {
  return {
    rootDir,
    anyFail: false,
    // Only `results` is read by the engine; cfg is irrelevant to these tests.
    cfg: {} as ChecksOutcome["cfg"],
    results: [
      { name: "Docker installed", status: "ok", detail: "Docker version 27", group: "Docker" },
      { name: "Docker daemon", status: "ok", detail: "daemon is reachable", group: "Docker" },
    ],
  };
}

const APP_AUTH: GithubAuthModeResult = { mode: "app", warnings: [] };
const NO_AUTH: GithubAuthModeResult = { mode: "none", warnings: [] };

/** Build a fully-mocked action set; override any subset per test. */
function mockActions(overrides: Partial<SetupActions> = {}): SetupActions {
  return {
    runChecks: async ({ root }) => okChecks(root ?? "/stack"),
    inspectStackInit: (rootDir) => ({
      rootDir,
      envExists: true,
      dirs: { data: true, logs: true, repos: true },
      initialized: true,
    }),
    scaffoldStack: async ({ root }) => {
      throw new Error(`scaffoldStack must not run for an initialized stack (${root})`);
    },
    readEnvVars: () => ({ GITHUB_USER_WHITELIST: "alice,bob" }),
    applyEnvSelection: () => ({ written: [], skipped: [] }),
    detectGithubAuthMode: () => APP_AUTH,
    pullImages: async () => ({ pulledCore: ["propr/api"], pulledAgents: [], failedCore: [], failedAgents: [] }),
    isStackRunning: async () => false,
    startStack: async () => undefined,
    checkBackendHealth: async () => ({ healthy: true, detail: "API healthy" }),
    addRepository: async () => undefined,
    resolveUiUrl: async () => "http://localhost:3000",
    ...overrides,
  };
}

function statusOf(state: SetupState, id: Parameters<typeof getStep>[1]): string | undefined {
  return getStep(state, id)?.status;
}

test("re-running on an initialized stack leaves it intact and completes", async () => {
  let scaffoldCalled = false;
  const result = await runSetup({
    root: "/stack",
    actions: mockActions({
      scaffoldStack: async () => {
        scaffoldCalled = true;
        throw new Error("should not be called");
      },
    }),
  });

  assert.equal(scaffoldCalled, false, "scaffoldStack must not run when .env already exists");
  assert.equal(statusOf(result.state, "init-stack"), "skipped");
  assert.equal(result.completed, true);
});

test("pulls only core images plus the selected agents", async () => {
  let pulledAgentTypes: string[] | undefined;
  const prompts: SetupPrompts = {
    selectAgents: async () => ["claude", "codex"],
  };
  await runSetup({
    root: "/stack",
    prompts,
    actions: mockActions({
      pullImages: async ({ agentTypes }) => {
        pulledAgentTypes = agentTypes;
        return { pulledCore: ["propr/api"], pulledAgents: ["propr/agent-claude"], failedCore: [], failedAgents: [] };
      },
    }),
  });

  assert.deepEqual(pulledAgentTypes, ["claude", "codex"]);
});

test("optional repo step can be skipped without failing the run", async () => {
  // No addRepository prompt at all → repo is skipped.
  const result = await runSetup({ root: "/stack", actions: mockActions() });
  assert.equal(statusOf(result.state, "repo"), "skipped");
  assert.equal(result.completed, true);
});

test("a failed repo addition is a warning, not a fatal error", async () => {
  const prompts: SetupPrompts = {
    addRepository: async () => ({ fullName: "octo/repo" }),
  };
  const result = await runSetup({
    root: "/stack",
    prompts,
    actions: mockActions({
      addRepository: async () => {
        throw new Error("backend unreachable");
      },
    }),
  });

  assert.equal(statusOf(result.state, "repo"), "warning");
  assert.equal(result.completed, true, "an optional-step warning must not block completion");
});

test("a missing Docker daemon blocks the flow at the check step", async () => {
  const result = await runSetup({
    root: "/stack",
    actions: mockActions({
      runChecks: async ({ root }) => ({
        rootDir: root ?? "/stack",
        anyFail: true,
        cfg: {} as ChecksOutcome["cfg"],
        results: [
          { name: "Docker installed", status: "ok", detail: "v27", group: "Docker" },
          { name: "Docker daemon", status: "fail", detail: "cannot reach the Docker daemon", group: "Docker" },
        ],
      }),
    }),
  });

  assert.equal(statusOf(result.state, "check"), "failed");
  assert.equal(statusOf(result.state, "pull-images"), "pending", "no later step should run");
  assert.equal(result.completed, false);
});

test("missing GitHub auth surfaces a warning but does not abort", async () => {
  const result = await runSetup({
    root: "/stack",
    actions: mockActions({ detectGithubAuthMode: () => NO_AUTH }),
  });
  assert.equal(statusOf(result.state, "github-auth"), "warning");
  // The flow still reaches the end.
  assert.notEqual(statusOf(result.state, "start-stack"), "pending");
});

test("an unhealthy backend after startup is reported as a warning", async () => {
  const result = await runSetup({
    root: "/stack",
    actions: mockActions({
      isStackRunning: async () => false,
      checkBackendHealth: async () => ({ healthy: false, detail: "backend not healthy within 60s" }),
    }),
  });
  assert.equal(statusOf(result.state, "start-stack"), "warning");
});

test("an already-running stack is reused, not restarted", async () => {
  let started = false;
  const result = await runSetup({
    root: "/stack",
    actions: mockActions({
      isStackRunning: async () => true,
      startStack: async () => {
        started = true;
      },
    }),
  });
  assert.equal(started, false, "a running stack must not be restarted");
  assert.equal(statusOf(result.state, "start-stack"), "done");
});

test("prompts drive a full unattended run to completion", async () => {
  const seen: string[] = [];
  const prompts: SetupPrompts = {
    selectAgents: async () => ["claude"],
    configureGithubAuth: async () => ({ keep: true }),
    confirmStartStack: async () => true,
    configureWhitelist: async () => ["carol"],
    addRepository: async () => ({ fullName: "octo/repo", baseBranch: "main" }),
    launchUi: async () => true,
  };
  const result = await runSetup({
    root: "/stack",
    prompts,
    reporter: { onStepSettled: (s) => seen.push(`${s.id}:${s.status}`) },
    actions: mockActions(),
  });

  assert.equal(result.completed, true);
  assert.equal(statusOf(result.state, "launch-ui"), "done");
  // Every step settled exactly once, in order.
  assert.deepEqual(
    seen.map((s) => s.split(":")[0]),
    ["check", "init-stack", "pull-images", "configure-agents", "github-auth", "start-stack", "whitelist", "repo", "launch-ui"]
  );
});
