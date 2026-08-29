/**
 * Engine tests. Run with: `npx tsx --test src/commands/setup/engine.test.ts`
 * (from packages/cli). Every side effect is mocked, so these run without
 * Docker, the network, or a TTY.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyBackendAccessError, retrySetup, runSetup, type SetupActions, type SetupPrompts } from "./engine.js";
import type { ChecksOutcome } from "../checkCommands.js";
import type { AuthorizedInstallation } from "../../api/relay.js";
import { DEFAULT_PROPR_GH_RELAY_URL, type GithubAuthModeResult } from "@propr/shared";
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
    inspectDatastoreAdministrators: async () => ({ status: "has-admin", databasePath: "/stack/data/propr.sqlite" }),
    scaffoldStack: async ({ root }) => {
      throw new Error(`scaffoldStack must not run for an initialized stack (${root})`);
    },
    persistStackRoot: async () => undefined,
    readEnvVars: () => ({
      GITHUB_EVENT_INTAKE_MODE: "polling",
      GITHUB_USER_WHITELIST: "alice,bob",
    }),
    applyEnvSelection: () => ({ written: [], skipped: [] }),
    clearEnvKeys: () => undefined,
    detectGithubAuthMode: () => APP_AUTH,
    prepareAgentCredentialDir: () => undefined,
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
    validateAgents: async (_root, types) => types.map((type) => ({ type, status: "ok", detail: "connected" })),
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
        return { rootDir: root ?? "/stack", envCreated: false, envSkipped: true, envBackedUp: false, dirsCreated: ["repos"], dirsSkipped: ["data", "logs"], detected: [], credentialsAppended: false, pendingCredentials: [] };
      },
    }),
  });

  assert.equal(scaffolded, true, "missing dirs must trigger scaffoldStack even with an existing .env");
  assert.equal(statusOf(result.state, "init-stack"), "done");
  assert.equal(result.completed, true);
});

test("fresh scaffolding persists the resolved root through setup's active config", async () => {
  let persistedRoot: string | undefined;
  const result = await runSetup({
    root: "relative-stack",
    actions: mockActions({
      inspectStackInit: (rootDir) => ({
        rootDir,
        envExists: false,
        dirs: { data: false, logs: false, repos: false },
        initialized: false,
      }),
      scaffoldStack: async () => ({
        rootDir: "/resolved/stack",
        envCreated: true,
        envSkipped: false,
        envBackedUp: false,
        dirsCreated: ["data", "logs", "repos"],
        dirsSkipped: [],
        detected: [],
        credentialsAppended: false,
        pendingCredentials: [],
      }),
      persistStackRoot: async (rootDir) => {
        persistedRoot = rootDir;
      },
    }),
  });

  assert.equal(persistedRoot, "/resolved/stack");
  assert.equal(result.state.rootDir, "/resolved/stack");
  assert.equal(result.completed, true);
});

test("a datastore inspection exception settles init-stack once as failed", async () => {
  const settlements: string[] = [];
  const result = await runSetup({
    root: "/stack",
    reporter: {
      onStepSettled: (step) => {
        if (step.id === "init-stack") settlements.push(step.status);
      },
    },
    actions: mockActions({
      inspectDatastoreAdministrators: async () => {
        throw new Error("inspection crashed");
      },
    }),
  });

  assert.deepEqual(settlements, ["failed"]);
  assert.equal(statusOf(result.state, "init-stack"), "failed");
  assert.match(getStep(result.state, "init-stack")?.detail ?? "", /inspection crashed/);
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
        return { pulledCore: ["propr/api"], pulledAgents: ["propr/agent"], failedCore: [], failedAgents: [] };
      },
    }),
  });

  assert.deepEqual(pulledAgentTypes, ["claude", "codex"]);
});

test("prepares an existing custom agent credential path before starting the stack", async () => {
  const customCredentialDir = "/missing/custom/codex-credentials";
  const prepared: string[] = [];
  let started = false;

  await runSetup({
    root: "/stack",
    prompts: { selectAgents: async () => ["codex"] },
    actions: mockActions({
      readEnvVars: () => ({
        GITHUB_EVENT_INTAKE_MODE: "polling",
        GITHUB_USER_WHITELIST: "alice,bob",
        HOST_CODEX_DIR: customCredentialDir,
      }),
      prepareAgentCredentialDir: (path) => {
        assert.equal(started, false, "credential path must be prepared before Docker starts");
        prepared.push(path);
      },
      startStack: async () => {
        started = true;
      },
    }),
  });

  assert.deepEqual(prepared, [customCredentialDir]);
  assert.equal(started, true);
});

test("rejects unsafe agent credential paths before filesystem preparation", async () => {
  const unsafePaths = ["relative/credentials", "/", "/tmp/credentials:rw", "/tmp/credentials\nother"];

  for (const unsafePath of unsafePaths) {
    let prepareCalled = false;
    const result = await runSetup({
      root: "/stack",
      prompts: { selectAgents: async () => ["codex"] },
      actions: mockActions({
        readEnvVars: () => ({ HOST_CODEX_DIR: unsafePath }),
        prepareAgentCredentialDir: () => {
          prepareCalled = true;
        },
      }),
    });

    assert.equal(prepareCalled, false, `must not prepare unsafe path ${JSON.stringify(unsafePath)}`);
    assert.equal(statusOf(result.state, "configure-agents"), "failed");
    assert.match(getStep(result.state, "configure-agents")?.detail ?? "", /absolute, non-root Linux path/);
  }
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

test("missing GitHub auth blocks startup instead of launching a broken stack", async () => {
  const result = await runSetup({
    root: "/stack",
    actions: mockActions({ detectGithubAuthMode: () => NO_AUTH }),
  });
  assert.equal(statusOf(result.state, "github-auth"), "failed");
  assert.equal(statusOf(result.state, "start-stack"), "pending");
  assert.equal(result.completed, false);
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
    prompts: relayPrompts({
      configureGithubAuth: async () => ({
        mode: "relay",
        enrollRelay: { relayUrl: DEFAULT_PROPR_GH_RELAY_URL },
      }),
    }),
    actions: mockActions({
      inspectStackInit: (rootDir) => ({
        rootDir,
        envExists: false,
        dirs: { data: false, logs: false, repos: false },
        initialized: false,
      }),
      inspectDatastoreAdministrators: async () => ({ status: "absent", databasePath: "/stack/data/propr.sqlite" }),
      scaffoldStack: async ({ root }) => ({
        rootDir: root ?? "/stack",
        envCreated: true,
        envSkipped: false,
        envBackedUp: false,
        dirsCreated: ["data", "logs", "repos"],
        dirsSkipped: [],
        detected: [],
        credentialsAppended: false,
        pendingCredentials: [],
      }),
      hasGithubToken: () => true,
      fetchRelayInstallations: async () => ({ username: "octocat", installations: [inst(42, "octo-org", "Organization")] }),
      enrollRelay: async ({ installationId }) => {
        enrolledId = installationId;
        return { relayUrl: DEFAULT_PROPR_GH_RELAY_URL, token: "prt_minted" };
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
    PROPR_GH_RELAY_URL: DEFAULT_PROPR_GH_RELAY_URL,
    PROPR_GH_RELAY_TOKEN: "prt_minted",
    GH_INSTALLATION_ID: "42",
    PROPR_WEB_AUTH_MODE: "connect",
    PROPR_ADMIN_USERS: "octocat",
    GITHUB_USER_WHITELIST: "alice,bob,octocat",
  });
});

test("relay enrollment seeds a migrated datastore that has no durable administrator", async () => {
  let relayVars: Record<string, string> | undefined;
  const result = await runSetup({
    root: "/stack",
    prompts: relayPrompts(),
    actions: mockActions({
      inspectDatastoreAdministrators: async () => ({ status: "no-admin", databasePath: "/stack/data/propr.sqlite" }),
      readEnvVars: () => ({ GITHUB_EVENT_INTAKE_MODE: "polling" }),
      hasGithubToken: () => true,
      fetchRelayInstallations: async () => ({ username: "octocat", installations: [inst(42, "octo-org")] }),
      applyEnvSelection: (_root, vars) => {
        if (vars.GH_AUTH_MODE === "relay") relayVars = vars;
        return { written: Object.keys(vars), skipped: [] };
      },
    }),
  });

  assert.equal(statusOf(result.state, "github-auth"), "done");
  assert.equal(relayVars?.PROPR_ADMIN_USERS, "octocat");
  assert.equal(relayVars?.GITHUB_USER_WHITELIST, "octocat");
  assert.match(getStep(result.state, "github-auth")?.detail ?? "", /bootstrap administrator: octocat/);
});

test("relay enrollment seeds when PROPR_ADMIN_USERS contains no effective usernames", async () => {
  let relayVars: Record<string, string> | undefined;
  const result = await runSetup({
    root: "/stack",
    prompts: relayPrompts(),
    actions: mockActions({
      inspectDatastoreAdministrators: async () => ({ status: "absent", databasePath: "/stack/data/propr.sqlite" }),
      readEnvVars: () => ({
        GITHUB_EVENT_INTAKE_MODE: "polling",
        PROPR_ADMIN_USERS: " , , ",
        GITHUB_USER_WHITELIST: "alice",
      }),
      hasGithubToken: () => true,
      fetchRelayInstallations: async () => ({ username: "octocat", installations: [inst(42, "octo-org")] }),
      applyEnvSelection: (_root, vars) => {
        if (vars.GH_AUTH_MODE === "relay") relayVars = vars;
        return { written: Object.keys(vars), skipped: [] };
      },
    }),
  });

  assert.equal(relayVars?.PROPR_ADMIN_USERS, "octocat");
  assert.equal(relayVars?.GITHUB_USER_WHITELIST, "alice,octocat");
  assert.match(getStep(result.state, "github-auth")?.detail ?? "", /bootstrap administrator: octocat/);
});

test("keeping relay auth seeds its authenticated identity before starting an adminless stack", async () => {
  const env: Record<string, string> = {
    GH_AUTH_MODE: "relay",
    GH_INSTALLATION_ID: "42",
    PROPR_GH_RELAY_URL: "https://relay/v1",
    PROPR_GH_RELAY_TOKEN: "prt_existing",
    GITHUB_EVENT_INTAKE_MODE: "polling",
    GITHUB_USER_WHITELIST: "alice",
  };
  let startCalled = false;
  const result = await runSetup({
    root: "/stack",
    prompts: { configureGithubAuth: async () => ({ keep: true }) },
    actions: mockActions({
      inspectDatastoreAdministrators: async () => ({ status: "no-admin", databasePath: "/stack/data/propr.sqlite" }),
      readEnvVars: () => ({ ...env }),
      detectGithubAuthMode: () => ({ mode: "relay", warnings: [] }),
      hasGithubToken: () => true,
      fetchRelayInstallations: async () => ({ username: "octocat", installations: [inst(42, "octo-org")] }),
      applyEnvSelection: (_root, vars) => {
        Object.assign(env, vars);
        return { written: Object.keys(vars), skipped: [] };
      },
      startStack: async () => {
        startCalled = true;
      },
    }),
  });

  assert.equal(env.PROPR_ADMIN_USERS, "octocat");
  assert.equal(env.GITHUB_USER_WHITELIST, "alice,octocat");
  assert.match(getStep(result.state, "github-auth")?.detail ?? "", /bootstrap administrator: octocat/);
  assert.equal(startCalled, true);
});

test("keeping non-demo auth without a safe bootstrap identity blocks startup", async () => {
  let startCalled = false;
  const result = await runSetup({
    root: "/stack",
    prompts: { configureGithubAuth: async () => ({ keep: true }) },
    actions: mockActions({
      inspectDatastoreAdministrators: async () => ({ status: "no-admin", databasePath: "/stack/data/propr.sqlite" }),
      readEnvVars: () => ({
        GH_AUTH_MODE: "relay",
        GH_INSTALLATION_ID: "42",
        PROPR_GH_RELAY_URL: "https://relay/v1",
        PROPR_GH_RELAY_TOKEN: "prt_existing",
        GITHUB_EVENT_INTAKE_MODE: "polling",
      }),
      detectGithubAuthMode: () => ({ mode: "relay", warnings: [] }),
      hasGithubToken: () => false,
      startStack: async () => {
        startCalled = true;
      },
    }),
  });

  assert.equal(statusOf(result.state, "github-auth"), "failed");
  assert.match(getStep(result.state, "github-auth")?.detail ?? "", /no instance administrator/);
  assert.equal(statusOf(result.state, "start-stack"), "pending");
  assert.equal(startCalled, false);
});

test("relay enrollment leaves the whitelist unchanged when an environment administrator already exists", async () => {
  let relayVars: Record<string, string> | undefined;
  const result = await runSetup({
    root: "/stack",
    prompts: relayPrompts(),
    actions: mockActions({
      inspectDatastoreAdministrators: async () => ({
        status: "uninspectable",
        databasePath: "/stack/data/propr.sqlite",
        detail: "database is locked",
      }),
      readEnvVars: () => ({ GITHUB_EVENT_INTAKE_MODE: "polling", PROPR_ADMIN_USERS: "alice" }),
      hasGithubToken: () => true,
      fetchRelayInstallations: async () => ({ username: "octocat", installations: [inst(42, "octo-org")] }),
      applyEnvSelection: (_root, vars) => {
        if (vars.GH_AUTH_MODE === "relay") relayVars = vars;
        return { written: Object.keys(vars), skipped: [] };
      },
    }),
  });

  assert.equal(relayVars?.PROPR_ADMIN_USERS, undefined);
  assert.equal(relayVars?.GITHUB_USER_WHITELIST, undefined);
  assert.match(getStep(result.state, "github-auth")?.detail ?? "", /kept existing administrators/);
});

test("an uninspectable datastore without an environment administrator blocks startup", async () => {
  let startCalled = false;
  const initSettlements: string[] = [];
  const result = await runSetup({
    root: "/stack",
    reporter: {
      onStepSettled: (step) => {
        if (step.id === "init-stack") initSettlements.push(step.status);
      },
    },
    actions: mockActions({
      inspectDatastoreAdministrators: async () => ({
        status: "uninspectable",
        databasePath: "/external/propr.sqlite",
        detail: "database is locked",
      }),
      readEnvVars: () => ({
        GITHUB_EVENT_INTAKE_MODE: "polling",
        GITHUB_USER_WHITELIST: "alice,bob",
        PROPR_ADMIN_USERS: " , , ",
      }),
      startStack: async () => {
        startCalled = true;
      },
    }),
  });

  assert.deepEqual(initSettlements, ["skipped"], "init-stack must settle exactly once");
  assert.equal(statusOf(result.state, "github-auth"), "failed");
  assert.match(getStep(result.state, "github-auth")?.detail ?? "", /database is locked/);
  assert.equal(statusOf(result.state, "start-stack"), "pending");
  assert.equal(startCalled, false, "startStack must not run without a verified administrator");
});

test("demo mode permits startup when the datastore administrator cannot be inspected", async () => {
  let startCalled = false;
  const result = await runSetup({
    root: "/stack",
    actions: mockActions({
      inspectDatastoreAdministrators: async () => ({
        status: "uninspectable",
        databasePath: "/external/propr.sqlite",
        detail: "database is locked",
      }),
      readEnvVars: () => ({ PROPR_DEMO_MODE: "true" }),
      detectGithubAuthMode: () => ({ mode: "demo", warnings: [] }),
      startStack: async () => {
        startCalled = true;
      },
    }),
  });

  assert.equal(statusOf(result.state, "github-auth"), "done");
  assert.equal(statusOf(result.state, "start-stack"), "done");
  assert.equal(startCalled, true);
});

for (const proprDemoMode of [undefined, "false"] as const) {
  test(`GH_AUTH_MODE=demo does not bypass administrator preflight when PROPR_DEMO_MODE is ${proprDemoMode ?? "absent"}`, async () => {
    let startCalled = false;
    const result = await runSetup({
      root: "/stack",
      actions: mockActions({
        inspectDatastoreAdministrators: async () => ({
          status: "no-admin",
          databasePath: "/stack/data/propr.sqlite",
        }),
        readEnvVars: () => ({
          GH_AUTH_MODE: "demo",
          ...(proprDemoMode === undefined ? {} : { PROPR_DEMO_MODE: proprDemoMode }),
        }),
        detectGithubAuthMode: () => ({ mode: "demo", warnings: [] }),
        startStack: async () => {
          startCalled = true;
        },
      }),
    });

    assert.equal(statusOf(result.state, "github-auth"), "failed");
    assert.match(getStep(result.state, "github-auth")?.detail ?? "", /no instance administrator/);
    assert.equal(statusOf(result.state, "start-stack"), "pending");
    assert.equal(startCalled, false);
  });
}

test("relay enrollment does not select Connect for a non-loopback off-tunnel callback", async () => {
  const env: Record<string, string> = {
    GITHUB_EVENT_INTAKE_MODE: "polling",
    PROPR_UI_TUNNEL_ENABLED: "false",
    GH_OAUTH_CALLBACK_URL: "https://api.example.com/api/auth/github/callback",
  };
  const result = await runSetup({
    root: "/stack",
    prompts: relayPrompts({
      configureGithubAuth: async () => ({
        mode: "relay",
        enrollRelay: { relayUrl: DEFAULT_PROPR_GH_RELAY_URL },
      }),
    }),
    actions: mockActions({
      readEnvVars: () => ({ ...env }),
      hasGithubToken: () => true,
      fetchRelayInstallations: async () => ({ username: "octocat", installations: [inst(42, "octo-org")] }),
      enrollRelay: async () => ({ relayUrl: DEFAULT_PROPR_GH_RELAY_URL, token: "prt_minted" }),
      applyEnvSelection: (_root, vars) => {
        Object.assign(env, vars);
        return { written: Object.keys(vars), skipped: [] };
      },
    }),
  });

  assert.equal(statusOf(result.state, "github-auth"), "done");
  assert.equal(env.PROPR_WEB_AUTH_MODE, undefined);
});

test("custom relay enrollment preserves an explicit browser auth mode", async () => {
  const env: Record<string, string> = {
    GITHUB_EVENT_INTAKE_MODE: "polling",
    PROPR_UI_TUNNEL_ENABLED: "false",
    PROPR_WEB_AUTH_MODE: "disabled",
    GH_OAUTH_CALLBACK_URL: "http://localhost:4000/api/auth/github/callback",
  };
  const result = await runSetup({
    root: "/stack",
    prompts: relayPrompts(),
    actions: mockActions({
      readEnvVars: () => ({ ...env }),
      hasGithubToken: () => true,
      fetchRelayInstallations: async () => ({ username: "octocat", installations: [inst(42, "octo-org")] }),
      enrollRelay: async () => ({ relayUrl: "https://relay.example.com/v1", token: "prt_minted" }),
      applyEnvSelection: (_root, vars) => {
        Object.assign(env, vars);
        return { written: Object.keys(vars), skipped: [] };
      },
    }),
  });

  assert.equal(statusOf(result.state, "github-auth"), "done");
  assert.equal(env.PROPR_WEB_AUTH_MODE, "disabled");
});

test("managed tunnel enrollment preserves Connect for a custom relay", async () => {
  const env: Record<string, string> = {
    GITHUB_EVENT_INTAKE_MODE: "routing_websocket",
    PROPR_UI_TUNNEL_ENABLED: "true",
    GH_OAUTH_CALLBACK_URL: "https://t-example.propr.dev/api/auth/github/callback",
  };
  const result = await runSetup({
    root: "/stack",
    prompts: relayPrompts(),
    actions: mockActions({
      readEnvVars: () => ({ ...env }),
      hasGithubToken: () => true,
      fetchRelayInstallations: async () => ({ username: "octocat", installations: [inst(42, "octo-org")] }),
      enrollRelay: async () => ({ relayUrl: "https://relay.example.com/v1", token: "prt_minted" }),
      applyEnvSelection: (_root, vars) => {
        Object.assign(env, vars);
        return { written: Object.keys(vars), skipped: [] };
      },
    }),
  });

  assert.equal(statusOf(result.state, "github-auth"), "done");
  assert.equal(env.PROPR_WEB_AUTH_MODE, "connect");
});

test("relay enrollment preserves custom GitHub browser OAuth off-tunnel", async () => {
  const env: Record<string, string> = {
    GITHUB_EVENT_INTAKE_MODE: "polling",
    PROPR_UI_TUNNEL_ENABLED: "false",
    GH_OAUTH_CLIENT_ID: "real-client-id",
    GH_OAUTH_CLIENT_SECRET: "real-client-secret",
  };
  const result = await runSetup({
    root: "/stack",
    prompts: relayPrompts(),
    actions: mockActions({
      readEnvVars: () => ({ ...env }),
      hasGithubToken: () => true,
      fetchRelayInstallations: async () => ({ username: "octocat", installations: [inst(42, "octo-org")] }),
      enrollRelay: async () => ({ relayUrl: "https://relay/v1", token: "prt_minted" }),
      applyEnvSelection: (_root, vars) => {
        Object.assign(env, vars);
        return { written: Object.keys(vars), skipped: [] };
      },
    }),
  });

  assert.equal(statusOf(result.state, "github-auth"), "done");
  assert.equal(env.PROPR_WEB_AUTH_MODE, undefined);
  assert.equal(env.GH_OAUTH_CLIENT_ID, "real-client-id");
  assert.equal(env.GH_OAUTH_CLIENT_SECRET, "real-client-secret");
  assert.equal(env.GH_AUTH_MODE, "relay");
  assert.equal(env.PROPR_GH_RELAY_TOKEN, "prt_minted");
});

test("relay enrollment does not seed an environment administrator on an existing stack", async () => {
  let relayVars: Record<string, string> | undefined;
  const result = await runSetup({
    root: "/stack",
    prompts: relayPrompts(),
    actions: mockActions({
      // An existing stack can have durable administrators even after its
      // PROPR_ADMIN_USERS bootstrap value has been removed.
      readEnvVars: () => ({}),
      hasGithubToken: () => true,
      fetchRelayInstallations: async () => ({ username: "octocat", installations: [inst(42, "octo-org")] }),
      applyEnvSelection: (_root, vars) => {
        if (vars.GH_AUTH_MODE === "relay") relayVars = vars;
        return { written: Object.keys(vars), skipped: [] };
      },
    }),
  });

  assert.equal(statusOf(result.state, "github-auth"), "done");
  assert.equal(relayVars?.PROPR_ADMIN_USERS, undefined);
  assert.match(getStep(result.state, "github-auth")?.detail ?? "", /left administrators unchanged/);
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

test("default Connect setup opens the ProPR App install page and retries discovery", async () => {
  const opened: string[] = [];
  let discoveryCalls = 0;
  let enrolledId: string | undefined;
  const result = await runSetup({
    root: "/stack",
    prompts: relayPrompts({
      configureGithubAuth: async () => ({
        mode: "relay",
        enrollRelay: { relayUrl: DEFAULT_PROPR_GH_RELAY_URL },
      }),
      confirmGithubAppInstall: async () => true,
      confirmGithubAppInstalled: async () => true,
    }),
    actions: mockActions({
      hasGithubToken: () => true,
      fetchRelayInstallations: async () => {
        discoveryCalls += 1;
        return {
          username: "octocat",
          installations: discoveryCalls === 1 ? [] : [inst(42, "octo-org")],
        };
      },
      openUrl: async (url) => { opened.push(url); },
      enrollRelay: async ({ installationId }) => {
        enrolledId = installationId;
        return { relayUrl: "https://relay/v1", token: "prt_z" };
      },
    }),
  });

  assert.deepEqual(opened, ["https://github.com/apps/propr-dev/installations/new"]);
  assert.equal(discoveryCalls, 2);
  assert.equal(enrolledId, "42");
  assert.equal(statusOf(result.state, "github-auth"), "done");
});

test("a custom relay without installations does not offer the hosted ProPR App", async () => {
  let installPrompted = false;
  const opened: string[] = [];
  const result = await runSetup({
    root: "/stack",
    prompts: relayPrompts({
      confirmGithubAppInstall: async () => {
        installPrompted = true;
        return true;
      },
    }),
    actions: mockActions({
      hasGithubToken: () => true,
      fetchRelayInstallations: async () => ({ username: "octocat", installations: [] }),
      openUrl: async (url) => { opened.push(url); },
    }),
  });

  assert.equal(installPrompted, false);
  assert.deepEqual(opened, []);
  assert.equal(statusOf(result.state, "github-auth"), "failed");
  assert.match(getStep(result.state, "github-auth")?.nextAction ?? "", /administrator of https:\/\/relay\/v1/);
  assert.doesNotMatch(getStep(result.state, "github-auth")?.nextAction ?? "", /github\.com\/apps\/propr-dev/);
});

test("relay enrollment without a token (and no login hook) blocks startup and writes nothing", async () => {
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
  assert.equal(statusOf(result.state, "github-auth"), "failed");
  assert.match(getStep(result.state, "github-auth")?.detail ?? "", /not logged in/);
  assert.equal(relayWritten, false, "no partial relay config is written without a token");
  assert.equal(statusOf(result.state, "start-stack"), "pending");
});

test("custom-App setup obtains a user token before protected backend checks", async () => {
  let appConfigured = false;
  let tokenPresent = false;
  let loginCalled = false;
  let healthCalled = false;
  let loginReason = "";

  const result = await runSetup({
    root: "/stack",
    prompts: {
      configureGithubAuth: async () => ({
        mode: "app",
        vars: {
          GH_AUTH_MODE: "app",
          GH_APP_ID: "123",
          HOST_GH_PRIVATE_KEY: "/keys/app.pem",
          GH_INSTALLATION_ID: "456",
        },
      }),
      confirmGithubLogin: async ({ reason }) => {
        loginReason = reason;
        return true;
      },
    },
    actions: mockActions({
      detectGithubAuthMode: () => appConfigured ? APP_AUTH : NO_AUTH,
      applyEnvSelection: (_root, vars) => {
        if (vars.GH_AUTH_MODE === "app") appConfigured = true;
        return { written: Object.keys(vars), skipped: [] };
      },
      hasGithubToken: () => tokenPresent,
      loginWithGithub: async () => {
        loginCalled = true;
        tokenPresent = true;
        return true;
      },
      checkBackendHealth: async () => {
        healthCalled = true;
        assert.equal(tokenPresent, true, "the protected status client must be authenticated first");
        return { healthy: true, detail: "API healthy" };
      },
    }),
  });

  assert.equal(loginCalled, true);
  assert.match(loginReason, /protected backend API steps/);
  assert.equal(healthCalled, true);
  assert.equal(statusOf(result.state, "github-auth"), "done");
  assert.equal(statusOf(result.state, "start-stack"), "done");
  assert.equal(result.completed, true);
});

for (const proprDemoMode of [undefined, "false"] as const) {
  test(`GH_AUTH_MODE=demo requires login before protected backend checks when PROPR_DEMO_MODE is ${proprDemoMode ?? "absent"}`, async () => {
    let tokenPresent = false;
    let loginCalled = false;
    let healthCalled = false;

    const result = await runSetup({
      root: "/stack",
      prompts: {
        configureGithubAuth: async () => ({ keep: true }),
        confirmGithubLogin: async () => true,
      },
      actions: mockActions({
        readEnvVars: () => ({
          GH_AUTH_MODE: "demo",
          ...(proprDemoMode === undefined ? {} : { PROPR_DEMO_MODE: proprDemoMode }),
        }),
        detectGithubAuthMode: () => ({ mode: "demo", warnings: [] }),
        hasGithubToken: () => tokenPresent,
        loginWithGithub: async () => {
          loginCalled = true;
          tokenPresent = true;
          return true;
        },
        checkBackendHealth: async () => {
          healthCalled = true;
          assert.equal(tokenPresent, true);
          return { healthy: true, detail: "API healthy" };
        },
      }),
    });

    assert.equal(loginCalled, true);
    assert.equal(healthCalled, true);
    assert.equal(statusOf(result.state, "github-auth"), "done");
  });
}

test("custom-App setup stops clearly without login and an authenticated rerun recovers", async () => {
  let appConfigured = false;
  let tokenPresent = false;
  let healthCalls = 0;
  const actions = mockActions({
    detectGithubAuthMode: () => appConfigured ? APP_AUTH : NO_AUTH,
    applyEnvSelection: (_root, vars) => {
      if (vars.GH_AUTH_MODE === "app") appConfigured = true;
      return { written: Object.keys(vars), skipped: [] };
    },
    hasGithubToken: () => tokenPresent,
    checkBackendHealth: async () => {
      healthCalls += 1;
      return { healthy: true, detail: "API healthy" };
    },
  });

  const interrupted = await runSetup({
    root: "/stack",
    prompts: {
      configureGithubAuth: async () => ({
        mode: "app",
        vars: { GH_AUTH_MODE: "app", GH_APP_ID: "123", GH_INSTALLATION_ID: "456" },
      }),
      confirmGithubLogin: async () => false,
    },
    actions,
  });

  assert.equal(appConfigured, true, "the valid custom-App configuration is preserved");
  assert.equal(statusOf(interrupted.state, "github-auth"), "failed");
  assert.match(getStep(interrupted.state, "github-auth")?.detail ?? "", /user login is required/);
  assert.match(getStep(interrupted.state, "github-auth")?.nextAction ?? "", /propr login.*re-run `propr setup`/);
  assert.equal(statusOf(interrupted.state, "start-stack"), "pending");
  assert.equal(healthCalls, 0, "setup must not poll protected status without a token");

  // This is the documented recovery: `propr login`, then rerun setup. The
  // existing App configuration is kept and setup proceeds directly to health.
  tokenPresent = true;
  const recovered = await runSetup({
    root: "/stack",
    prompts: {
      configureGithubAuth: async () => ({ keep: true }),
      confirmGithubLogin: async () => {
        throw new Error("an authenticated rerun must not prompt for login");
      },
    },
    actions,
  });

  assert.equal(healthCalls, 1);
  assert.equal(statusOf(recovered.state, "github-auth"), "done");
  assert.equal(statusOf(recovered.state, "start-stack"), "done");
  assert.equal(recovered.completed, true);
});

test("a relay enrollment failure blocks startup", async () => {
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
  assert.equal(statusOf(result.state, "github-auth"), "failed");
  assert.match(getStep(result.state, "github-auth")?.detail ?? "", /relay enrollment failed/);
  assert.equal(statusOf(result.state, "start-stack"), "pending");
});

test("an unhealthy backend fails setup and does not launch the UI", async () => {
  let uiPrompted = false;
  const result = await runSetup({
    root: "/stack",
    prompts: { launchUi: async () => { uiPrompted = true; return true; } },
    actions: mockActions({
      isStackRunning: async () => false,
      checkBackendHealth: async () => ({ healthy: false, detail: "backend not healthy within 60s" }),
    }),
  });
  assert.equal(statusOf(result.state, "start-stack"), "failed");
  assert.equal(statusOf(result.state, "launch-ui"), "skipped");
  assert.equal(uiPrompted, false);
  assert.equal(result.completed, false);
});

test("backend access errors preserve the distinction between 401 and 403", () => {
  assert.deepEqual(classifyBackendAccessError(Object.assign(new Error("Unauthorized"), { status: 401 })), {
    healthy: false,
    accessFailure: "unauthorized",
    detail: "backend is running but rejected the status request as unauthorized (Unauthorized)",
  });
  assert.deepEqual(classifyBackendAccessError(Object.assign(new Error("Forbidden"), { status: 403 })), {
    healthy: false,
    accessFailure: "forbidden",
    detail: "backend is running but rejected the status request as forbidden (Forbidden)",
  });
});

test("an unauthorized-but-running backend is not described as unhealthy and points at login", async () => {
  const result = await runSetup({
    root: "/stack",
    actions: mockActions({
      isStackRunning: async () => false,
      // The backend answered but rejected the protected status request (issue
      // #1879): it is running, so setup must not call it unhealthy.
      checkBackendHealth: async () => ({
        healthy: false,
        accessFailure: "unauthorized",
        detail: "backend is running but rejected the status request as unauthorized (Unauthorized)",
      }),
    }),
  });
  assert.equal(statusOf(result.state, "start-stack"), "failed");
  const step = getStep(result.state, "start-stack");
  assert.match(step?.detail ?? "", /running but rejected/);
  assert.doesNotMatch(step?.detail ?? "", /not healthy/);
  assert.match(step?.nextAction ?? "", /propr login/);
  assert.equal(result.completed, false);
});

test("a forbidden-but-running backend points at authorization checks instead of login", async () => {
  const result = await runSetup({
    root: "/stack",
    actions: mockActions({
      checkBackendHealth: async () => ({
        healthy: false,
        accessFailure: "forbidden",
        detail: "backend is running but rejected the status request as forbidden (Forbidden)",
      }),
    }),
  });

  assert.equal(statusOf(result.state, "start-stack"), "failed");
  const step = getStep(result.state, "start-stack");
  assert.match(step?.detail ?? "", /running but rejected.*forbidden/);
  assert.doesNotMatch(step?.detail ?? "", /not healthy/);
  assert.match(step?.nextAction ?? "", /authenticated account/);
  assert.match(step?.nextAction ?? "", /bootstrap-admin configuration/);
  assert.match(step?.nextAction ?? "", /access permissions/);
  assert.doesNotMatch(step?.nextAction ?? "", /propr login/);
  assert.equal(result.completed, false);
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

test("routing_websocket without relay auth blocks startup with a prerequisite hint", async () => {
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

  assert.equal(statusOf(result.state, "intake"), "failed");
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

test("whitelist abort is cancellation and never falls back to an env commit", async () => {
  const controller = new AbortController();
  let envCommitted = false;
  const result = await runSetup({
    root: "/stack",
    signal: controller.signal,
    prompts: { configureWhitelist: async () => ["erin"] },
    actions: mockActions({
      isStackRunning: async () => true,
      saveWhitelistSetting: async (_root, _users, signal) => {
        controller.abort();
        signal?.throwIfAborted();
      },
      applyEnvSelection: (_root, vars) => {
        if ("GITHUB_USER_WHITELIST" in vars) envCommitted = true;
        return { written: Object.keys(vars), skipped: [] };
      },
    }),
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.errors[0]?.code, "cancelled");
  assert.equal(envCommitted, false);
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

for (const platform of ["darwin", "win32"] as const) {
  test(`CLI setup and retry reject ${platform} before host actions`, async () => {
    let actions = 0;
    const overrides = { runChecks: async () => { actions += 1; throw new Error("not called"); } };
    await assert.rejects(runSetup({ root: "/stack", platform, actions: overrides }), /not supported/);
    await assert.rejects(retrySetup({ rootDir: "/stack" } as never, { platform, actions: overrides }), /not supported/);
    assert.equal(actions, 0);
  });
}
