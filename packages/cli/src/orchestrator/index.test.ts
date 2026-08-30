import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigManager } from "../config/ConfigManager.js";
import { connectExecutionEnvironment, getHostConfig } from "./index.js";

function createStackRoot(parent: string, name: string): string {
  const root = join(parent, name);
  mkdirSync(root);
  for (const dir of ["data", "logs", "repos"]) mkdirSync(join(root, dir));
  writeFileSync(join(root, ".env"), "");
  return root;
}

test("explicit new root does not inherit legacy tunnel intent during start preflight", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "propr-root-isolation-test-"));
  try {
    const rootA = createStackRoot(tempDir, "root-a");
    const rootB = createStackRoot(tempDir, "root-b");
    const configDir = join(tempDir, "config");
    mkdirSync(configDir);
    writeFileSync(join(configDir, "config.json"), JSON.stringify({
      stackRoot: rootA,
      tunnelEnabled: true,
    }));

    const configManager = new ConfigManager(configDir);
    await configManager.init();

    const rootAHost = await getHostConfig({ configManager, root: rootA });
    assert.equal(rootAHost.cfg.uiTunnelEnabled, true);

    // This is the same resolution and validation path used by setup's
    // startStack action after the user accepts "Start the stack now?".
    const rootBHost = await getHostConfig({ configManager, root: rootB });
    assert.equal(rootBHost.cfg.uiTunnelEnabled, false);
    const preflight = rootBHost.orch.validateEnv(rootBHost.cfg);
    assert.equal(preflight.ok, true, preflight.errors.join("\n"));

    // Persisting setup's newly selected default root must not move A's intent.
    await configManager.setStackRoot(rootB);
    assert.equal(configManager.getTunnelEnabled(rootA), true);
    assert.equal(configManager.getTunnelEnabled(rootB), undefined);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Connect forwards only validated Docker transport and process bootstrap variables", () => {
  const environment = connectExecutionEnvironment({
    PATH: "/trusted/bin",
    DOCKER_HOST: "tcp://127.0.0.1:2376",
    DOCKER_CONTEXT: "remote-context",
    DOCKER_TLS: "1",
    DOCKER_TLS_VERIFY: "1",
    DOCKER_CERT_PATH: "/private/certs",
    DOCKER_CONFIG: "/private/docker-config",
    PROPR_UI_TUNNEL_TOKEN: "must-not-cross",
    HOME: "/must-not-cross",
  });
  assert.deepEqual(environment, {
    PATH: "/trusted/bin",
    DOCKER_HOST: "tcp://127.0.0.1:2376",
    DOCKER_CONTEXT: "remote-context",
    DOCKER_TLS: "1",
    DOCKER_TLS_VERIFY: "1",
    DOCKER_CERT_PATH: "/private/certs",
    DOCKER_CONFIG: "/private/docker-config",
  });
  for (const invalid of [
    { DOCKER_HOST: "x".repeat(4097) },
    { DOCKER_CONTEXT: "x".repeat(256) },
    { DOCKER_CONTEXT: "é".repeat(128) },
    { DOCKER_CERT_PATH: "private\0path" },
    { DOCKER_CONFIG: 42 },
    { DOCKER_TLS_VERIFY: "" },
  ]) assert.throws(() => connectExecutionEnvironment(invalid), /environment/);
});
