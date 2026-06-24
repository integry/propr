/**
 * Engine tests. Run with: `npx tsx --test src/commands/setup/engine.test.ts`
 * (from packages/cli). Every side effect is mocked, so these run without
 * Docker, the network, or a TTY.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runSetup, type SetupActions, type SetupPrompts } from "./engine.js";
import type { ChecksOutcome } from "../checkCommands.js";
import type { AuthorizedInstallation } from "../../api/relay.js";
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
    clearEnvKeys: () => undefined,
    detectGithubAuthMode: () => APP_AUTH,
    pullImages: async () => ({ pulledCore: ["propr/api"], pulledAgents: [], failedCore: [], failedAgents: [] }),
    isStackRunning: async () => false,
    startStack: async () => undefined,
    checkBackendHealth: async () => ({ healthy: true, detail: "API healthy" }),
    addRepository: async () => undefined,
    resolveUiUrl: async () => "http://localhost:3000",
    openUrl: async () => undefined,
    saveWhitelistSetting: async () => undefined,
    // Relay enrollment / login actions — inert by default; relay tests override.
    hasGithubToken: () => true,
    fetchRelayInstallations: async () => ({ username: "octocat", installations: [] }),
    enrollRelay: async () => ({ relayUrl: "https://relay/v1", token: "prt_test" }),
    loginWithGithub: async () => true,
    // Agent enablement / image-login actions — inert by default so no test
    // touches the backend or Docker unless it overrides them.
    listAgents: async () => [],
    addAgent: async () => undefined,
    loginableAgents: async () => [],
    loginAgent: async () => ({ available: false, success: false }),
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

test("an incomplete stack root (missing dirs) is re-scaffolded even when .env exists", async () => {
  let scaffolded = false;
  const result = await runSetup({
    root: "/stack",
    actions: mockActions({
      // .env present but a required sub-directory is missing → not initialized.
      inspectStackInit: (rootDir) => ({
        rootDir,
        envExists: true,
        dirs: { data: true, logs: true, repos: false },
        initialized: false,
      }),
      scaffoldStack: async ({ root }) => {
        scaffolded = true;
        return { rootDir: root ?? "/stack", envCreated: false, envSkipped: true, envBackedUp: false, dirsCreated: ["repos"], detected: [], credentialsAppended: false, pendingCredentials: [] };
      },
    }),
  });

  assert.equal(scaffolded, true, "missing dirs must trigger scaffoldStack even with an existing .env");
  assert.equal(statusOf(result.state, "init-stack"), "done");
  assert.equal(result.completed, true);
});

test("unknown and duplicate agent selections are filtered to known types", async () => {
  let pulledAgentTypes: string[] | undefined;
  const prompts: SetupPrompts = {
    selectAgents: async () => ["claude", "claude", "bogus", "codex"],
  };
  await runSetup({
    root: "/stack",
    prompts,
    actions: mockActions({
      pullImages: async ({ agentTypes }) => {
        pulledAgentTypes = agentTypes;
        return { pulledCore: ["propr/api"], pulledAgents: [], failedCore: [], failedAgents: [] };
      },
    }),
  });

  assert.deepEqual(pulledAgentTypes, ["claude", "codex"], "duplicates de-duped and unknown names dropped");
});

test("a thrown setup action becomes a step failure, not an escaped exception", async () => {
  // checkBackendHealth throwing must be reported as a start-stack failure in the
  // returned state — runSetup must not reject for an expected action error.
  const result = await runSetup({
    root: "/stack",
    actions: mockActions({
      checkBackendHealth: async () => {
        throw new Error("socket hang up");
      },
    }),
  });

  assert.equal(statusOf(result.state, "start-stack"), "failed");
  assert.match(getStep(result.state, "start-stack")?.detail ?? "", /socket hang up/);
  assert.equal(result.completed, false);
  // The flow stops at the failed required step; later steps stay pending.
  assert.equal(statusOf(result.state, "whitelist"), "pending");
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

// --- relay enrollment in the auth step --------------------------------------

function inst(id: number, login: string, type = "User"): AuthorizedInstallation {
  return { installation_id: id, account_login: login, account_type: type };
}

/** Prompt that drives the relay enrollment path against the given URL. */
const relayPrompts = (extra: Partial<SetupPrompts> = {}): SetupPrompts => ({
  configureGithubAuth: async () => ({ mode: "relay", enrollRelay: { relayUrl: "https://relay/v1" } }),
  ...extra,
});

test("relay enrollment auto-selects a single installation and writes the relay vars", async () => {
  let relayVars: Record<string, string> | undefined;
  let enrolledId: string | undefined;
  const result = await runSetup({
    root: "/stack",
    prompts: relayPrompts(),
    actions: mockActions({
      hasGithubToken: () => true,
      fetchRelayInstallations: async () => ({ username: "octocat", installations: [inst(42, "octo-org", "Organization")] }),
      enrollRelay: async ({ installationId }) => {
        enrolledId = installationId;
        return { relayUrl: "https://relay/v1", token: "prt_minted" };
      },
      applyEnvSelection: (_root, vars) => {
        if (vars.GH_AUTH_MODE === "relay") relayVars = vars;
        return { written: Object.keys(vars), skipped: [] };
      },
    }),
  });
  assert.equal(statusOf(result.state, "github-auth"), "done");
  assert.equal(enrolledId, "42", "the sole installation is enrolled without prompting");
  assert.deepEqual(relayVars, {
    PROPR_DEMO_MODE: "false",
    GH_AUTH_MODE: "relay",
    PROPR_GH_RELAY_URL: "https://relay/v1",
    PROPR_GH_RELAY_TOKEN: "prt_minted",
    GH_INSTALLATION_ID: "42",
  });
});

test("relay enrollment asks the user to pick among multiple installations", async () => {
  let offered: AuthorizedInstallation[] | undefined;
  let enrolledId: string | undefined;
  await runSetup({
    root: "/stack",
    prompts: relayPrompts({
      selectInstallation: async ({ installations }) => {
        offered = installations;
        return "200";
      },
    }),
    actions: mockActions({
      hasGithubToken: () => true,
      fetchRelayInstallations: async () => ({
        username: "octocat",
        installations: [inst(100, "acme", "Organization"), inst(200, "widgets")],
      }),
      enrollRelay: async ({ installationId }) => {
        enrolledId = installationId;
        return { relayUrl: "https://relay/v1", token: "prt_x" };
      },
    }),
  });
  assert.equal(offered?.length, 2);
  assert.equal(enrolledId, "200", "the picked installation is the one enrolled");
});

test("relay enrollment offers an interactive login when no token, then enrolls", async () => {
  let loginCalled = false;
  let tokenPresent = false;
  let enrolled = false;
  const result = await runSetup({
    root: "/stack",
    prompts: relayPrompts({ confirmGithubLogin: async () => true }),
    actions: mockActions({
      hasGithubToken: () => tokenPresent,
      loginWithGithub: async () => {
        loginCalled = true;
        tokenPresent = true;
        return true;
      },
      fetchRelayInstallations: async () => ({ username: "octocat", installations: [inst(42, "octo-org")] }),
      enrollRelay: async () => {
        enrolled = true;
        return { relayUrl: "https://relay/v1", token: "prt_z" };
      },
    }),
  });
  assert.equal(loginCalled, true, "the login hook was honoured");
  assert.equal(enrolled, true, "enrollment proceeded once the token was present");
  assert.equal(statusOf(result.state, "github-auth"), "done");
});

test("relay enrollment without a token (and no login hook) warns and writes nothing", async () => {
  let relayWritten = false;
  const result = await runSetup({
    root: "/stack",
    prompts: relayPrompts(),
    actions: mockActions({
      hasGithubToken: () => false,
      detectGithubAuthMode: () => NO_AUTH,
      applyEnvSelection: (_root, vars) => {
        if (vars.GH_AUTH_MODE === "relay") relayWritten = true;
        return { written: Object.keys(vars), skipped: [] };
      },
    }),
  });
  assert.equal(statusOf(result.state, "github-auth"), "warning");
  assert.match(getStep(result.state, "github-auth")?.detail ?? "", /not logged in/);
  assert.equal(relayWritten, false, "no partial relay config is written without a token");
  // The run is not aborted by the warning.
  assert.notEqual(statusOf(result.state, "start-stack"), "pending");
});

test("a relay enrollment failure is a warning and the run still proceeds", async () => {
  const result = await runSetup({
    root: "/stack",
    prompts: relayPrompts(),
    actions: mockActions({
      hasGithubToken: () => true,
      fetchRelayInstallations: async () => ({ username: "octocat", installations: [inst(42, "octo-org")] }),
      enrollRelay: async () => {
        throw new Error("HTTP 403 forbidden");
      },
    }),
  });
  assert.equal(statusOf(result.state, "github-auth"), "warning");
  assert.match(getStep(result.state, "github-auth")?.detail ?? "", /relay enrollment failed/);
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

test("selecting polling selects the mode via GITHUB_EVENT_INTAKE_MODE", async () => {
  let intakeVars: Record<string, string> | undefined;
  const result = await runSetup({
    root: "/stack",
    prompts: { configureIntake: async () => ({ mode: "polling" }) },
    actions: mockActions({
      applyEnvSelection: (_root, vars) => {
        if ("GITHUB_EVENT_INTAKE_MODE" in vars) intakeVars = vars;
        return { written: Object.keys(vars), skipped: [] };
      },
    }),
  });

  // App auth qualifies for polling, so the step completes cleanly.
  assert.equal(statusOf(result.state, "intake"), "done");
  assert.deepEqual(intakeVars, { GITHUB_EVENT_INTAKE_MODE: "polling" });
});

test("selecting direct webhooks selects the mode and writes the signing secret", async () => {
  let intakeVars: Record<string, string> | undefined;
  const result = await runSetup({
    root: "/stack",
    prompts: { configureIntake: async () => ({ mode: "direct_webhook", webhookSecret: "s3cret" }) },
    actions: mockActions({
      applyEnvSelection: (_root, vars) => {
        if ("GITHUB_EVENT_INTAKE_MODE" in vars) intakeVars = vars;
        return { written: Object.keys(vars), skipped: [] };
      },
    }),
  });

  // App auth + a freshly written secret satisfies the direct_webhook prerequisites.
  assert.equal(statusOf(result.state, "intake"), "done");
  assert.deepEqual(intakeVars, { GITHUB_EVENT_INTAKE_MODE: "direct_webhook", GH_WEBHOOK_SECRET: "s3cret" });
});

test("an empty webhook secret is rejected without writing intake .env", async () => {
  let intakeWritten = false;
  const result = await runSetup({
    root: "/stack",
    prompts: { configureIntake: async () => ({ mode: "direct_webhook", webhookSecret: "   " }) },
    actions: mockActions({
      applyEnvSelection: (_root, vars) => {
        if ("GITHUB_EVENT_INTAKE_MODE" in vars) intakeWritten = true;
        return { written: [], skipped: [] };
      },
    }),
  });

  assert.equal(statusOf(result.state, "intake"), "warning", "an empty secret must be rejected, not written");
  assert.equal(intakeWritten, false);
  assert.equal(result.completed, true, "a rejected secret is non-blocking");
});

test("routing_websocket without relay auth warns with a prerequisite hint", async () => {
  // The relay routing default only works with relay auth + a relay token. App
  // auth selecting it must surface the gap here, not at backend boot.
  const result = await runSetup({
    root: "/stack",
    prompts: { configureIntake: async () => ({ mode: "routing_websocket" }) },
    actions: mockActions({
      detectGithubAuthMode: () => APP_AUTH,
      readEnvVars: () => ({}),
    }),
  });

  assert.equal(statusOf(result.state, "intake"), "warning");
  assert.match(getStep(result.state, "intake")?.detail ?? "", /relay/i);
  assert.match(getStep(result.state, "intake")?.nextAction ?? "", /relay enroll|polling/);
});

test("routing_websocket with relay auth + a relay token is wired correctly", async () => {
  const result = await runSetup({
    root: "/stack",
    prompts: { configureIntake: async () => ({ mode: "routing_websocket" }) },
    actions: mockActions({
      detectGithubAuthMode: () => ({ mode: "relay", warnings: [] }),
      // A relay-enrolled stack: token present, URLs default to the hosted relay.
      readEnvVars: () => ({ PROPR_GH_RELAY_TOKEN: "relay-token" }),
    }),
  });

  assert.equal(statusOf(result.state, "intake"), "done");
  assert.match(getStep(result.state, "intake")?.detail ?? "", /routing WebSocket/);
});

test("an existing intake config defaults the prompt to keep, not the auth recommendation", async () => {
  // App auth would otherwise recommend "polling"; because .env already records
  // GITHUB_EVENT_INTAKE_MODE, the prompt must default to "keep".
  let seenDefault: string | undefined;
  let intakeWritten = false;
  const result = await runSetup({
    root: "/stack",
    prompts: {
      configureIntake: async ({ defaultMode }) => {
        seenDefault = defaultMode;
        return { keep: true };
      },
    },
    actions: mockActions({
      detectGithubAuthMode: () => APP_AUTH,
      readEnvVars: () => ({
        GITHUB_EVENT_INTAKE_MODE: "direct_webhook",
        GH_WEBHOOK_SECRET: "s3cret",
        GITHUB_USER_WHITELIST: "alice",
      }),
      applyEnvSelection: (_root, vars) => {
        if ("GITHUB_EVENT_INTAKE_MODE" in vars) intakeWritten = true;
        return { written: Object.keys(vars), skipped: [] };
      },
    }),
  });

  assert.equal(seenDefault, "keep", "an existing intake config pre-selects keep");
  assert.equal(intakeWritten, false, "keeping must not rewrite the intake .env keys");
  assert.equal(statusOf(result.state, "intake"), "done");
  assert.match(getStep(result.state, "intake")?.detail ?? "", /direct webhooks/);
});

test("a fresh install (no intake key) defaults the prompt to the auth recommendation", async () => {
  let seenDefault: string | undefined;
  await runSetup({
    root: "/stack",
    prompts: {
      configureIntake: async ({ defaultMode }) => {
        seenDefault = defaultMode;
        return { keep: true };
      },
    },
    actions: mockActions({
      detectGithubAuthMode: () => APP_AUTH,
      readEnvVars: () => ({}),
    }),
  });

  assert.equal(seenDefault, "polling", "no intake key yet → auth-derived recommendation (app → polling)");
});

test("duplicate whitelist entries are de-duped before saving", async () => {
  let settingsUsers: string[] | undefined;
  const result = await runSetup({
    root: "/stack",
    prompts: { configureWhitelist: async () => ["alice", " alice ", "bob", "alice"] },
    actions: mockActions({
      isStackRunning: async () => true,
      saveWhitelistSetting: async (_root, users) => {
        settingsUsers = users;
      },
    }),
  });

  assert.deepEqual(settingsUsers, ["alice", "bob"], "trimmed and de-duped, first occurrence wins");
  assert.match(getStep(result.state, "whitelist")?.detail ?? "", /2 user\(s\)/);
});

test("demo mode skips GitHub intake", async () => {
  const result = await runSetup({
    root: "/stack",
    actions: mockActions({ detectGithubAuthMode: () => ({ mode: "demo", warnings: [] }) }),
  });
  assert.equal(statusOf(result.state, "intake"), "skipped");
});

test("whitelist is saved through the settings API when the backend is running", async () => {
  let settingsUsers: string[] | undefined;
  let mirroredEnv: string | undefined;
  const result = await runSetup({
    root: "/stack",
    prompts: { configureWhitelist: async () => ["carol", "dave"] },
    actions: mockActions({
      isStackRunning: async () => true,
      saveWhitelistSetting: async (_root, users) => {
        settingsUsers = users;
      },
      applyEnvSelection: (_root, vars) => {
        if ("GITHUB_USER_WHITELIST" in vars) mirroredEnv = vars.GITHUB_USER_WHITELIST;
        return { written: Object.keys(vars), skipped: [] };
      },
    }),
  });

  assert.equal(statusOf(result.state, "whitelist"), "done");
  assert.deepEqual(settingsUsers, ["carol", "dave"], "saved through the settings API");
  assert.equal(mirroredEnv, "carol,dave", "also mirrored into .env for durability");
  assert.match(getStep(result.state, "whitelist")?.detail ?? "", /settings API/);
});

test("whitelist falls back to .env when the backend is not running", async () => {
  let settingsCalled = false;
  let envWhitelist: string | undefined;
  const result = await runSetup({
    root: "/stack",
    prompts: { configureWhitelist: async () => ["erin"] },
    actions: mockActions({
      isStackRunning: async () => false,
      saveWhitelistSetting: async () => {
        settingsCalled = true;
      },
      applyEnvSelection: (_root, vars) => {
        if ("GITHUB_USER_WHITELIST" in vars) envWhitelist = vars.GITHUB_USER_WHITELIST;
        return { written: Object.keys(vars), skipped: [] };
      },
    }),
  });

  assert.equal(settingsCalled, false, "the settings API is not used when the backend is down");
  assert.equal(envWhitelist, "erin");
  assert.equal(statusOf(result.state, "whitelist"), "done");
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
    ["check", "init-stack", "pull-images", "configure-agents", "github-auth", "intake", "start-stack", "enable-agents", "whitelist", "repo", "launch-ui"]
  );
});
