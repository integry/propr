import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigManager } from "../config/ConfigManager.js";
import { getHostConfig } from "./index.js";

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
