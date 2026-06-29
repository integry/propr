/**
 * Setup wizard integration tests.
 *
 * These exercise the `propr setup` engine and its readline fallback against
 * *real* temporary stack roots — actual `.env` files on disk read and written
 * through the production state helpers (`inspectStackInit`, `readEnvVars`,
 * `applyEnvSelection`, `detectGithubAuthMode`). Only the Docker/network/backend
 * side effects are mocked, so the flow runs without real Docker, GitHub, or
 * agent credentials while still proving the on-disk `.env` behaviour the wizard
 * depends on for safe re-runs.
 *
 * The package's own engine.test.ts / sequential.test.ts mock every action
 * (including the env helpers); this file deliberately keeps the env helpers real
 * so the idempotency and intake-write contracts are verified end to end.
 *
 * Run with: `npx tsx --test test/cliSetupWizard.test.ts`.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runSetup, type SetupActions } from "../packages/cli/src/commands/setup/engine.js";
import {
  ENV_FILENAME,
  MANIFEST_FILENAME,
  generateGithubAppManifest,
} from "../packages/cli/src/commands/githubAppCommands.js";
import {
  buildSequentialPrompts,
  runSequentialSetup,
  type SequentialIo,
} from "../packages/cli/src/commands/setup/sequential.js";
import {
  applyEnvSelection,
  clearEnvKeys,
  detectGithubAuthMode,
  getStep,
  hasEnvValue,
  inspectStackInit,
  readEnvVars,
  STACK_SUBDIRS,
} from "../packages/cli/src/commands/setup/state.js";
import type { SetupState } from "../packages/cli/src/commands/setup/types.js";
import type { ChecksOutcome } from "../packages/cli/src/commands/checkCommands.js";

// ---------------------------------------------------------------------------
// Temp-stack helpers.
// ---------------------------------------------------------------------------

/** A fresh, empty temporary directory to use as a stack root. */
function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "propr-setup-wizard-"));
}

/** Write `.env` contents into a stack root. */
function writeEnv(rootDir: string, contents: string): void {
  writeFileSync(join(rootDir, ".env"), contents, "utf-8");
}

/**
 * Make `rootDir` look fully initialized to the real `inspectStackInit`: create
 * the data/logs/repos sub-directories and seed an `.env` with `contents`. This
 * mirrors what `scaffoldStack` produces, so the engine treats the root as an
 * existing install and never re-scaffolds it.
 */
function seedInitializedStack(rootDir: string, contents: string): void {
  for (const sub of STACK_SUBDIRS) mkdirSync(join(rootDir, sub), { recursive: true });
  writeEnv(rootDir, contents);
}

// ---------------------------------------------------------------------------
// Mock actions: Docker/network/backend are stubbed, env helpers are REAL.
// ---------------------------------------------------------------------------

/** A passing environment-check outcome (Docker present, daemon reachable). */
function okChecks(rootDir: string): ChecksOutcome {
  return {
    rootDir,
    anyFail: false,
    cfg: {} as ChecksOutcome["cfg"],
    results: [
      { name: "Docker installed", status: "ok", detail: "Docker version 27", group: "Docker" },
      { name: "Docker daemon", status: "ok", detail: "daemon is reachable", group: "Docker" },
    ],
  };
}

/**
 * Build a {@link SetupActions} whose env operations are the real on-disk helpers
 * (so writes actually land in the temp root's `.env`) while every Docker,
 * network, and backend action is an inert stub. `scaffoldStack` defaults to
 * throwing — most tests use an already-initialized stack and must never
 * re-scaffold; tests that exercise scaffolding override it.
 */
function diskActions(overrides: Partial<SetupActions> = {}): SetupActions {
  return {
    runChecks: async ({ root }) => okChecks(root ?? "/stack"),
    // Real env/state helpers — they touch only the temp root passed in.
    inspectStackInit,
    readEnvVars,
    applyEnvSelection,
    clearEnvKeys,
    detectGithubAuthMode,
    // Real GitHub App manifest helpers — they write to / inspect the temp root,
    // matching what `propr github-app manifest` produces.
    inspectGithubAppManifest: (rootDir) => {
      const manifestPath = join(rootDir, MANIFEST_FILENAME);
      const envPath = join(rootDir, ENV_FILENAME);
      return { manifestPath, envPath, exists: existsSync(manifestPath) || existsSync(envPath) };
    },
    generateGithubAppManifest: async ({ rootDir, publicUrl, force }) => {
      const generated = await generateGithubAppManifest({ root: rootDir, publicUrl, force });
      return {
        manifestPath: generated.manifestPath,
        envPath: generated.envPath,
        webhookUrl: generated.webhookUrl,
        createUrl: generated.createUrl,
      };
    },
    scaffoldStack: async ({ root }) => {
      throw new Error(`scaffoldStack must not run for an initialized stack (${root})`);
    },
    persistStackRoot: async () => undefined,
    // Docker / network / backend — inert stubs.
    pullImages: async () => ({ pulledCore: ["propr/api"], pulledAgents: [], failedCore: [], failedAgents: [] }),
    isStackRunning: async () => false,
    startStack: async () => undefined,
    checkBackendHealth: async () => ({ healthy: true, detail: "API healthy" }),
    addRepository: async () => undefined,
    resolveUiUrl: async () => "http://localhost:3000",
    openUrl: async () => undefined,
    saveWhitelistSetting: async () => undefined,
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

// ---------------------------------------------------------------------------
// 1. State helpers without Docker (real temp dirs).
// ---------------------------------------------------------------------------

test("state helpers read and edit a real .env without Docker", () => {
  const root = makeRoot();
  // A bare root is not initialized and has no env vars.
  assert.equal(inspectStackInit(root).initialized, false);
  assert.deepEqual(readEnvVars(root), {});
  assert.equal(hasEnvValue(root, "GH_APP_ID"), false);

  // applyEnvSelection writes the file; readEnvVars reads it back.
  const result = applyEnvSelection(root, { GH_APP_ID: "123", PROPR_GH_RELAY_URL: "https://relay" });
  assert.deepEqual(result.written.sort(), ["GH_APP_ID", "PROPR_GH_RELAY_URL"]);
  assert.deepEqual(result.skipped, []);
  assert.equal(readEnvVars(root).GH_APP_ID, "123");
  assert.equal(hasEnvValue(root, "GH_APP_ID"), true);
});

test("inspectStackInit reports initialized only once .env and all sub-dirs exist", () => {
  const root = makeRoot();
  writeEnv(root, "FOO=bar\n");
  // .env present but no data/logs/repos yet → not initialized.
  assert.equal(inspectStackInit(root).initialized, false);
  seedInitializedStack(root, "FOO=bar\n");
  const init = inspectStackInit(root);
  assert.equal(init.initialized, true);
  assert.deepEqual(init.dirs, { data: true, logs: true, repos: true });
});

// ---------------------------------------------------------------------------
// 2. Intake mode .env writes (real file).
// ---------------------------------------------------------------------------

test("selecting polling intake writes GITHUB_EVENT_INTAKE_MODE=polling to the real .env", async () => {
  const root = makeRoot();
  seedInitializedStack(root, "GH_AUTH_MODE=app\nGH_APP_ID=1\nGH_PRIVATE_KEY_PATH=/k.pem\nGH_INSTALLATION_ID=2\n");

  const result = await runSetup({
    root,
    prompts: { configureIntake: async () => ({ mode: "polling" }) },
    actions: diskActions(),
  });

  // App auth qualifies for polling, so the step completes cleanly.
  assert.equal(statusOf(result.state, "intake"), "done");
  assert.equal(readEnvVars(root).GITHUB_EVENT_INTAKE_MODE, "polling", "polling is selected on disk");
});

test("selecting direct-webhook intake records the mode and signing secret on disk", async () => {
  const root = makeRoot();
  seedInitializedStack(root, "GH_AUTH_MODE=app\nGH_APP_ID=1\nGH_PRIVATE_KEY_PATH=/k.pem\nGH_INSTALLATION_ID=2\n");

  await runSetup({
    root,
    prompts: { configureIntake: async () => ({ mode: "direct_webhook", webhookSecret: "s3cret" }) },
    actions: diskActions(),
  });

  const env = readEnvVars(root);
  assert.equal(env.GITHUB_EVENT_INTAKE_MODE, "direct_webhook");
  assert.equal(env.GH_WEBHOOK_SECRET, "s3cret");
});

test("direct-webhook + custom App setup writes the same files as `propr github-app manifest`", async () => {
  const root = makeRoot();
  seedInitializedStack(
    root,
    "GH_AUTH_MODE=app\nGH_APP_ID=1\nGH_PRIVATE_KEY_PATH=/k.pem\nGH_INSTALLATION_ID=2\nAPI_PUBLIC_URL=https://propr.example.com\n"
  );

  let seenPublicUrl: string | undefined;
  const result = await runSetup({
    root,
    prompts: {
      configureIntake: async () => ({ mode: "direct_webhook", webhookSecret: "s3cret" }),
      configureGithubAppManifest: async ({ detectedPublicUrl }) => {
        // The public URL is discovered from .env, so the renderer can reuse it.
        seenPublicUrl = detectedPublicUrl;
        return { publicUrl: detectedPublicUrl ?? "https://propr.example.com" };
      },
    },
    actions: diskActions(),
  });

  assert.equal(seenPublicUrl, "https://propr.example.com", "API_PUBLIC_URL feeds the manifest prompt");
  // Both output files land in the stack root, mirroring the standalone command.
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST_FILENAME), "utf-8"));
  assert.equal(manifest.url, "https://propr.example.com");
  assert.equal(manifest.hook_attributes.url, "https://propr.example.com/webhook");
  const snippet = readFileSync(join(root, ENV_FILENAME), "utf-8");
  assert.match(snippet, /GITHUB_EVENT_INTAKE_MODE=direct_webhook/);
  // The step stays done and surfaces the create/install next steps.
  assert.equal(statusOf(result.state, "intake"), "done");
  assert.match(getStep(result.state, "intake")?.nextAction ?? "", /GH_APP_ID/);
});

test("setup reports a warning (not a failure) when the manifest files already exist", async () => {
  const root = makeRoot();
  seedInitializedStack(
    root,
    "GH_AUTH_MODE=app\nGH_APP_ID=1\nGH_PRIVATE_KEY_PATH=/k.pem\nGH_INSTALLATION_ID=2\n"
  );
  // Pre-generate the manifest so setup encounters existing files.
  await generateGithubAppManifest({ root, publicUrl: "https://old.example.com" });
  const before = readFileSync(join(root, MANIFEST_FILENAME), "utf-8");

  const result = await runSetup({
    root,
    prompts: {
      configureIntake: async () => ({ mode: "direct_webhook", webhookSecret: "s3cret" }),
      // The renderer declines to regenerate when files already exist → null.
      configureGithubAppManifest: async ({ filesExist }) => {
        assert.equal(filesExist, true, "setup detects the pre-existing manifest files");
        return null;
      },
    },
    actions: diskActions(),
  });

  assert.equal(result.completed, true, "an existing-manifest warning is non-blocking");
  assert.equal(statusOf(result.state, "intake"), "warning");
  assert.match(getStep(result.state, "intake")?.detail ?? "", /already exists/i);
  // The existing manifest is left untouched (not overwritten).
  assert.equal(readFileSync(join(root, MANIFEST_FILENAME), "utf-8"), before, "existing files are preserved");
});

test("an empty webhook secret is rejected and writes nothing to .env", async () => {
  const root = makeRoot();
  seedInitializedStack(root, "GH_AUTH_MODE=app\nGH_APP_ID=1\nGH_PRIVATE_KEY_PATH=/k.pem\nGH_INSTALLATION_ID=2\n");

  const result = await runSetup({
    root,
    prompts: { configureIntake: async () => ({ mode: "direct_webhook", webhookSecret: "   " }) },
    actions: diskActions(),
  });

  assert.equal(statusOf(result.state, "intake"), "warning", "an empty secret is rejected, not written");
  const env = readEnvVars(root);
  assert.equal(env.GITHUB_EVENT_INTAKE_MODE, undefined);
  assert.equal(env.GH_WEBHOOK_SECRET, undefined);
  assert.equal(result.completed, true, "a rejected secret is non-blocking");
});

test("routing_websocket selected with relay auth + a relay token is wired correctly on disk", async () => {
  const root = makeRoot();
  // A relay-enrolled stack: relay auth mode and a relay token (URLs default to
  // the hosted relay). This is the prerequisite set routing_websocket needs.
  seedInitializedStack(root, "GH_AUTH_MODE=relay\nPROPR_GH_RELAY_TOKEN=relay-token\n");

  const result = await runSetup({
    root,
    prompts: { configureIntake: async () => ({ mode: "routing_websocket" }) },
    actions: diskActions(),
  });

  assert.equal(statusOf(result.state, "intake"), "done", "relay auth + token satisfies routing prerequisites");
  assert.equal(readEnvVars(root).GITHUB_EVENT_INTAKE_MODE, "routing_websocket");
});

test("routing_websocket selected without relay auth warns about the missing relay prerequisites", async () => {
  const root = makeRoot();
  // App auth can't use the hosted routing path — it needs relay auth + a token.
  seedInitializedStack(root, "GH_AUTH_MODE=app\nGH_APP_ID=1\nGH_PRIVATE_KEY_PATH=/k.pem\nGH_INSTALLATION_ID=2\n");

  const result = await runSetup({
    root,
    prompts: { configureIntake: async () => ({ mode: "routing_websocket" }) },
    actions: diskActions(),
  });

  // The mode is still written (the user explicitly chose it), but the gap is
  // surfaced here rather than as a backend boot failure.
  assert.equal(statusOf(result.state, "intake"), "warning");
  assert.equal(readEnvVars(root).GITHUB_EVENT_INTAKE_MODE, "routing_websocket");
  assert.match(getStep(result.state, "intake")?.nextAction ?? "", /relay enroll|polling/);
  assert.equal(result.completed, true, "the prerequisite warning is non-blocking");
});

// ---------------------------------------------------------------------------
// 3. Existing .env is not overwritten on re-run (idempotency).
// ---------------------------------------------------------------------------

test("re-running setup on an initialized stack skips scaffolding and preserves the existing .env", async () => {
  const root = makeRoot();
  const original = [
    "GH_AUTH_MODE=app",
    "GH_APP_ID=999",
    "GH_PRIVATE_KEY_PATH=/keys/app.pem",
    "GH_INSTALLATION_ID=42",
    "GITHUB_USER_WHITELIST=alice,bob",
    "GITHUB_EVENT_INTAKE_MODE=direct_webhook",
    "GH_WEBHOOK_SECRET=keepme",
    "",
  ].join("\n");
  seedInitializedStack(root, original);

  let scaffoldCalled = false;
  const result = await runSetup({
    root,
    // A re-run with no prompts uses the safe defaults: keep auth, keep intake,
    // keep whitelist — nothing the user already set should change.
    actions: diskActions({
      scaffoldStack: async () => {
        scaffoldCalled = true;
        throw new Error("scaffoldStack must not run for an initialized stack");
      },
    }),
  });

  assert.equal(scaffoldCalled, false, "an initialized stack is never re-scaffolded");
  assert.equal(statusOf(result.state, "init-stack"), "skipped");

  // Every user-set value survives the re-run untouched.
  const env = readEnvVars(root);
  assert.equal(env.GH_APP_ID, "999");
  assert.equal(env.GH_PRIVATE_KEY_PATH, "/keys/app.pem");
  assert.equal(env.GH_INSTALLATION_ID, "42");
  assert.equal(env.GITHUB_USER_WHITELIST, "alice,bob");
  assert.equal(env.GITHUB_EVENT_INTAKE_MODE, "direct_webhook", "an existing intake mode is not changed");
  assert.equal(env.GH_WEBHOOK_SECRET, "keepme");
  assert.equal(result.completed, true);
});

test("a blank-Enter re-run keeps an existing direct-webhook intake config (defaults to keep)", async () => {
  const root = makeRoot();
  seedInitializedStack(
    root,
    "GH_AUTH_MODE=app\nGH_APP_ID=1\nGH_PRIVATE_KEY_PATH=/k.pem\nGH_INSTALLATION_ID=2\nGITHUB_EVENT_INTAKE_MODE=direct_webhook\nGH_WEBHOOK_SECRET=keepme\n",
  );

  let seenDefault: string | undefined;
  await runSetup({
    root,
    prompts: {
      // Mirror the renderer: a "keep" default returns keep:true on a blank Enter.
      configureIntake: async ({ defaultMode }) => {
        seenDefault = defaultMode;
        return { keep: true };
      },
    },
    actions: diskActions(),
  });

  assert.equal(seenDefault, "keep", "an existing intake config pre-selects keep, not the auth recommendation");
  const env = readEnvVars(root);
  assert.equal(env.GITHUB_EVENT_INTAKE_MODE, "direct_webhook", "keeping must not rewrite the working intake config");
  assert.equal(env.GH_WEBHOOK_SECRET, "keepme");
});

test("configure-agents never overwrites a credential dir already present in .env", () => {
  // Direct helper-level proof of the non-destructive contract the engine relies
  // on: a key that already has a value is skipped, not clobbered.
  const root = makeRoot();
  writeEnv(root, "HOST_CLAUDE_DIR=/custom/claude\n");
  const applied = applyEnvSelection(root, { HOST_CLAUDE_DIR: "/home/me/.claude" }, { overwrite: false });
  assert.deepEqual(applied.written, []);
  assert.deepEqual(applied.skipped, ["HOST_CLAUDE_DIR"]);
  assert.equal(readEnvVars(root).HOST_CLAUDE_DIR, "/custom/claude", "the user's value is preserved");
});

// ---------------------------------------------------------------------------
// 4. Fallback (sequential) prompt behavior with mocked prompts.
// ---------------------------------------------------------------------------

/**
 * A scripted in-memory {@link SequentialIo}: each `ask` returns the next queued
 * answer; running out is a test bug, so it throws rather than hanging.
 */
function scriptedIo(answers: string[]): SequentialIo & { lines: string[]; questions: string[] } {
  const queue = [...answers];
  const lines: string[] = [];
  const questions: string[] = [];
  return {
    lines,
    questions,
    print(line = "") {
      lines.push(line);
    },
    async ask(question) {
      questions.push(question);
      if (queue.length === 0) throw new Error(`scriptedIo ran out of answers at: ${question}`);
      return queue.shift()!;
    },
    close() {},
  };
}

test("fallback prompts honour blank-Enter safe defaults", async () => {
  // Blank → keep current root, no re-scaffold offered for an un-initialized root.
  const init = { rootDir: "/cur", envExists: false, dirs: { data: false, logs: false, repos: false }, initialized: false };
  const decision = await buildSequentialPrompts(scriptedIo([""])).resolveStackRoot!({ currentRoot: "/cur", init });
  assert.deepEqual(decision, { rootDir: "/cur", reinitialize: false });

  // Blank intake answer with a "keep" default leaves the config untouched.
  const intake = await buildSequentialPrompts(scriptedIo([""])).configureIntake!({
    authMode: "app",
    defaultMode: "keep",
    currentMode: "direct_webhook",
  });
  assert.deepEqual(intake, { keep: true });
});

test("fallback webhook prompt re-asks until a non-empty secret is entered", async () => {
  // Option 3 = direct_webhook, then a blank (rejected) secret, then a real one.
  const io = scriptedIo(["3", "", "hook-secret"]);
  const decision = await buildSequentialPrompts(io).configureIntake!({
    authMode: "app",
    defaultMode: "polling",
    currentMode: "polling",
  });
  assert.deepEqual(decision, { mode: "direct_webhook", webhookSecret: "hook-secret" });
  assert.match(io.lines.join("\n"), /webhook secret is required/i);
});

test("manifest prompt reuses a detected public URL and only confirms generation", async () => {
  // A single "y" (generate?) is enough when the public URL is already known.
  const io = scriptedIo(["y"]);
  const decision = await buildSequentialPrompts(io).configureGithubAppManifest!({
    rootDir: "/stack",
    detectedPublicUrl: "https://propr.example.com",
    filesExist: false,
    manifestPath: "/stack/github-app-manifest.json",
    envPath: "/stack/github-app.env",
  });
  assert.deepEqual(decision, { publicUrl: "https://propr.example.com", regenerate: false });
});

test("manifest prompt asks for a public URL when none is detected", async () => {
  // generate? (y), then the public URL (no default available).
  const io = scriptedIo(["y", "https://my.propr.example"]);
  const decision = await buildSequentialPrompts(io).configureGithubAppManifest!({
    rootDir: "/stack",
    detectedPublicUrl: undefined,
    filesExist: false,
    manifestPath: "/stack/github-app-manifest.json",
    envPath: "/stack/github-app.env",
  });
  assert.deepEqual(decision, { publicUrl: "https://my.propr.example", regenerate: false });
});

test("manifest prompt leaves existing files alone unless the user confirms regenerate", async () => {
  // generate? (y), regenerate existing files? (blank → no) → skip, returning null.
  const io = scriptedIo(["y", ""]);
  const decision = await buildSequentialPrompts(io).configureGithubAppManifest!({
    rootDir: "/stack",
    detectedPublicUrl: "https://propr.example.com",
    filesExist: true,
    manifestPath: "/stack/github-app-manifest.json",
    envPath: "/stack/github-app.env",
  });
  assert.equal(decision, null);
});

test("manifest prompt regenerates existing files when the user opts in", async () => {
  // generate? (y), regenerate? (y) → decision carries regenerate: true.
  const io = scriptedIo(["y", "y"]);
  const decision = await buildSequentialPrompts(io).configureGithubAppManifest!({
    rootDir: "/stack",
    detectedPublicUrl: "https://propr.example.com",
    filesExist: true,
    manifestPath: "/stack/github-app-manifest.json",
    envPath: "/stack/github-app.env",
  });
  assert.deepEqual(decision, { publicUrl: "https://propr.example.com", regenerate: true });
});

test("runSequentialSetup drives the engine through scripted answers and writes .env on disk", async () => {
  const root = makeRoot();
  seedInitializedStack(root, "GH_AUTH_MODE=app\nGH_APP_ID=1\nGH_PRIVATE_KEY_PATH=/k.pem\nGH_INSTALLATION_ID=2\n");

  // Answers in prompt order for an already-initialized stack:
  //   resolveStackRoot (blank → keep), re-scaffold? (n),
  //   selectAgents (none), githubAuth (blank → keep),
  //   configureIntake (2 → polling), confirmStartStack (blank → yes),
  //   whitelist (a comma list), addRepository (n), launchUi (n).
  const io = scriptedIo(["", "n", "none", "", "2", "", "carol, dave", "n", "n"]);

  const result = await runSequentialSetup({ io, root, actions: diskActions() });

  assert.equal(result.completed, true);
  assert.equal(statusOf(result.state, "init-stack"), "skipped");
  // The scripted polling choice landed in the real .env.
  assert.equal(readEnvVars(root).GITHUB_EVENT_INTAKE_MODE, "polling");
  // The whitelist the user typed was mirrored to .env (backend is "down" here).
  assert.equal(readEnvVars(root).GITHUB_USER_WHITELIST, "carol,dave");
  assert.match(io.lines.join("\n"), /Setup complete/);
});

// ---------------------------------------------------------------------------
// 5. Only the selected agent images are pulled.
// ---------------------------------------------------------------------------

test("only the selected agents' images are requested for pulling", async () => {
  const root = makeRoot();
  seedInitializedStack(root, "GH_AUTH_MODE=app\nGH_APP_ID=1\nGH_PRIVATE_KEY_PATH=/k.pem\nGH_INSTALLATION_ID=2\n");

  let pulledAgentTypes: string[] | undefined;
  await runSetup({
    root,
    prompts: { selectAgents: async () => ["claude", "codex"] },
    actions: diskActions({
      pullImages: async ({ agentTypes }) => {
        pulledAgentTypes = agentTypes;
        return { pulledCore: ["propr/api"], pulledAgents: ["propr/agent-claude", "propr/agent-codex"], failedCore: [], failedAgents: [] };
      },
    }),
  });

  assert.deepEqual(pulledAgentTypes, ["claude", "codex"], "exactly the selected agents are pulled");
});

test("unknown and duplicate agent selections are filtered before pulling images", async () => {
  const root = makeRoot();
  seedInitializedStack(root, "GH_AUTH_MODE=app\nGH_APP_ID=1\nGH_PRIVATE_KEY_PATH=/k.pem\nGH_INSTALLATION_ID=2\n");

  let pulledAgentTypes: string[] | undefined;
  await runSetup({
    root,
    prompts: { selectAgents: async () => ["claude", "claude", "bogus", "codex"] },
    actions: diskActions({
      pullImages: async ({ agentTypes }) => {
        pulledAgentTypes = agentTypes;
        return { pulledCore: ["propr/api"], pulledAgents: [], failedCore: [], failedAgents: [] };
      },
    }),
  });

  assert.deepEqual(pulledAgentTypes, ["claude", "codex"], "duplicates de-duped and unknown names dropped");
});

test("no selected agents means no agent images are pulled", async () => {
  const root = makeRoot();
  seedInitializedStack(root, "GH_AUTH_MODE=app\nGH_APP_ID=1\nGH_PRIVATE_KEY_PATH=/k.pem\nGH_INSTALLATION_ID=2\n");

  let pulledAgentTypes: string[] | undefined;
  const result = await runSetup({
    root,
    prompts: { selectAgents: async () => [] },
    actions: diskActions({
      pullImages: async ({ agentTypes }) => {
        pulledAgentTypes = agentTypes;
        return { pulledCore: ["propr/api"], pulledAgents: [], failedCore: [], failedAgents: [] };
      },
    }),
  });

  assert.deepEqual(pulledAgentTypes, [], "no agents selected → no agent images requested");
  assert.equal(statusOf(result.state, "configure-agents"), "skipped");
  assert.equal(statusOf(result.state, "enable-agents"), "skipped");
});

// ---------------------------------------------------------------------------
// 6. Correctness fixes from review: clearing config, demo switch, decline,
//    legacy intake, and actually opening the UI.
// ---------------------------------------------------------------------------

test("clearing the whitelist removes GITHUB_USER_WHITELIST from .env (not blanked)", async () => {
  const root = makeRoot();
  seedInitializedStack(
    root,
    "GH_AUTH_MODE=app\nGH_APP_ID=1\nGH_PRIVATE_KEY_PATH=/k.pem\nGH_INSTALLATION_ID=2\nGITHUB_USER_WHITELIST=alice,bob\n",
  );

  const result = await runSetup({
    root,
    // An empty selection (the renderer's "none") must clear the whitelist.
    prompts: { configureWhitelist: async () => [] },
    actions: diskActions(),
  });

  assert.equal(
    readEnvVars(root).GITHUB_USER_WHITELIST,
    undefined,
    "the stale whitelist key is removed so it cannot come back on restart",
  );
  assert.match(getStep(result.state, "whitelist")?.detail ?? "", /cleared/);
});

test("switching from demo to app turns PROPR_DEMO_MODE off on disk", async () => {
  const root = makeRoot();
  seedInitializedStack(root, "PROPR_DEMO_MODE=true\nGH_AUTH_MODE=demo\n");

  await runSetup({
    root,
    prompts: {
      // Mirror what the renderers now hand back when leaving demo mode.
      configureGithubAuth: async () => ({
        mode: "app",
        vars: {
          PROPR_DEMO_MODE: "false",
          GH_AUTH_MODE: "app",
          GH_APP_ID: "1",
          GH_PRIVATE_KEY_PATH: "/k.pem",
          GH_INSTALLATION_ID: "2",
        },
      }),
    },
    actions: diskActions(),
  });

  const env = readEnvVars(root);
  assert.equal(env.PROPR_DEMO_MODE, "false", "demo mode is explicitly disabled");
  assert.equal(detectGithubAuthMode(root).mode, "app", "auth no longer resolves as demo");
});

test("both renderers turn demo off when selecting a real auth mode", async () => {
  // With an existing (demo) config the options are: 1) keep, 2) token relay,
  // 3) custom GitHub App.
  // Custom GitHub App (option 3) → appId, host key path, installation id.
  const app = await buildSequentialPrompts(scriptedIo(["3", "123", "/k.pem", "42"])).configureGithubAuth!({
    current: { mode: "demo", warnings: [] },
  });
  assert.equal(app.vars?.PROPR_DEMO_MODE, "false");
  assert.equal(app.vars?.GH_AUTH_MODE, "app");

  // Token relay (option 2) → relay URL. The relay path hands the engine an
  // `enrollRelay` request (the engine mints the token and writes the relay env,
  // including PROPR_DEMO_MODE=false), so the decision carries no `vars`.
  const relay = await buildSequentialPrompts(scriptedIo(["2", "https://relay"])).configureGithubAuth!({
    current: { mode: "demo", warnings: [] },
  });
  assert.equal(relay.mode, "relay");
  assert.equal(relay.enrollRelay?.relayUrl, "https://relay");
});

test("declining to start the stack reports setup as incomplete", async () => {
  const root = makeRoot();
  seedInitializedStack(root, "GH_AUTH_MODE=app\nGH_APP_ID=1\nGH_PRIVATE_KEY_PATH=/k.pem\nGH_INSTALLATION_ID=2\n");

  const result = await runSetup({
    root,
    prompts: { confirmStartStack: async () => false },
    actions: diskActions(),
  });

  assert.equal(statusOf(result.state, "start-stack"), "skipped");
  assert.equal(result.completed, false, "a declined start must not exit 0 / report success");
});

test("reusing an already-initialized root persists it to config", async () => {
  const root = makeRoot();
  seedInitializedStack(root, "GH_AUTH_MODE=app\nGH_APP_ID=1\nGH_PRIVATE_KEY_PATH=/k.pem\nGH_INSTALLATION_ID=2\n");

  let persisted: string | undefined;
  const result = await runSetup({
    root,
    actions: {
      ...diskActions(),
      persistStackRoot: async (rootDir) => {
        persisted = rootDir;
      },
    },
  });

  // The reuse path skips scaffolding (which would otherwise record the root), so
  // the engine must persist it itself for later `propr start` without --root.
  assert.equal(statusOf(result.state, "init-stack"), "skipped");
  assert.equal(persisted, root, "the resolved root is saved to config on the reuse path");
});

test("declining to start the stack skips the backend-dependent follow-up steps", async () => {
  const root = makeRoot();
  seedInitializedStack(root, "GH_AUTH_MODE=app\nGH_APP_ID=1\nGH_PRIVATE_KEY_PATH=/k.pem\nGH_INSTALLATION_ID=2\n");

  let addRepoCalled = false;
  let enableAgentsTouchedBackend = false;
  const result = await runSetup({
    root,
    prompts: {
      confirmStartStack: async () => false,
      // Both would normally drive backend-dependent work; with the stack
      // declined they must not even be consulted.
      selectAgents: async () => ["claude"],
      addRepository: async () => ({ fullName: "octo/repo" }),
    },
    actions: {
      ...diskActions(),
      addRepository: async () => {
        addRepoCalled = true;
      },
      listAgents: async () => {
        enableAgentsTouchedBackend = true;
        return [];
      },
    },
  });

  assert.equal(statusOf(result.state, "enable-agents"), "skipped", "agent enablement is a backend step");
  assert.equal(statusOf(result.state, "repo"), "skipped", "adding a repo is a backend step");
  assert.equal(addRepoCalled, false, "the repo API must not be called when the stack is not started");
  assert.equal(enableAgentsTouchedBackend, false, "the agents API must not be called when the stack is not started");
});

test("a legacy ENABLE_GITHUB_WEBHOOKS .env pre-selects keep for intake", async () => {
  const root = makeRoot();
  // No GITHUB_EVENT_INTAKE_MODE, only the deprecated boolean — but it still
  // resolves to a real mode, so a blank Enter must keep it.
  seedInitializedStack(
    root,
    "GH_AUTH_MODE=app\nGH_APP_ID=1\nGH_PRIVATE_KEY_PATH=/k.pem\nGH_INSTALLATION_ID=2\nENABLE_GITHUB_WEBHOOKS=true\n",
  );

  let seenDefault: string | undefined;
  await runSetup({
    root,
    prompts: {
      configureIntake: async ({ defaultMode }) => {
        seenDefault = defaultMode;
        return { keep: true };
      },
    },
    actions: diskActions(),
  });

  assert.equal(seenDefault, "keep", "a legacy webhooks flag counts as configured → keep, not a rewrite");
});

test("confirming the UI launch actually opens the resolved URL", async () => {
  const root = makeRoot();
  seedInitializedStack(root, "GH_AUTH_MODE=app\nGH_APP_ID=1\nGH_PRIVATE_KEY_PATH=/k.pem\nGH_INSTALLATION_ID=2\n");

  let opened: string | undefined;
  const result = await runSetup({
    root,
    prompts: { launchUi: async () => true },
    actions: diskActions({
      openUrl: async (url) => {
        opened = url;
      },
    }),
  });

  assert.equal(opened, "http://localhost:3000", "the engine opens the UI rather than only reporting it");
  assert.equal(statusOf(result.state, "launch-ui"), "done");
  assert.match(getStep(result.state, "launch-ui")?.detail ?? "", /opened/);
});
