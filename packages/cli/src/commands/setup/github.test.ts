/**
 * GitHub intake + whitelist helper tests. Run with:
 * `npx tsx --test src/commands/setup/github.test.ts` (from packages/cli).
 * Pure functions plus an injected-side-effect helper — no Docker/network/TTY.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildIntakeEnvVars,
  defaultIntakeMode,
  IntakeConfigError,
  saveWhitelist,
} from "./github.js";

test("polling and the App/relay path both disable inbound webhooks", () => {
  assert.deepEqual(buildIntakeEnvVars("polling"), { ENABLE_GITHUB_WEBHOOKS: "false" });
  assert.deepEqual(buildIntakeEnvVars("app"), { ENABLE_GITHUB_WEBHOOKS: "false" });
});

test("webhooks enables the listener and records the trimmed secret", () => {
  assert.deepEqual(buildIntakeEnvVars("webhooks", { webhookSecret: "  s3cret  " }), {
    ENABLE_GITHUB_WEBHOOKS: "true",
    GH_WEBHOOK_SECRET: "s3cret",
  });
});

test("an empty or whitespace webhook secret is rejected", () => {
  assert.throws(() => buildIntakeEnvVars("webhooks"), IntakeConfigError);
  assert.throws(() => buildIntakeEnvVars("webhooks", { webhookSecret: "" }), IntakeConfigError);
  assert.throws(() => buildIntakeEnvVars("webhooks", { webhookSecret: "   " }), IntakeConfigError);
});

test("the App/relay path is the default when an App or relay is configured", () => {
  assert.equal(defaultIntakeMode("app"), "app");
  assert.equal(defaultIntakeMode("relay"), "app");
});

test("polling is the default otherwise", () => {
  assert.equal(defaultIntakeMode("none"), "polling");
  assert.equal(defaultIntakeMode("demo"), "polling");
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
