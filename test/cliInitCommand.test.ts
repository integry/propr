import { describe, test } from "node:test";
import assert from "node:assert";
import fs from "fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { scaffoldProprDirectory } from "../packages/cli/src/commands/initCommands.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "propr-cli-init-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("scaffoldProprDirectory", () => {
  test("creates .propr scaffold files", async () => {
    await withTempDir(async (dir) => {
      const result = await scaffoldProprDirectory({ cwd: dir });
      const proprDir = path.join(dir, ".propr");

      assert.strictEqual(result.directory, proprDir);
      assert.deepStrictEqual(result.created.sort(), [
        ".gitignore",
        "README.md",
        "package.json",
        "setup.sh",
      ]);
      assert.deepStrictEqual(result.skipped, []);
      assert.deepStrictEqual(result.overwritten, []);

      assert.ok(fs.existsSync(path.join(proprDir, "setup.sh")));
      assert.ok(fs.existsSync(path.join(proprDir, "package.json")));
      assert.ok(fs.existsSync(path.join(proprDir, ".gitignore")));
      assert.ok(fs.existsSync(path.join(proprDir, "README.md")));

      const setup = await readFile(path.join(proprDir, "setup.sh"), "utf-8");
      assert.match(setup, /PROPR_WORKSPACE/);
      assert.match(setup, /PROPR_CACHE_DIR/);
      assert.match(setup, /npm ci/);
      assert.match(setup, /sudo apk add --no-cache/);

      const setupMode = (await stat(path.join(proprDir, "setup.sh"))).mode & 0o777;
      assert.strictEqual(setupMode, 0o755);
    });
  });

  test("does not overwrite existing files by default", async () => {
    await withTempDir(async (dir) => {
      await scaffoldProprDirectory({ cwd: dir });
      const setupPath = path.join(dir, ".propr", "setup.sh");
      await writeFile(setupPath, "# custom\n", "utf-8");

      const result = await scaffoldProprDirectory({ cwd: dir });
      const setup = await readFile(setupPath, "utf-8");

      assert.strictEqual(setup, "# custom\n");
      assert.ok(result.skipped.includes("setup.sh"));
      assert.deepStrictEqual(result.created, []);
      assert.deepStrictEqual(result.overwritten, []);
    });
  });

  test("overwrites existing files when force is set", async () => {
    await withTempDir(async (dir) => {
      await scaffoldProprDirectory({ cwd: dir });
      const setupPath = path.join(dir, ".propr", "setup.sh");
      await writeFile(setupPath, "# custom\n", "utf-8");

      const result = await scaffoldProprDirectory({ cwd: dir, force: true });
      const setup = await readFile(setupPath, "utf-8");

      assert.notStrictEqual(setup, "# custom\n");
      assert.ok(result.overwritten.includes("setup.sh"));
      assert.deepStrictEqual(result.created, []);
      assert.deepStrictEqual(result.skipped, []);
    });
  });
});
