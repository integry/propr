/**
 * Tests for the setup prompt bridge. Run with:
 * `npx tsx --test src/tui/SetupApp.test.tsx` (from packages/cli). These exercise
 * the bridge and the engine→bridge prompt mapping without rendering Ink — the
 * React component is driven by the same events these assert on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SetupBridge, SetupCancelledError, buildSetupPrompts, type SetupPrompt } from "./SetupApp.js";
import type { GithubAuthModeResult } from "@propr/shared";

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
  assert.ok(decision.vars?.GH_PRIVATE_KEY_PATH);
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
        if (prompt.kind === "select") bridge.resolve(prompt.id, "webhooks");
        else if (prompt.kind === "input") bridge.resolve(prompt.id, "hook-secret");
      });
    }
  });
  const hooks = buildSetupPrompts(bridge);
  const decision = await hooks.configureIntake!({ authMode: "app", defaultMode: "app", webhooksEnabled: false });

  assert.deepEqual(decision, { mode: "webhooks", webhookSecret: "hook-secret" });
  assert.equal(seen[0].kind, "select", "the intake mode is a single-choice prompt");
  const secretPrompt = seen.find((p) => p.kind === "input");
  assert.equal(secretPrompt?.kind === "input" && secretPrompt.mask, true, "the secret input is masked");
});

test("buildSetupPrompts keeps the current intake when 'keep' is chosen", async () => {
  const bridge = new SetupBridge();
  const prompts = capture(bridge);
  const hooks = buildSetupPrompts(bridge);
  const decision = hooks.configureIntake!({ authMode: "none", defaultMode: "polling", webhooksEnabled: true });
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
