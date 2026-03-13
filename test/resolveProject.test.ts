import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ConfigManager,
  resolveProject,
  ProjectResolutionError,
} from "@propr/cli";

/**
 * Test suite for resolveProject utility function.
 *
 * Tests cover:
 * - Resolving project from command options
 * - Falling back to default project from config
 * - Throwing helpful error when no project is available
 * - Prioritizing flag over config
 */

// Helper to create a unique temp directory for each test
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "propr-cli-resolve-test-"));
}

// Helper to clean up temp directory
function cleanupTempDir(tempDir: string): void {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

test("resolveProject", async (t) => {
  let tempDir: string;
  let configManager: ConfigManager;

  beforeEach(async () => {
    tempDir = createTempDir();
    configManager = new ConfigManager(tempDir);
    await configManager.init();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  await t.test("should return project from options when provided", async () => {
    tempDir = createTempDir();
    configManager = new ConfigManager(tempDir);
    await configManager.init();

    const result = resolveProject({ project: "owner/repo" }, configManager);

    assert.strictEqual(result, "owner/repo");

    cleanupTempDir(tempDir);
  });

  await t.test("should return default project from config when no flag provided", async () => {
    tempDir = createTempDir();
    configManager = new ConfigManager(tempDir);
    await configManager.init();
    await configManager.setDefaultProject("default/project");

    const result = resolveProject({}, configManager);

    assert.strictEqual(result, "default/project");

    cleanupTempDir(tempDir);
  });

  await t.test("should prioritize flag over default project", async () => {
    tempDir = createTempDir();
    configManager = new ConfigManager(tempDir);
    await configManager.init();
    await configManager.setDefaultProject("default/project");

    const result = resolveProject({ project: "flag/project" }, configManager);

    assert.strictEqual(result, "flag/project");

    cleanupTempDir(tempDir);
  });

  await t.test("should throw ProjectResolutionError when no project available", async () => {
    tempDir = createTempDir();
    configManager = new ConfigManager(tempDir);
    await configManager.init();

    assert.throws(
      () => resolveProject({}, configManager),
      ProjectResolutionError
    );

    cleanupTempDir(tempDir);
  });

  await t.test("should provide helpful error message", async () => {
    tempDir = createTempDir();
    configManager = new ConfigManager(tempDir);
    await configManager.init();

    try {
      resolveProject({}, configManager);
      assert.fail("Expected ProjectResolutionError to be thrown");
    } catch (error) {
      assert.ok(error instanceof ProjectResolutionError);
      assert.ok(error.message.includes("-p/--project"));
      assert.ok(error.message.includes("propr use"));
    }

    cleanupTempDir(tempDir);
  });

  await t.test("should handle undefined project in options", async () => {
    tempDir = createTempDir();
    configManager = new ConfigManager(tempDir);
    await configManager.init();
    await configManager.setDefaultProject("fallback/project");

    const result = resolveProject({ project: undefined }, configManager);

    assert.strictEqual(result, "fallback/project");

    cleanupTempDir(tempDir);
  });

  await t.test("should handle empty string project in options by treating it as falsy", async () => {
    tempDir = createTempDir();
    configManager = new ConfigManager(tempDir);
    await configManager.init();
    await configManager.setDefaultProject("fallback/project");

    // Empty string is falsy, so should fall back to default
    const result = resolveProject({ project: "" }, configManager);

    assert.strictEqual(result, "fallback/project");

    cleanupTempDir(tempDir);
  });
});

test("ProjectResolutionError", async (t) => {
  await t.test("should have correct error name", () => {
    const error = new ProjectResolutionError("test message");

    assert.strictEqual(error.name, "ProjectResolutionError");
  });

  await t.test("should be an instance of Error", () => {
    const error = new ProjectResolutionError("test message");

    assert.ok(error instanceof Error);
  });

  await t.test("should preserve the error message", () => {
    const error = new ProjectResolutionError("custom message");

    assert.strictEqual(error.message, "custom message");
  });
});
