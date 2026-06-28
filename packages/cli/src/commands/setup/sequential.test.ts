/**
 * Sequential fallback wizard tests. Run with:
 * `npx tsx --test src/commands/setup/sequential.test.ts` (from packages/cli).
 *
 * A scripted in-memory {@link SequentialIo} stands in for the terminal, so these
 * exercise the prompt mapping, the reporter, and a full engine run without a
 * TTY, readline, Docker, or the network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSequentialPrompts,
  buildSequentialReporter,
  runSequentialSetup,
  SequentialSetupUnavailableError,
  type SequentialIo,
} from "./sequential.js";
import type { SetupActions } from "./engine.js";
import type { ChecksOutcome } from "../checkCommands.js";
import type { GithubAuthModeResult } from "@propr/shared";
import { getStep } from "./state.js";
import type { SetupState } from "./types.js";

/**
 * A scripted I/O: every `ask` consumes the next queued answer; every printed
 * line and posed question is recorded for assertions. Running out of answers is
 * a test bug, so it throws loudly rather than hanging.
 */
function scriptedIo(answers: string[]): SequentialIo & { lines: string[]; questions: string[]; masked: string[] } {
  const queue = [...answers];
  const lines: string[] = [];
  const questions: string[] = [];
  const masked: string[] = [];
  return {
    lines,
    questions,
    masked,
    print(line = "") {
      lines.push(line);
    },
    async ask(question, opts) {
      questions.push(question);
      if (opts?.mask) masked.push(question);
      if (queue.length === 0) throw new Error(`scriptedIo ran out of answers at: ${question}`);
      return queue.shift()!;
    },
    close() {},
  };
}

// --- prompt primitives ------------------------------------------------------

test("confirm: blank entry takes the default, y/n override it", async () => {
  const io = scriptedIo([""]);
  const hooks = buildSequentialPrompts(io);
  assert.equal(await hooks.confirmStartStack!({ rootDir: "/s", alreadyRunning: false }), true);

  const ioNo = scriptedIo(["n"]);
  const hooksNo = buildSequentialPrompts(ioNo);
  assert.equal(await hooksNo.confirmStartStack!({ rootDir: "/s", alreadyRunning: false }), false);
});

test("confirm: an already-running stack is reused without prompting", async () => {
  const io = scriptedIo([]); // no answers needed
  const hooks = buildSequentialPrompts(io);
  assert.equal(await hooks.confirmStartStack!({ rootDir: "/s", alreadyRunning: true }), true);
  assert.equal(io.questions.length, 0, "no prompt when the stack already runs");
});

test("input: blank keeps the current root, a value replaces it", async () => {
  const io = scriptedIo([""]);
  const init = { rootDir: "/cur", envExists: true, dirs: { data: true, logs: true, repos: true }, initialized: false };
  const decision = await buildSequentialPrompts(io).resolveStackRoot!({ currentRoot: "/cur", init });
  assert.deepEqual(decision, { rootDir: "/cur", reinitialize: false });

  const io2 = scriptedIo(["/new"]);
  const decision2 = await buildSequentialPrompts(io2).resolveStackRoot!({ currentRoot: "/cur", init });
  assert.equal(decision2.rootDir, "/new");
});

test("select: numeric choice maps to the option value, blank to the default", async () => {
  const current: GithubAuthModeResult = { mode: "app", warnings: [] };

  // With an existing config, "Keep current configuration" leads and is the
  // blank-Enter default.
  const keep = await buildSequentialPrompts(scriptedIo([""])).configureGithubAuth!({ current });
  assert.deepEqual(keep, { keep: true }, "blank → default → keep current auth");

  // Options are keep(1), Token relay(2), Custom GitHub App(3); option 3 selects
  // the custom-app branch and collects its three inputs.
  const app = await buildSequentialPrompts(scriptedIo(["3", "123", "/key.pem", "456"])).configureGithubAuth!({ current });
  assert.equal(app.mode, "app");
  assert.equal(app.vars?.GH_AUTH_MODE, "app");
  assert.equal(app.vars?.GH_APP_ID, "123");
});

test("select: Demo mode is no longer offered as an auth choice", async () => {
  const io = scriptedIo([""]);
  await buildSequentialPrompts(io).configureGithubAuth!({ current: { mode: "app", warnings: [] } });
  assert.doesNotMatch(io.lines.join("\n"), /demo/i, "the demo option is removed from the auth prompt");
});

test("select: on a fresh install Token relay leads and no keep option is shown", async () => {
  // current.mode "none" → nothing to keep, so options are Token relay(1), Custom
  // GitHub App(2); option 1 is the relay branch. The relay branch now asks only
  // for the relay URL (default hosted) and signals enrollment — no token entry;
  // the engine mints the token from the stored login.
  const io = scriptedIo(["1", "https://relay.example"]);
  const decision = await buildSequentialPrompts(io).configureGithubAuth!({ current: { mode: "none", warnings: [] } });
  assert.equal(decision.mode, "relay");
  assert.equal(decision.enrollRelay?.relayUrl, "https://relay.example");
  assert.equal(decision.vars, undefined, "relay path no longer writes vars directly");
  assert.equal(io.masked.length, 0, "no secret is prompted in the relay path");
  assert.doesNotMatch(io.lines.join("\n"), /keep current/i, "no keep option without an existing config");
});

test("select: Token relay accepts the hosted relay default on a blank URL", async () => {
  // Blank URL → the hosted ProPR relay default is used.
  const io = scriptedIo(["1", ""]);
  const decision = await buildSequentialPrompts(io).configureGithubAuth!({ current: { mode: "none", warnings: [] } });
  assert.equal(decision.mode, "relay");
  assert.match(decision.enrollRelay?.relayUrl ?? "", /^https?:\/\//, "falls back to the hosted relay URL");
});

test("select: an out-of-range number re-prompts until valid", async () => {
  // current.mode "none" → options Token relay(1), Custom GitHub App(2). Two
  // invalid choices, then option 2 (the custom App), then its three inputs.
  const io = scriptedIo(["9", "0", "2", "123", "/key.pem", "456"]);
  const decision = await buildSequentialPrompts(io).configureGithubAuth!({ current: { mode: "none", warnings: [] } });
  assert.equal(decision.mode, "app", "option 2 is the custom GitHub App branch");
  assert.equal(decision.vars?.GH_APP_ID, "123");
  // The two invalid choices were re-prompted before the valid one was accepted.
  assert.ok(io.questions.length >= 6);
});

test("multiSelect: blank keeps detected defaults, numbers replace them, 'none' clears", async () => {
  const ctx = { available: ["claude", "codex", "vibe"], detected: ["claude"] };

  assert.deepEqual(await buildSequentialPrompts(scriptedIo([""])).selectAgents!(ctx), ["claude"]);
  assert.deepEqual(await buildSequentialPrompts(scriptedIo(["1,3"])).selectAgents!(ctx), ["claude", "vibe"]);
  assert.deepEqual(await buildSequentialPrompts(scriptedIo(["none"])).selectAgents!(ctx), []);
});

test("multiSelect: duplicate and reordered numbers de-dupe and keep option order", async () => {
  const ctx = { available: ["claude", "codex", "vibe"], detected: [] };
  assert.deepEqual(await buildSequentialPrompts(scriptedIo(["3,1,1"])).selectAgents!(ctx), ["claude", "vibe"]);
});

test("whitelist: demo mode skips the prompt, otherwise parses a comma list", async () => {
  const skipIo = scriptedIo([]);
  assert.equal(await buildSequentialPrompts(skipIo).configureWhitelist!({ current: [], demoMode: true }), null);
  assert.equal(skipIo.questions.length, 0);

  const io = scriptedIo([" alice, bob ,, carol "]);
  assert.deepEqual(await buildSequentialPrompts(io).configureWhitelist!({ current: ["x"], demoMode: false }), ["alice", "bob", "carol"]);
});

test('whitelist: "none" clears the list, blank re-affirms the current value', async () => {
  const cleared = await buildSequentialPrompts(scriptedIo(["none"])).configureWhitelist!({ current: ["alice"], demoMode: false });
  assert.deepEqual(cleared, [], '"none" empties the whitelist');

  // Blank falls back to the shown default (the current value), so the list is
  // preserved verbatim rather than cleared.
  const kept = await buildSequentialPrompts(scriptedIo([""])).configureWhitelist!({ current: ["alice"], demoMode: false });
  assert.deepEqual(kept, ["alice"], "blank keeps the current value");
});

test("intake: blank picks the recommended default mode", async () => {
  // Options are routing_websocket, polling, direct_webhook, keep — defaultMode
  // "routing_websocket" is option 1, so a blank answer selects it.
  const io = scriptedIo([""]);
  const decision = await buildSequentialPrompts(io).configureIntake!({
    authMode: "relay",
    defaultMode: "routing_websocket",
    currentMode: "routing_websocket",
  });
  assert.deepEqual(decision, { mode: "routing_websocket" });
  assert.match(io.lines.join("\n"), /docs\.propr\.dev/, "docs link is surfaced in the detail text");
});

test("intake: choosing direct webhooks requires a non-empty secret, re-asking on blank", async () => {
  // Choose option 3 (direct_webhook), enter a blank secret (rejected), then a real one.
  const io = scriptedIo(["3", "", "hook-secret"]);
  const decision = await buildSequentialPrompts(io).configureIntake!({
    authMode: "app",
    defaultMode: "polling",
    currentMode: "polling",
  });
  assert.deepEqual(decision, { mode: "direct_webhook", webhookSecret: "hook-secret" });
  assert.equal(io.masked.length, 2, "the secret prompt is masked, and was asked twice");
  assert.match(io.lines.join("\n"), /webhook secret is required/i);
});

test("intake: an option invalid for the auth mode is inactive and cannot be chosen", async () => {
  // With relay auth, direct webhooks (option 3) are unavailable. Choosing it is
  // rejected, then polling (option 2) is accepted.
  const io = scriptedIo(["3", "2"]);
  const decision = await buildSequentialPrompts(io).configureIntake!({
    authMode: "relay",
    defaultMode: "routing_websocket",
    currentMode: "routing_websocket",
  });
  assert.deepEqual(decision, { mode: "polling" });
  const out = io.lines.join("\n");
  assert.match(out, /unavailable/i, "the disabled option is labelled unavailable");
  assert.match(out, /not recommended for production/i, "polling carries its production caveat");
});

test("intake: keep leaves the current configuration untouched", async () => {
  // Option 4 is "keep".
  const io = scriptedIo(["4"]);
  const decision = await buildSequentialPrompts(io).configureIntake!({
    authMode: "none",
    defaultMode: "polling",
    currentMode: "direct_webhook",
  });
  assert.deepEqual(decision, { keep: true });
});

test("intake: a defaultMode of keep makes a blank answer keep the current config", async () => {
  // On a re-run the engine passes defaultMode "keep" when .env already records an
  // intake decision, so a blank Enter must not rewrite a working config.
  const io = scriptedIo([""]);
  const decision = await buildSequentialPrompts(io).configureIntake!({
    authMode: "app",
    defaultMode: "keep",
    currentMode: "direct_webhook",
  });
  assert.deepEqual(decision, { keep: true });
});

test("selectAgents: an empty option list returns [] without prompting", async () => {
  const io = scriptedIo([]); // no answers — must not pose a prompt
  assert.deepEqual(await buildSequentialPrompts(io).selectAgents!({ available: [], detected: [] }), []);
  assert.equal(io.questions.length, 0, "no prompt when there is nothing to choose");
});

test("addRepository: declining returns null, accepting collects owner/repo", async () => {
  assert.equal(await buildSequentialPrompts(scriptedIo(["n"])).addRepository!({ rootDir: "/s" }), null);

  const io = scriptedIo(["y", "integry/propr", ""]);
  assert.deepEqual(await buildSequentialPrompts(io).addRepository!({ rootDir: "/s" }), {
    fullName: "integry/propr",
    baseBranch: undefined,
  });
});

// --- reporter ---------------------------------------------------------------

test("reporter prints a heading on start and a glyph + detail on settle", () => {
  const io = scriptedIo([]);
  const reporter = buildSequentialReporter(io);
  reporter.onStepStart!({ id: "check", title: "Environment checks", description: "Verify Docker.", optional: false, status: "active" });
  reporter.onLog!("pulling propr/api…");
  reporter.onStepSettled!({ id: "check", title: "Environment checks", description: "Verify Docker.", optional: false, status: "done", detail: "8 checks ok" });

  const text = io.lines.join("\n");
  assert.match(text, /Environment checks/);
  assert.match(text, /pulling propr\/api/);
  assert.match(text, /8 checks ok/);
});

test("reporter surfaces the next action for a failed step", () => {
  const io = scriptedIo([]);
  buildSequentialReporter(io).onStepSettled!({
    id: "check",
    title: "Environment checks",
    description: "",
    optional: false,
    status: "failed",
    detail: "Docker daemon unreachable",
    nextAction: "Start Docker, then re-run setup.",
  });
  assert.match(io.lines.join("\n"), /Start Docker, then re-run setup\./);
});

// --- entry point ------------------------------------------------------------

test("runSequentialSetup fails fast with guidance when stdin is not a TTY", async () => {
  await assert.rejects(
    runSequentialSetup({ input: { isTTY: false } as NodeJS.ReadableStream & { isTTY?: boolean } }),
    (error) => {
      assert.ok(error instanceof SequentialSetupUnavailableError);
      assert.match(error.message, /interactive terminal/);
      assert.match(error.message, /propr init stack/);
      return true;
    }
  );
});

// --- full engine run --------------------------------------------------------

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

function mockActions(overrides: Partial<SetupActions> = {}): SetupActions {
  return {
    runChecks: async ({ root }) => okChecks(root ?? "/stack"),
    inspectStackInit: (rootDir) => ({ rootDir, envExists: true, dirs: { data: true, logs: true, repos: true }, initialized: true }),
    scaffoldStack: async ({ root }) => {
      throw new Error(`scaffoldStack must not run for an initialized stack (${root})`);
    },
    persistStackRoot: async () => undefined,
    readEnvVars: () => ({ GITHUB_USER_WHITELIST: "alice,bob" }),
    applyEnvSelection: () => ({ written: [], skipped: [] }),
    clearEnvKeys: () => undefined,
    detectGithubAuthMode: () => ({ mode: "app", warnings: [] }),
    inspectGithubAppManifest: (rootDir) => ({
      manifestPath: `${rootDir}/github-app-manifest.json`,
      envPath: `${rootDir}/github-app.env`,
      exists: false,
    }),
    generateGithubAppManifest: async ({ rootDir }) => ({
      manifestPath: `${rootDir}/github-app-manifest.json`,
      envPath: `${rootDir}/github-app.env`,
      webhookUrl: "https://propr.example.com/webhook",
      createUrl: "https://github.com/settings/apps/new",
    }),
    pullImages: async () => ({ pulledCore: ["propr/api"], pulledAgents: [], failedCore: [], failedAgents: [] }),
    isStackRunning: async () => false,
    startStack: async () => undefined,
    checkBackendHealth: async () => ({ healthy: true, detail: "API healthy" }),
    addRepository: async () => undefined,
    resolveUiUrl: async () => "http://localhost:3000",
    openUrl: async () => undefined,
    saveWhitelistSetting: async () => undefined,
    // Relay enrollment / login actions — inert by default.
    hasGithubToken: () => true,
    fetchRelayInstallations: async () => ({ username: "octocat", installations: [] }),
    enrollRelay: async () => ({ relayUrl: "https://relay/v1", token: "prt_test" }),
    loginWithGithub: async () => true,
    // Agent enablement / image-login actions — inert so the scripted run never
    // reaches the backend, Docker, or an extra login prompt.
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

test("runSequentialSetup drives the engine end to end through scripted answers", async () => {
  // Answers, in prompt order for an already-initialized stack:
  //   resolveStackRoot (blank → keep /stack), re-scaffold? (n),
  //   selectAgents (blank → detected), githubAuth (blank → keep),
  //   configureIntake (blank → recommended default), confirmStartStack (blank → yes),
  //   whitelist (blank → keep current), addRepository (n), launchUi (n).
  const io = scriptedIo(["", "n", "", "", "", "", "", "n", "n"]);

  const result = await runSequentialSetup({
    io,
    root: "/stack",
    actions: mockActions(),
  });

  assert.equal(result.completed, true);
  assert.equal(statusOf(result.state, "init-stack"), "skipped");
  assert.equal(statusOf(result.state, "start-stack"), "done");

  const text = io.lines.join("\n");
  assert.match(text, /ProPR setup/);
  assert.match(text, /Setup complete/);
});

test("runSequentialSetup reports an unfinished run when a required step fails", async () => {
  // The check step fails immediately, so no further prompts are consumed.
  const io = scriptedIo([]);
  const result = await runSequentialSetup({
    io,
    root: "/stack",
    actions: mockActions({
      runChecks: async ({ root }) => ({
        rootDir: root ?? "/stack",
        anyFail: true,
        cfg: {} as ChecksOutcome["cfg"],
        results: [{ name: "Docker daemon", status: "fail", detail: "daemon unreachable", group: "Docker" }],
      }),
    }),
  });

  assert.equal(result.completed, false);
  assert.equal(statusOf(result.state, "check"), "failed");
  assert.match(io.lines.join("\n"), /did not finish/);
});
