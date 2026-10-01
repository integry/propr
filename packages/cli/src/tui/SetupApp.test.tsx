/**
 * Tests for the setup prompt bridge. Run with:
 * `npx tsx --test src/tui/SetupApp.test.tsx` (from packages/cli). These exercise
 * the bridge and the engine→bridge prompt mapping without rendering Ink — the
 * React component is driven by the same events these assert on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SetupBridge, SetupCancelledError, buildSetupPrompts, type SetupPrompt } from "./SetupApp.js";
import { DEFAULT_PROPR_GH_RELAY_URL, type GithubAuthModeResult } from "@propr/shared";
import { runSetup, type SetupActions, type SetupPrompts } from "../commands/setup/engine.js";

/** Subscribe and capture every event the bridge emits. */
function capture(bridge: SetupBridge): SetupPrompt[] {
  const prompts: SetupPrompt[] = [];
  bridge.subscribe((event) => {
    if (event.type === "prompt") prompts.push(event.prompt);
  });
  return prompts;
}

test("confirm resolves with the chosen boolean", async () => {
  const bridge = new SetupBridge();
  const prompts = capture(bridge);
  const answer = bridge.confirm({ title: "Start?", defaultValue: true });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].kind, "confirm");
  bridge.resolve(prompts[0].id, false);
  assert.equal(await answer, false);
});

test("input resolves with the entered text", async () => {
  const bridge = new SetupBridge();
  const prompts = capture(bridge);
  const answer = bridge.input({ title: "Root", defaultValue: "/x" });
  bridge.resolve(prompts[0].id, "/custom");
  assert.equal(await answer, "/custom");
});

test("select returns the chosen option value", async () => {
  const bridge = new SetupBridge();
  const prompts = capture(bridge);
  const answer = bridge.select({
    title: "Auth",
    options: [
      { label: "Keep", value: "keep" },
      { label: "App", value: "app" },
    ],
  });
  bridge.resolve(prompts[0].id, "app");
  assert.equal(await answer, "app");
});

test("multiSelect returns the chosen values", async () => {
  const bridge = new SetupBridge();
  const prompts = capture(bridge);
  const answer = bridge.multiSelect({
    title: "Agents",
    options: [
      { label: "claude", value: "claude" },
      { label: "codex", value: "codex" },
    ],
  });
  bridge.resolve(prompts[0].id, ["claude"]);
  assert.deepEqual(await answer, ["claude"]);
});

test("cancel rejects the in-flight prompt and all later ones", async () => {
  const bridge = new SetupBridge();
  capture(bridge);
  const pending = bridge.confirm({ title: "Start?" });
  bridge.cancel();
  await assert.rejects(pending, (error) => error instanceof SetupCancelledError);
  // A prompt requested after cancellation rejects immediately.
  await assert.rejects(bridge.input({ title: "Root" }), (error) => error instanceof SetupCancelledError);
});

test("late subscribers still receive earlier events via history replay", async () => {
  const bridge = new SetupBridge();
  const answer = bridge.confirm({ title: "Start?" });
  // Subscribe only after the prompt was emitted.
  const prompts = capture(bridge);
  assert.equal(prompts.length, 1, "history replay delivers the prompt to a late subscriber");
  bridge.resolve(prompts[0].id, true);
  assert.equal(await answer, true);
});

test("buildSetupPrompts maps agent selection to a multi-choice prompt", async () => {
  const bridge = new SetupBridge();
  const prompts = capture(bridge);
  const hooks = buildSetupPrompts(bridge);

  const chosen = hooks.selectAgents!({ available: ["claude", "codex"], detected: ["claude"] });
  assert.equal(prompts[0].kind, "multi");
  if (prompts[0].kind === "multi") {
    assert.deepEqual(prompts[0].defaultSelected, ["claude"]);
    assert.equal(prompts[0].options.find((o) => o.value === "claude")?.hint, "detected");
  }
  bridge.resolve(prompts[0].id, ["claude", "codex"]);
  assert.deepEqual(await chosen, ["claude", "codex"]);
});

test("buildSetupPrompts keeps existing GitHub auth when 'keep' is chosen", async () => {
  const bridge = new SetupBridge();
  const prompts = capture(bridge);
  const hooks = buildSetupPrompts(bridge);
  const current: GithubAuthModeResult = { mode: "app", warnings: [] };

  const decision = hooks.configureGithubAuth!({ current });
  assert.equal(prompts[0].kind, "select");
  bridge.resolve(prompts[0].id, "keep");
  assert.deepEqual(await decision, { keep: true });
});

test("buildSetupPrompts offers the official ProPR App install as a default-yes action", async () => {
  const bridge = new SetupBridge();
  const prompts = capture(bridge);
  const hooks = buildSetupPrompts(bridge);
  const answer = hooks.confirmGithubAppInstall!({
    url: "https://github.com/apps/propr-dev/installations/new",
  });

  assert.equal(prompts[0].kind, "confirm");
  assert.equal(prompts[0].kind === "confirm" && prompts[0].defaultValue, true);
  bridge.resolve(prompts[0].id, true);
  assert.equal(await answer, true);
});

test("Ink setup recovers from zero installations before opening its legacy picker", async () => {
  const bridge = new SetupBridge();
  const promptTitles: string[] = [];
  bridge.subscribe((event) => {
    if (event.type !== "prompt") return;
    const prompt = event.prompt;
    promptTitles.push(prompt.title);
    queueMicrotask(() => {
      if (prompt.kind === "confirm") bridge.resolve(prompt.id, true);
      else if (prompt.kind === "select") {
        assert.ok(prompt.options.length > 0, "the legacy Ink picker must never receive an empty list");
        bridge.resolve(prompt.id, prompt.options[0].value);
      }
    });
  });

  const legacy = buildSetupPrompts(bridge);
  const prompts: SetupPrompts = {
    ...legacy,
    resolveStackRoot: async ({ currentRoot }) => ({ rootDir: currentRoot, reinitialize: false }),
    selectAgents: async () => [],
    configureGithubAuth: async () => ({
      mode: "relay",
      enrollRelay: { relayUrl: DEFAULT_PROPR_GH_RELAY_URL },
    }),
    configureIntake: async () => ({ keep: true }),
    confirmStartStack: async () => true,
    confirmAgentLogin: async () => [],
    configureWhitelist: async () => null,
    addRepository: async () => null,
    launchUi: async () => false,
  };
  const env: Record<string, string> = { GITHUB_EVENT_INTAKE_MODE: "polling" };
  const opened: string[] = [];
  let discoveries = 0;
  let enrolledId: string | undefined;
  const actions = {
    runChecks: async ({ root }: { root?: string }) => ({ rootDir: root ?? "/stack", anyFail: false, results: [
      { name: "Docker daemon", group: "Docker", status: "ok", detail: "ready" },
    ] }),
    inspectStackInit: (rootDir: string) => ({ rootDir, envExists: true,
      dirs: { data: true, logs: true, repos: true }, initialized: true }),
    inspectDatastoreAdministrators: async () => ({ status: "has-admin", databasePath: "/stack/data/propr.sqlite" }),
    persistStackRoot: async () => undefined,
    readEnvVars: () => ({ ...env }),
    applyEnvSelection: (_root: string, vars: Record<string, string>) => {
      Object.assign(env, vars);
      return { written: Object.keys(vars), skipped: [] };
    },
    clearEnvKeys: () => undefined,
    detectGithubAuthMode: () => env.GH_AUTH_MODE === "relay"
      ? { mode: "relay", warnings: [] }
      : { mode: "none", warnings: [] },
    prepareAgentCredentialDir: () => undefined,
    pullImages: async () => ({ pulledCore: [], pulledAgents: [], failedCore: [], failedAgents: [] }),
    isStackRunning: async () => true,
    checkBackendHealth: async () => ({ healthy: true, detail: "ready" }),
    configureVisualPreviewCredential: async () => ({ status: "already-configured" }),
    addRepository: async () => undefined,
    resolveUiUrl: async () => undefined,
    openUrl: async (url: string) => { opened.push(url); },
    saveWhitelistSetting: async () => undefined,
    hasGithubToken: () => true,
    fetchRelayInstallations: async () => ({
      username: "octocat",
      installations: ++discoveries === 1
        ? []
        : [{ installation_id: 42, account_login: "octo-org", account_type: "Organization" }],
    }),
    enrollRelay: async ({ relayUrl, installationId }: { relayUrl: string; installationId: string }) => {
      enrolledId = installationId;
      return { relayUrl, token: "prt_test" };
    },
    loginWithGithub: async () => true,
    listAgents: async () => [],
    addAgent: async () => undefined,
    loginableAgents: async () => [],
    loginAgent: async () => ({ available: false, success: false }),
    validateAgents: async () => [],
  } as unknown as SetupActions;

  const result = await runSetup({ root: "/stack", prompts, actions });

  assert.equal(result.completed, true);
  assert.equal(discoveries, 3);
  assert.equal(enrolledId, "42");
  assert.deepEqual(opened, ["https://github.com/apps/propr-dev/installations/new"]);
  assert.deepEqual(promptTitles, [
    "Install the default ProPR GitHub App?",
    "GitHub App installation complete?",
    "Choose a GitHub App installation",
  ]);
});

test("buildSetupPrompts collects GitHub App vars across chained inputs", async () => {
  const bridge = new SetupBridge();
  const seen: SetupPrompt[] = [];
  bridge.subscribe((event) => {
    if (event.type === "prompt") {
      seen.push(event.prompt);
      // Answer each prompt as it arrives so the chained hook can proceed.
      const prompt = event.prompt;
      queueMicrotask(() => {
        if (prompt.kind === "select") bridge.resolve(prompt.id, "app");
        else if (prompt.kind === "input") bridge.resolve(prompt.id, `val-${prompt.title.length}`);
      });
    }
  });
  const hooks = buildSetupPrompts(bridge);
  const decision = await hooks.configureGithubAuth!({ current: { mode: "none", warnings: [] } });

  assert.equal(decision.mode, "app");
  assert.equal(decision.vars?.GH_AUTH_MODE, "app");
  assert.ok(decision.vars?.GH_APP_ID);
  assert.ok(decision.vars?.HOST_GH_PRIVATE_KEY);
  assert.ok(decision.vars?.GH_INSTALLATION_ID);
});

test("buildSetupPrompts maps intake selection and chains a masked webhook secret", async () => {
  const bridge = new SetupBridge();
  const seen: SetupPrompt[] = [];
  bridge.subscribe((event) => {
    if (event.type === "prompt") {
      seen.push(event.prompt);
      const prompt = event.prompt;
      queueMicrotask(() => {
        if (prompt.kind === "select") bridge.resolve(prompt.id, "direct_webhook");
        else if (prompt.kind === "input") bridge.resolve(prompt.id, "hook-secret");
      });
    }
  });
  const hooks = buildSetupPrompts(bridge);
  const decision = await hooks.configureIntake!({ authMode: "app", defaultMode: "polling", currentMode: "polling" });

  assert.deepEqual(decision, { mode: "direct_webhook", webhookSecret: "hook-secret" });
  assert.equal(seen[0].kind, "select", "the intake mode is a single-choice prompt");
  const secretPrompt = seen.find((p) => p.kind === "input");
  assert.equal(secretPrompt?.kind === "input" && secretPrompt.mask, true, "the secret input is masked");
});

test("buildSetupPrompts keeps the current intake when 'keep' is chosen", async () => {
  const bridge = new SetupBridge();
  const prompts = capture(bridge);
  const hooks = buildSetupPrompts(bridge);
  const decision = hooks.configureIntake!({ authMode: "none", defaultMode: "polling", currentMode: "direct_webhook" });
  assert.equal(prompts[0].kind, "select");
  bridge.resolve(prompts[0].id, "keep");
  assert.deepEqual(await decision, { keep: true });
});

test("buildSetupPrompts skips the whitelist prompt in demo mode", async () => {
  const bridge = new SetupBridge();
  const prompts = capture(bridge);
  const hooks = buildSetupPrompts(bridge);
  const result = await hooks.configureWhitelist!({ current: [], demoMode: true });
  assert.equal(result, null);
  assert.equal(prompts.length, 0, "demo mode needs no whitelist input");
});

test("buildSetupPrompts parses a comma-separated whitelist", async () => {
  const bridge = new SetupBridge();
  const prompts = capture(bridge);
  const hooks = buildSetupPrompts(bridge);
  const result = hooks.configureWhitelist!({ current: ["alice"], demoMode: false });
  bridge.resolve(prompts[0].id, " alice, bob ,, carol ");
  assert.deepEqual(await result, ["alice", "bob", "carol"]);
});

test("Ink own-App creation invokes the flow for the selected stack", async () => {
  const bridge = new SetupBridge();
  const answers = ["app", "create", "https://propr.example.com", "integry"];
  bridge.subscribe(event => {
    if (event.type === "prompt") bridge.resolve(event.prompt.id, answers.shift());
  });
  let root: string | undefined;
  const hooks = buildSetupPrompts(bridge, async (options, dependencies) => {
    root = options.root;
    assert.equal(options.org, "integry");
    assert.equal(dependencies?.signal, bridge.abortController.signal);
    return { envPath: "/stack/.env", keyPath: "/stack/key.pem", backupPath: undefined, fields: [], checks: [] };
  });
  assert.deepEqual(await hooks.configureGithubAuth!({ current: { mode: "none", warnings: [] }, rootDir: "/selected-stack" }), { keep: true });
  assert.equal(root, "/selected-stack");
});

for (const mode of ['relay', 'app'] as const) test(`Ink declining ${mode} replacement keeps authentication without creating an App`, async () => {
  const bridge = new SetupBridge();
  const answers = ['app', 'create', false];
  bridge.subscribe(event => {
    if (event.type === 'prompt') {
      if (event.prompt.kind === 'confirm') {
        assert.match(event.prompt.detail!, /timestamped .env backup/);
        assert.equal(event.prompt.defaultValue, false);
      }
      bridge.resolve(event.prompt.id, answers.shift());
    }
  });
  const hooks = buildSetupPrompts(bridge, async () => { throw new Error('must not create'); });
  assert.deepEqual(await hooks.configureGithubAuth!({ current: { mode, warnings: [] } }), { keep: true });
});

test('Ink paste prompt honors its signal and retires the aborted prompt', async () => {
  const bridge = new SetupBridge();
  const controller = new AbortController();
  const done: number[] = [];
  bridge.subscribe(event => { if (event.type === 'prompt-done') done.push(event.id); });
  const prompts = capture(bridge);
  const pending = bridge.input({ title: 'Paste redirect', mask: true }, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(done, [prompts[0].id]);
  bridge.resolve(prompts[0].id, 'late answer');
  const next = bridge.input({ title: 'Next' });
  bridge.resolve(prompts[1].id, 'answer');
  assert.equal(await next, 'answer');
});

test('Ink own-App public URL re-prompts on the default and invalid URL forms', async () => {
  const bridge = new SetupBridge();
  const answers = ['app', 'create', 'https://', 'ftp://example.com', 'https://user:secret@example.com', 'https://example.com?q=1', 'https://example.com#fragment', ' https://propr.example.com ', ''];
  const logs: string[] = [];
  let urlPrompts = 0;
  bridge.subscribe(event => {
    if (event.type === 'log') logs.push(event.line);
    if (event.type === 'prompt') {
      if (event.prompt.title === 'Public ProPR URL') urlPrompts++;
      assert.ok(answers.length > 0);
      bridge.resolve(event.prompt.id, answers.shift());
    }
  });
  let calls = 0;
  const hooks = buildSetupPrompts(bridge, async options => {
    calls++;
    assert.equal(options.publicUrl, 'https://propr.example.com');
    return { envPath: '/stack/.env', keyPath: '/stack/key.pem', backupPath: undefined, fields: [], checks: [] };
  });
  assert.deepEqual(await hooks.configureGithubAuth!({ current: { mode: 'none', warnings: [] }, rootDir: '/stack' }), { keep: true });
  assert.equal(calls, 1);
  assert.equal(urlPrompts, 6);
  assert.match(logs.join('\n'), /absolute HTTP\(S\) public URL/);
  assert.match(logs.join('\n'), /without credentials, query parameters, or a fragment/);
});

test('Ink cancellation during a repeated public URL prompt stops before creation', async () => {
  const bridge = new SetupBridge();
  const answers = ['app', 'create', 'https://'];
  bridge.subscribe(event => {
    if (event.type === 'prompt') {
      if (answers.length) bridge.resolve(event.prompt.id, answers.shift());
      else bridge.cancel();
    }
  });
  const hooks = buildSetupPrompts(bridge, async () => { assert.fail('must not create'); });
  await assert.rejects(hooks.configureGithubAuth!({ current: { mode: 'none', warnings: [] } }), SetupCancelledError);
});
