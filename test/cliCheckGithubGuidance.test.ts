import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkGithubAuth,
  checkGithubIntakeMode,
} from "../packages/cli/src/commands/checkCommands.js";
import type { OrchestratorConfig } from "../packages/cli/src/orchestrator/index.js";

// `propr check` reads process.env first (process.env[k] ?? env[k]), so a stray
// value in the test runner's environment would mask the file env passed in.
// Snapshot and clear the GitHub-related keys around each test, then drive the
// checks purely through the `env` argument.
const MANAGED_KEYS = [
  "GH_AUTH_MODE",
  "GH_APP_ID",
  "GH_INSTALLATION_ID",
  "GH_PRIVATE_KEY_PATH",
  "HOST_GH_PRIVATE_KEY",
  "GH_WEBHOOK_SECRET",
  "GITHUB_EVENT_INTAKE_MODE",
  "ENABLE_GITHUB_WEBHOOKS",
  "PROPR_GH_RELAY_URL",
  "PROPR_GH_RELAY_TOKEN",
  "PROPR_DEMO_MODE",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of MANAGED_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of MANAGED_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// checkGithubAuth only reads cfg.hostGhPrivateKey; the rest of the config is
// irrelevant to these credential checks.
const cfg = { hostGhPrivateKey: undefined } as unknown as OrchestratorConfig;

const MANIFEST_COMMAND = "propr github-app manifest";

describe("propr check — direct webhook own-App guidance", () => {
  test("missing own-App values point at the manifest command when direct_webhook is selected", () => {
    const env = {
      GH_AUTH_MODE: "app",
      GITHUB_EVENT_INTAKE_MODE: "direct_webhook",
    } as Record<string, string>;

    const results = checkGithubAuth(env, cfg);

    const appId = results.find((r) => r.name === "GH_APP_ID");
    assert.strictEqual(appId?.status, "fail");
    assert.match(appId?.fix ?? "", new RegExp(MANIFEST_COMMAND));

    const installationId = results.find((r) => r.name === "GH_INSTALLATION_ID");
    assert.strictEqual(installationId?.status, "fail");
    assert.match(installationId?.fix ?? "", new RegExp(MANIFEST_COMMAND));

    const key = results.find((r) => r.name === "GitHub App key");
    assert.strictEqual(key?.status, "fail");
    assert.match(key?.fix ?? "", new RegExp(MANIFEST_COMMAND));
    // The hint should name the generated files so users know what was written.
    assert.match(appId?.fix ?? "", /github-app\.env/);
  });

  test("generated-but-incomplete setup points at the existing files instead of regenerating", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "propr-manifest-"));
    try {
      // Simulate `propr github-app manifest` / `propr setup` having already
      // written the scaffolding into the stack root.
      writeFileSync(join(rootDir, "github-app-manifest.json"), "{}\n");
      writeFileSync(join(rootDir, "github-app.env"), "GH_AUTH_MODE=app\n");

      const env = {
        GH_AUTH_MODE: "app",
        GITHUB_EVENT_INTAKE_MODE: "direct_webhook",
      } as Record<string, string>;

      const results = checkGithubAuth(env, cfg, rootDir);

      const appId = results.find((r) => r.name === "GH_APP_ID");
      assert.strictEqual(appId?.status, "fail");
      // Still names the command (so it stays discoverable) ...
      assert.match(appId?.fix ?? "", new RegExp(MANIFEST_COMMAND));
      // ... but recognizes the generated files and the stack root instead of
      // telling the user to generate a manifest they already have.
      assert.match(appId?.fix ?? "", /Found generated/);
      assert.match(appId?.fix ?? "", new RegExp(rootDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(appId?.fix ?? "", /Generate a ready-to-fill manifest/);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("intake prerequisite failures recognize generated files too", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "propr-manifest-"));
    try {
      writeFileSync(join(rootDir, "github-app.env"), "GH_AUTH_MODE=app\n");

      const env = {
        GH_AUTH_MODE: "app",
        GITHUB_EVENT_INTAKE_MODE: "direct_webhook",
        // No GH_WEBHOOK_SECRET → prerequisite failure.
      } as Record<string, string>;

      const results = checkGithubIntakeMode(env, rootDir);
      const failures = results.filter(
        (r) => r.name === "GitHub intake mode" && r.status === "fail",
      );

      assert.ok(failures.length >= 1);
      for (const f of failures) {
        assert.match(f.fix ?? "", new RegExp(MANIFEST_COMMAND));
        assert.match(f.fix ?? "", /Found generated/);
      }
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("own-App failures stay manifest-free when the default routing mode is used", () => {
    const env = {
      GH_AUTH_MODE: "app",
      // GITHUB_EVENT_INTAKE_MODE unset → resolves to routing_websocket.
    } as Record<string, string>;

    const results = checkGithubAuth(env, cfg);

    const appId = results.find((r) => r.name === "GH_APP_ID");
    assert.strictEqual(appId?.status, "fail");
    assert.doesNotMatch(appId?.fix ?? "", new RegExp(MANIFEST_COMMAND));
  });
});

describe("propr check — intake-mode prerequisites guidance", () => {
  test("direct_webhook prerequisite failures reference the manifest command", () => {
    const env = {
      GH_AUTH_MODE: "app",
      GITHUB_EVENT_INTAKE_MODE: "direct_webhook",
      // No GH_WEBHOOK_SECRET → prerequisite failure.
    } as Record<string, string>;

    const results = checkGithubIntakeMode(env);
    const failures = results.filter(
      (r) => r.name === "GitHub intake mode" && r.status === "fail",
    );

    assert.ok(failures.length >= 1);
    for (const f of failures) {
      assert.match(f.fix ?? "", new RegExp(MANIFEST_COMMAND));
    }
  });

  test("non-direct-webhook prerequisite failures do not reference the manifest command", () => {
    const env = {
      // routing_websocket (default) with app auth is an invalid combination, so
      // it surfaces a prerequisite failure — but not an own-App manifest one.
      GH_AUTH_MODE: "app",
    } as Record<string, string>;

    const results = checkGithubIntakeMode(env);
    const failures = results.filter(
      (r) => r.name === "GitHub intake mode" && r.status === "fail",
    );

    assert.ok(failures.length >= 1);
    for (const f of failures) {
      assert.doesNotMatch(f.fix ?? "", new RegExp(MANIFEST_COMMAND));
    }
  });
});
