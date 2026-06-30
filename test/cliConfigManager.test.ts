import { test, beforeEach, afterEach, describe } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConfigManager, DEFAULT_CONFIG, CLIConfig } from "@propr/cli";

/**
 * Test suite for CLI ConfigManager.
 *
 * Tests cover:
 * - Configuration initialization
 * - Getter and setter methods for all config keys
 * - Handling missing configuration files
 * - Handling corrupted configuration files
 * - Configuration persistence
 */

// Helper to create a unique temp directory for each test
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "propr-cli-test-"));
}

// Helper to clean up temp directory
function cleanupTempDir(tempDir: string): void {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

test("ConfigManager", async (t) => {
  let tempDir: string;
  let configManager: ConfigManager;

  beforeEach(() => {
    tempDir = createTempDir();
    configManager = new ConfigManager(tempDir);
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  await t.test("should initialize with default values when no config file exists", async () => {
    tempDir = createTempDir();
    configManager = new ConfigManager(tempDir);

    await configManager.init();
    const config = configManager.getAll();

    assert.strictEqual(config.githubToken, undefined);
    assert.strictEqual(config.remoteUrl, undefined);
    assert.strictEqual(config.defaultProject, undefined);

    cleanupTempDir(tempDir);
  });

  await t.test("should create config directory if it doesn't exist", async () => {
    tempDir = createTempDir();
    const nestedDir = path.join(tempDir, "nested", "config");
    configManager = new ConfigManager(nestedDir);

    await configManager.init();
    await configManager.setGithubToken("test-token");

    assert.ok(fs.existsSync(nestedDir));
    assert.ok(fs.existsSync(path.join(nestedDir, "config.json")));

    cleanupTempDir(tempDir);
  });

  await t.test("should set and get githubToken", async () => {
    tempDir = createTempDir();
    configManager = new ConfigManager(tempDir);

    await configManager.init();
    await configManager.setGithubToken("ghp_test123");

    assert.strictEqual(configManager.getGithubToken(), "ghp_test123");

    cleanupTempDir(tempDir);
  });

  await t.test("should set and get remoteUrl", async () => {
    tempDir = createTempDir();
    configManager = new ConfigManager(tempDir);

    await configManager.init();
    await configManager.setRemoteUrl("https://api.example.com");

    assert.strictEqual(configManager.getRemoteUrl(), "https://api.example.com");

    cleanupTempDir(tempDir);
  });

  await t.test("should set and get defaultProject", async () => {
    tempDir = createTempDir();
    configManager = new ConfigManager(tempDir);

    await configManager.init();
    await configManager.setDefaultProject("owner/repo");

    assert.strictEqual(configManager.getDefaultProject(), "owner/repo");

    cleanupTempDir(tempDir);
  });

  await t.test("should persist configuration between instances", async () => {
    tempDir = createTempDir();

    // Create and save config with first instance
    const manager1 = new ConfigManager(tempDir);
    await manager1.init();
    await manager1.setGithubToken("persist-token");
    await manager1.setRemoteUrl("https://persist.example.com");
    await manager1.setDefaultProject("persist/project");

    // Create new instance and verify persistence
    const manager2 = new ConfigManager(tempDir);
    await manager2.init();

    assert.strictEqual(manager2.getGithubToken(), "persist-token");
    assert.strictEqual(manager2.getRemoteUrl(), "https://persist.example.com");
    assert.strictEqual(manager2.getDefaultProject(), "persist/project");

    cleanupTempDir(tempDir);
  });

  await t.test("should persist tunnelEnabled across instances (survives load/sanitize)", async () => {
    tempDir = createTempDir();

    // Turning the tunnel off must survive a fresh CLI process so `propr start`
    // honors a previous `propr tunnel off` even when a token is configured.
    const manager1 = new ConfigManager(tempDir);
    await manager1.init();
    await manager1.setTunnelEnabled(false);

    const manager2 = new ConfigManager(tempDir);
    await manager2.init();

    // The persisted value must come back through load()/sanitizeConfig() rather
    // than being dropped (regression guard for the missing sanitize entry).
    assert.strictEqual(manager2.getTunnelEnabled(), false);
    assert.strictEqual(manager2.get("tunnelEnabled"), false);

    // An explicit `on` round-trips too.
    await manager2.setTunnelEnabled(true);
    const manager3 = new ConfigManager(tempDir);
    await manager3.init();
    assert.strictEqual(manager3.getTunnelEnabled(), true);

    cleanupTempDir(tempDir);
  });

  await t.test("getTunnelEnabled returns undefined when unset (defers to env default)", async () => {
    tempDir = createTempDir();
    configManager = new ConfigManager(tempDir);

    await configManager.init();

    // Unset means "defer to the launcher's env-derived default", so it must
    // stay undefined rather than collapsing to false.
    assert.strictEqual(configManager.getTunnelEnabled(), undefined);

    cleanupTempDir(tempDir);
  });

  await t.test("should handle corrupted JSON gracefully", async () => {
    tempDir = createTempDir();

    // Create corrupted config file
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "config.json"), "{ invalid json }");

    configManager = new ConfigManager(tempDir);
    await configManager.init();

    // Should fallback to defaults
    const config = configManager.getAll();
    assert.strictEqual(config.githubToken, undefined);
    assert.strictEqual(config.remoteUrl, undefined);
    assert.strictEqual(config.defaultProject, undefined);

    cleanupTempDir(tempDir);
  });

  await t.test("should handle non-object JSON gracefully", async () => {
    tempDir = createTempDir();

    // Create config file with array instead of object
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "config.json"), JSON.stringify(["not", "an", "object"]));

    configManager = new ConfigManager(tempDir);
    await configManager.init();

    // Should fallback to defaults
    const config = configManager.getAll();
    assert.strictEqual(config.githubToken, undefined);

    cleanupTempDir(tempDir);
  });

  await t.test("should handle null JSON value gracefully", async () => {
    tempDir = createTempDir();

    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "config.json"), "null");

    configManager = new ConfigManager(tempDir);
    await configManager.init();

    // Should fallback to defaults
    const config = configManager.getAll();
    assert.strictEqual(config.githubToken, undefined);

    cleanupTempDir(tempDir);
  });

  await t.test("should sanitize invalid config values", async () => {
    tempDir = createTempDir();

    // Create config with wrong types
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "config.json"),
      JSON.stringify({
        githubToken: 12345, // Should be string
        remoteUrl: { url: "test" }, // Should be string
        defaultProject: true, // Should be string
        unknownKey: "ignored", // Should be ignored
      })
    );

    configManager = new ConfigManager(tempDir);
    await configManager.init();

    // Invalid types should be ignored, resulting in undefined
    const config = configManager.getAll();
    assert.strictEqual(config.githubToken, undefined);
    assert.strictEqual(config.remoteUrl, undefined);
    assert.strictEqual(config.defaultProject, undefined);

    cleanupTempDir(tempDir);
  });

  await t.test("should reset configuration", async () => {
    tempDir = createTempDir();
    configManager = new ConfigManager(tempDir);

    await configManager.init();
    await configManager.setGithubToken("test-token");
    await configManager.setRemoteUrl("https://test.com");

    await configManager.reset();

    const config = configManager.getAll();
    assert.strictEqual(config.githubToken, undefined);
    assert.strictEqual(config.remoteUrl, undefined);
    assert.strictEqual(config.defaultProject, undefined);

    cleanupTempDir(tempDir);
  });

  await t.test("should delete config file", async () => {
    tempDir = createTempDir();
    configManager = new ConfigManager(tempDir);

    await configManager.init();
    await configManager.setGithubToken("test-token");

    assert.ok(await configManager.configFileExists());

    await configManager.deleteConfigFile();

    assert.ok(!(await configManager.configFileExists()));
    assert.strictEqual(configManager.getGithubToken(), undefined);

    cleanupTempDir(tempDir);
  });

  await t.test("should not throw when deleting non-existent config file", async () => {
    tempDir = createTempDir();
    configManager = new ConfigManager(tempDir);

    await configManager.init();
    // Don't create any config file

    // Should not throw
    await configManager.deleteConfigFile();
    assert.ok(true);

    cleanupTempDir(tempDir);
  });

  await t.test("should return correct config file path", async () => {
    tempDir = createTempDir();
    configManager = new ConfigManager(tempDir);

    assert.strictEqual(
      configManager.getConfigFilePath(),
      path.join(tempDir, "config.json")
    );

    cleanupTempDir(tempDir);
  });

  await t.test("should return correct config directory", async () => {
    tempDir = createTempDir();
    configManager = new ConfigManager(tempDir);

    assert.strictEqual(configManager.getConfigDir(), tempDir);

    cleanupTempDir(tempDir);
  });

  await t.test("init should be idempotent", async () => {
    tempDir = createTempDir();
    configManager = new ConfigManager(tempDir);

    await configManager.init();
    await configManager.setGithubToken("first-token");

    // Initialize again - should not reset config
    await configManager.init();

    assert.strictEqual(configManager.getGithubToken(), "first-token");

    cleanupTempDir(tempDir);
  });

  await t.test("should use generic get method for all config keys", async () => {
    tempDir = createTempDir();
    configManager = new ConfigManager(tempDir);

    await configManager.init();
    await configManager.set("githubToken", "generic-token");
    await configManager.set("remoteUrl", "https://generic.com");
    await configManager.set("defaultProject", "generic/project");

    assert.strictEqual(configManager.get("githubToken"), "generic-token");
    assert.strictEqual(configManager.get("remoteUrl"), "https://generic.com");
    assert.strictEqual(configManager.get("defaultProject"), "generic/project");

    cleanupTempDir(tempDir);
  });

  await t.test("should only write non-undefined values to file", async () => {
    tempDir = createTempDir();
    configManager = new ConfigManager(tempDir);

    await configManager.init();
    await configManager.setGithubToken("only-token");

    // Read the raw file
    const fileContent = fs.readFileSync(
      path.join(tempDir, "config.json"),
      "utf-8"
    );
    const parsed = JSON.parse(fileContent);

    // Should only contain githubToken, not the undefined values
    assert.strictEqual(Object.keys(parsed).length, 1);
    assert.strictEqual(parsed.githubToken, "only-token");
    assert.ok(!("remoteUrl" in parsed));
    assert.ok(!("defaultProject" in parsed));

    cleanupTempDir(tempDir);
  });

  await t.test("should use default home directory when no custom dir provided", () => {
    const defaultManager = new ConfigManager();
    const expectedDir = path.join(os.homedir(), ".propr");
    const expectedPath = path.join(expectedDir, "config.json");

    assert.strictEqual(defaultManager.getConfigDir(), expectedDir);
    assert.strictEqual(defaultManager.getConfigFilePath(), expectedPath);
  });
});

test("DEFAULT_CONFIG export", async (t) => {
  await t.test("should have all keys undefined by default", () => {
    assert.strictEqual(DEFAULT_CONFIG.githubToken, undefined);
    assert.strictEqual(DEFAULT_CONFIG.remoteUrl, undefined);
    assert.strictEqual(DEFAULT_CONFIG.defaultProject, undefined);
  });
});
