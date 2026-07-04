import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigManager, isValidRemoteProfileName } from "./ConfigManager.js";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "propr-cli-config-test-"));
}

function cleanupTempDir(tempDir: string): void {
  rmSync(tempDir, { recursive: true, force: true });
}

function writeLegacyRemoteConfig(tempDir: string): void {
  writeFileSync(join(tempDir, "config.json"), JSON.stringify({
    activeProfile: "default",
    remoteUrl: "https://legacy.example.com",
    githubToken: "legacy-token",
    defaultProject: "owner/repo",
  }));
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
    writeLegacyRemoteConfig(tempDir);
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
    writeLegacyRemoteConfig(tempDir);
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

test("setGithubToken preserves unrelated legacy active profile values", async () => {
  const tempDir = createTempDir();
  try {
    writeLegacyRemoteConfig(tempDir);
    const manager = new ConfigManager(tempDir);
    await manager.init();

    await manager.setGithubToken("new-token");

    assert.equal(manager.getGithubToken(), "new-token");
    assert.equal(manager.getRemoteUrl(), "https://legacy.example.com");
    assert.equal(manager.getDefaultProject(), "owner/repo");
    assert.deepEqual(manager.getRemoteProfiles().default, {
      remoteUrl: "https://legacy.example.com",
      githubToken: "new-token",
      defaultProject: "owner/repo",
    });
  } finally {
    cleanupTempDir(tempDir);
  }
});

test("setRemoteUrl preserves unrelated legacy active profile values", async () => {
  const tempDir = createTempDir();
  try {
    writeLegacyRemoteConfig(tempDir);
    const manager = new ConfigManager(tempDir);
    await manager.init();

    await manager.setRemoteUrl("https://new.example.com");

    assert.equal(manager.getRemoteUrl(), "https://new.example.com");
    assert.equal(manager.getGithubToken(), "legacy-token");
    assert.equal(manager.getDefaultProject(), "owner/repo");
  } finally {
    cleanupTempDir(tempDir);
  }
});

test("setDefaultProject preserves unrelated legacy active profile values", async () => {
  const tempDir = createTempDir();
  try {
    writeLegacyRemoteConfig(tempDir);
    const manager = new ConfigManager(tempDir);
    await manager.init();

    await manager.setDefaultProject("new-owner/new-repo");

    assert.equal(manager.getDefaultProject(), "new-owner/new-repo");
    assert.equal(manager.getRemoteUrl(), "https://legacy.example.com");
    assert.equal(manager.getGithubToken(), "legacy-token");
  } finally {
    cleanupTempDir(tempDir);
  }
});

test("clearGithubToken preserves unrelated legacy active profile values", async () => {
  const tempDir = createTempDir();
  try {
    writeLegacyRemoteConfig(tempDir);
    const manager = new ConfigManager(tempDir);
    await manager.init();

    await manager.clearGithubToken();

    assert.equal(manager.getGithubToken(), undefined);
    assert.equal(manager.getRemoteUrl(), "https://legacy.example.com");
    assert.equal(manager.getDefaultProject(), "owner/repo");
    assert.deepEqual(manager.getRemoteProfiles().default, {
      remoteUrl: "https://legacy.example.com",
      defaultProject: "owner/repo",
    });
  } finally {
    cleanupTempDir(tempDir);
  }
});

test("remote profile names reject whitespace, path-like, and control-character values", async () => {
  const tempDir = createTempDir();
  try {
    const manager = new ConfigManager(tempDir);
    await manager.init();

    await assert.rejects(() => manager.useRemoteProfile("bad name"), /Profile name may only contain/);
    await assert.rejects(() => manager.setRemoteProfile("../prod", {}), /Profile name may only contain/);
    await assert.rejects(() => manager.setRemoteProfile("prod\nnext", {}), /Profile name may only contain/);
  } finally {
    cleanupTempDir(tempDir);
  }
});

test("generic get and set operate on the active profile for remote-backed keys", async () => {
  const tempDir = createTempDir();
  try {
    const manager = new ConfigManager(tempDir);
    await manager.init();

    await manager.useRemoteProfile("staging");
    await manager.set("remoteUrl", "https://staging.example.com");

    assert.equal(manager.get("remoteUrl"), "https://staging.example.com");
    assert.equal(manager.getRemoteUrl(), "https://staging.example.com");
    assert.equal(manager.getRemoteProfiles().staging.remoteUrl, "https://staging.example.com");
    assert.equal(manager.getRemoteProfiles().default.remoteUrl, undefined);
  } finally {
    cleanupTempDir(tempDir);
  }
});

test("pre-profile top-level config is migrated into profiles and not written back", async () => {
  const tempDir = createTempDir();
  try {
    writeLegacyRemoteConfig(tempDir);
    const manager = new ConfigManager(tempDir);
    await manager.init();

    assert.equal(manager.getGithubToken(), "legacy-token");
    assert.equal(manager.getRemoteUrl(), "https://legacy.example.com");

    await manager.save();
    const persisted = JSON.parse(readFileSync(join(tempDir, "config.json"), "utf8"));
    assert.equal(persisted.githubToken, undefined);
    assert.equal(persisted.remoteUrl, undefined);
    assert.equal(persisted.defaultProject, undefined);
    assert.deepEqual(persisted.profiles.default, {
      remoteUrl: "https://legacy.example.com",
      githubToken: "legacy-token",
      defaultProject: "owner/repo",
    });
  } finally {
    cleanupTempDir(tempDir);
  }
});

test("useRemoteProfile reports whether a new empty profile was created", async () => {
  const tempDir = createTempDir();
  try {
    const manager = new ConfigManager(tempDir);
    await manager.init();

    assert.equal(manager.hasRemoteProfile("staging"), false);
    assert.deepEqual(await manager.useRemoteProfile("staging"), { created: true });
    assert.equal(manager.hasRemoteProfile("staging"), true);
    assert.deepEqual(await manager.useRemoteProfile("staging"), { created: false });
  } finally {
    cleanupTempDir(tempDir);
  }
});

test("isValidRemoteProfileName mirrors the profile name rules", () => {
  assert.equal(isValidRemoteProfileName("staging"), true);
  assert.equal(isValidRemoteProfileName("prod-2.eu_west"), true);
  assert.equal(isValidRemoteProfileName("bad name"), false);
  assert.equal(isValidRemoteProfileName("../prod"), false);
  assert.equal(isValidRemoteProfileName(""), false);
});

test("loaded remote profile names are validated before use", async () => {
  const tempDir = createTempDir();
  try {
    writeFileSync(join(tempDir, "config.json"), JSON.stringify({
      activeProfile: "../prod",
      profiles: {
        "../prod": { remoteUrl: "https://bad.example.com" },
        staging: { remoteUrl: "https://staging.example.com" },
      },
    }));

    const manager = new ConfigManager(tempDir);
    await manager.init();

    assert.equal(manager.getActiveRemoteProfile(), "default");
    assert.deepEqual(manager.getRemoteProfiles(), {
      default: {},
      staging: { remoteUrl: "https://staging.example.com" },
    });
  } finally {
    cleanupTempDir(tempDir);
  }
});
