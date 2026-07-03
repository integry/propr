import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigManager } from "./ConfigManager.js";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "propr-cli-config-test-"));
}

function cleanupTempDir(tempDir: string): void {
  rmSync(tempDir, { recursive: true, force: true });
}

test("getRemoteProfiles returns copied profiles and includes an empty default profile", async () => {
  const tempDir = createTempDir();
  try {
    const manager = new ConfigManager(tempDir);
    await manager.init();

    assert.deepEqual(manager.getRemoteProfiles(), { default: {} });

    await manager.setGithubToken("profile-token");
    const profiles = manager.getRemoteProfiles();
    profiles.default.githubToken = "mutated";

    assert.equal(manager.getGithubToken(), "profile-token");
    assert.equal(manager.getRemoteProfiles().default.githubToken, "profile-token");
  } finally {
    cleanupTempDir(tempDir);
  }
});

test("setRemoteProfile updates a named profile without changing the active profile", async () => {
  const tempDir = createTempDir();
  try {
    const manager = new ConfigManager(tempDir);
    await manager.init();

    await manager.setRemoteUrl("https://active.example.com");
    await manager.setRemoteProfile("staging", {
      remoteUrl: "https://staging.example.com",
      githubToken: "staging-token",
      defaultProject: "owner/repo",
    });

    assert.equal(manager.getActiveRemoteProfile(), "default");
    assert.equal(manager.getRemoteUrl(), "https://active.example.com");
    assert.deepEqual(manager.getRemoteProfiles().staging, {
      remoteUrl: "https://staging.example.com",
      githubToken: "staging-token",
      defaultProject: "owner/repo",
    });
  } finally {
    cleanupTempDir(tempDir);
  }
});

test("setRemoteProfile can clear existing profile fields", async () => {
  const tempDir = createTempDir();
  try {
    const manager = new ConfigManager(tempDir);
    await manager.init();

    await manager.setRemoteProfile("staging", {
      remoteUrl: "https://staging.example.com",
      githubToken: "staging-token",
      defaultProject: "owner/repo",
    });
    await manager.setRemoteProfile("staging", {}, ["remoteUrl", "githubToken", "defaultProject"]);

    assert.deepEqual(manager.getRemoteProfiles().staging, {});
  } finally {
    cleanupTempDir(tempDir);
  }
});

test("useRemoteProfile migrates legacy top-level config without leaking it into a new empty profile", async () => {
  const tempDir = createTempDir();
  try {
    writeFileSync(join(tempDir, "config.json"), JSON.stringify({
      activeProfile: "default",
      remoteUrl: "https://legacy.example.com",
      githubToken: "legacy-token",
      defaultProject: "owner/repo",
    }));
    const manager = new ConfigManager(tempDir);
    await manager.init();

    await manager.useRemoteProfile("staging");

    assert.equal(manager.getActiveRemoteProfile(), "staging");
    assert.equal(manager.getRemoteUrl(), undefined);
    assert.equal(manager.getGithubToken(), undefined);
    assert.equal(manager.getDefaultProject(), undefined);
    assert.deepEqual(manager.getRemoteProfiles().default, {
      remoteUrl: "https://legacy.example.com",
      githubToken: "legacy-token",
      defaultProject: "owner/repo",
    });
    assert.deepEqual(manager.getRemoteProfiles().staging, {});
  } finally {
    cleanupTempDir(tempDir);
  }
});

test("partial active profiles do not inherit unrelated credentials from top-level config", async () => {
  const tempDir = createTempDir();
  try {
    writeFileSync(join(tempDir, "config.json"), JSON.stringify({
      activeProfile: "default",
      remoteUrl: "https://legacy.example.com",
      githubToken: "legacy-token",
      defaultProject: "owner/repo",
    }));
    const manager = new ConfigManager(tempDir);
    await manager.init();

    await manager.setRemoteProfile("staging", { remoteUrl: "https://staging.example.com" });
    await manager.useRemoteProfile("staging");

    assert.equal(manager.getRemoteUrl(), "https://staging.example.com");
    assert.equal(manager.getGithubToken(), undefined);
    assert.equal(manager.getDefaultProject(), undefined);
  } finally {
    cleanupTempDir(tempDir);
  }
});
