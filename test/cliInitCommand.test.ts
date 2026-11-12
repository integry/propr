import { describe, test } from "node:test";
import assert from "node:assert";
import fs from "fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { scaffoldProprDirectory } from "../packages/cli/src/commands/initCommands.js";
import { parseRepositoryWorkflow } from "../packages/core/src/workflow/repositoryWorkflow.js";

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
        "pr-template.md",
        "setup.sh",
        "workflow.yml",
      ]);
      assert.deepStrictEqual(result.skipped, []);
      assert.deepStrictEqual(result.overwritten, []);

      assert.ok(fs.existsSync(path.join(proprDir, "workflow.yml")));
      assert.ok(fs.existsSync(path.join(proprDir, "pr-template.md")));
      assert.ok(fs.existsSync(path.join(proprDir, "setup.sh")));
      assert.ok(fs.existsSync(path.join(proprDir, "package.json")));
      assert.ok(fs.existsSync(path.join(proprDir, ".gitignore")));
      assert.ok(fs.existsSync(path.join(proprDir, "README.md")));

      const setup = await readFile(path.join(proprDir, "setup.sh"), "utf-8");
      assert.match(setup, /PROPR_WORKSPACE/);
      assert.match(setup, /PROPR_CACHE_DIR/);
      assert.match(setup, /npm ci/);
      assert.match(setup, /propr runtime packages/);
      assert.doesNotMatch(setup, /sudo apt-get/);
      assert.match(setup, /cp \.env\.example \.env/);
      assert.match(setup, /npm run codegen --if-present/);

      const workflow = await readFile(path.join(proprDir, "workflow.yml"), "utf-8");
      assert.deepStrictEqual(parseRepositoryWorkflow(workflow), { hooks: { timeout_ms: 600000 } });
      // Uncommenting the inline after_create example yields a valid policy.
      const inline = workflow.match(/^  # after_create: \|\n((?:  # {3}.*\n)+)/m);
      assert.ok(inline, "workflow.yml has an inline after_create example");
      const enabled = workflow.replace(
        inline[0],
        `  after_create: |\n${inline[1].replace(/^  # {3}/gm, "    ")}`,
      );
      assert.deepStrictEqual(parseRepositoryWorkflow(enabled).hooks, {
        after_create: "set -euo pipefail\n[ -f .env ] || cp .env.example .env\nnpm ci\nnpm run codegen --if-present\n",
        timeout_ms: 600000,
      });

      const setupMode = (await stat(path.join(proprDir, "setup.sh"))).mode & 0o777;
      assert.strictEqual(setupMode, 0o755);
    });
  });

  test("workflow scaffold documents on_blocker commented out, and uncommenting it is valid", async () => {
    await withTempDir(async (dir) => {
      await scaffoldProprDirectory({ cwd: dir });
      const workflow = await readFile(path.join(dir, ".propr", "workflow.yml"), "utf-8");
      assert.match(workflow, /^# on_blocker: report$/m);
      // Commented out, the scaffold keeps today's behaviour.
      assert.strictEqual(parseRepositoryWorkflow(workflow).on_blocker, undefined);
      const enabled = workflow.replace(/^# on_blocker: report$/m, "on_blocker: report");
      assert.strictEqual(parseRepositoryWorkflow(enabled).on_blocker, "report");
    });
  });

  test("workflow scaffold documents review.risk_paths commented out, and uncommenting it is valid", async () => {
    await withTempDir(async (dir) => {
      await scaffoldProprDirectory({ cwd: dir });
      const workflow = await readFile(path.join(dir, ".propr", "workflow.yml"), "utf-8");
      assert.match(workflow, /^# review:\n#   risk_paths:\n#     - "src\/billing\/\*\*"$/m);
      assert.strictEqual(parseRepositoryWorkflow(workflow).review, undefined);
      const enabled = workflow.replace(/^# (review:|  risk_paths:|    - "src\/billing)/gm, "$1");
      assert.deepStrictEqual(parseRepositoryWorkflow(enabled).review, { risk_paths: ["src/billing/**"] });
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
