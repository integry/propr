/**
 * GitHub intake + whitelist helper tests. Run with:
 * `npx tsx --test src/commands/setup/github.test.ts` (from packages/cli).
 * Pure functions plus an injected-side-effect helper — no Docker/network/TTY.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildIntakeEnvVars,
  defaultIntakeChoice,
  defaultIntakeMode,
  IntakeConfigError,
  saveWhitelist,
} from "./github.js";

test("routing and polling select the mode via GITHUB_EVENT_INTAKE_MODE", () => {
  assert.deepEqual(buildIntakeEnvVars("polling"), { GITHUB_EVENT_INTAKE_MODE: "polling" });
  assert.deepEqual(buildIntakeEnvVars("routing_websocket"), {
    GITHUB_EVENT_INTAKE_MODE: "routing_websocket",
  });
});

test("direct_webhook selects the mode and records the trimmed secret", () => {
  assert.deepEqual(buildIntakeEnvVars("direct_webhook", { webhookSecret: "  s3cret  " }), {
    GITHUB_EVENT_INTAKE_MODE: "direct_webhook",
    GH_WEBHOOK_SECRET: "s3cret",
  });
});

test("the deprecated ENABLE_GITHUB_WEBHOOKS boolean is never written", () => {
  // It no longer selects the intake mode (see resolveGithubEventIntakeMode), so
  // setup must not write it for any mode.
  for (const mode of ["routing_websocket", "polling"] as const) {
    assert.ok(!("ENABLE_GITHUB_WEBHOOKS" in buildIntakeEnvVars(mode)));
  }
  assert.ok(
    !("ENABLE_GITHUB_WEBHOOKS" in buildIntakeEnvVars("direct_webhook", { webhookSecret: "x" }))
  );
});

test("an empty or whitespace webhook secret is rejected", () => {
  assert.throws(() => buildIntakeEnvVars("direct_webhook"), IntakeConfigError);
  assert.throws(() => buildIntakeEnvVars("direct_webhook", { webhookSecret: "" }), IntakeConfigError);
  assert.throws(() => buildIntakeEnvVars("direct_webhook", { webhookSecret: "   " }), IntakeConfigError);
});

test("routing_websocket is the default only when relay auth is configured", () => {
  assert.equal(defaultIntakeMode("relay"), "routing_websocket");
});

test("polling is the default for every other auth mode", () => {
  // routing_websocket needs the hosted relay (relay auth), so own-App / none /
  // demo all fall back to polling, which works with any usable GitHub auth.
  assert.equal(defaultIntakeMode("app"), "polling");
  assert.equal(defaultIntakeMode("none"), "polling");
  assert.equal(defaultIntakeMode("demo"), "polling");
});

test("a fresh install pre-selects the auth-derived intake recommendation", () => {
  assert.equal(defaultIntakeChoice("relay", { intakeConfigured: false }), "routing_websocket");
  assert.equal(defaultIntakeChoice("app", { intakeConfigured: false }), "polling");
  assert.equal(defaultIntakeChoice("none", { intakeConfigured: false }), "polling");
});

test("an existing intake config pre-selects keep, so a blank Enter never rewrites it", () => {
  // Even when the auth-derived recommendation differs, an install that already
  // chose a mode must default to "keep".
  assert.equal(defaultIntakeChoice("relay", { intakeConfigured: true }), "keep");
  assert.equal(defaultIntakeChoice("none", { intakeConfigured: true }), "keep");
});

test("a running backend saves through settings and mirrors into .env", async () => {
  const settings: string[][] = [];
  const env: string[][] = [];
  const result = await saveWhitelist({
    users: ["alice", "bob"],
    backendRunning: true,
    saveViaSettings: async (users) => {
      settings.push(users);
    },
    saveViaEnv: (users) => {
      env.push(users);
    },
  });

  assert.equal(result.target, "settings");
  assert.equal(result.count, 2);
  assert.equal(result.error, undefined);
  assert.deepEqual(settings, [["alice", "bob"]], "saved through the settings API");
  assert.deepEqual(env, [["alice", "bob"]], "and mirrored into .env");
});

test("a down backend saves to .env only", async () => {
  let settingsCalled = false;
  const env: string[][] = [];
  const result = await saveWhitelist({
    users: ["carol"],
    backendRunning: false,
    saveViaSettings: async () => {
      settingsCalled = true;
    },
    saveViaEnv: (users) => {
      env.push(users);
    },
  });

  assert.equal(settingsCalled, false);
  assert.equal(result.target, "env");
  assert.deepEqual(env, [["carol"]]);
});

test("a failed settings save falls back to .env and reports the error", async () => {
  const env: string[][] = [];
  const result = await saveWhitelist({
    users: ["dave"],
    backendRunning: true,
    saveViaSettings: async () => {
      throw new Error("backend rejected the update");
    },
    saveViaEnv: (users) => {
      env.push(users);
    },
  });

  assert.equal(result.target, "env");
  assert.match(result.error ?? "", /backend rejected/);
  assert.deepEqual(env, [["dave"]], "the value is preserved in .env");
});
