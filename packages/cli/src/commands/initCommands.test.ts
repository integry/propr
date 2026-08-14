import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { InitCommandResult } from "./initCommands.js";
import type { InitStackResult } from "./initStack.js";

const entryPoint = fileURLToPath(new URL("../index.ts", import.meta.url));
const tsxLoader = createRequire(import.meta.url).resolve("tsx");

function runCli(args: string[], cwd: string, home: string): string {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoader, entryPoint, ...args],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, HOME: home, NODE_ENV: "test" },
    },
  );

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout;
}

test("init repo --json emits parseable JSON on first run and rerun", () => {
  const fixture = mkdtempSync(join(tmpdir(), "propr-init-repo-json-"));
  const repo = join(fixture, "repo");
  const home = join(fixture, "home");
  mkdirSync(repo);
  mkdirSync(home);

  try {
    const first = JSON.parse(runCli(["init", "repo", "--json"], repo, home)) as InitCommandResult;
    assert.deepEqual(first, {
      directory: join(repo, ".propr"),
      created: ["setup.sh", "package.json", ".gitignore", "README.md"],
      skipped: [],
      overwritten: [],
    });

    const rerun = JSON.parse(runCli(["init", "repo", "--json"], repo, home)) as InitCommandResult;
    assert.deepEqual(rerun, {
      directory: join(repo, ".propr"),
      created: [],
      skipped: ["setup.sh", "package.json", ".gitignore", "README.md"],
      overwritten: [],
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("init stack --json emits parseable JSON on first run and rerun", () => {
  const fixture = mkdtempSync(join(tmpdir(), "propr-init-stack-json-"));
  const stack = join(fixture, "stack");
  const home = join(fixture, "home");
  mkdirSync(home);

  try {
    const args = ["init", "stack", "--root", stack, "--json"];
    const first = JSON.parse(runCli(args, fixture, home)) as InitStackResult;
    assert.equal(first.rootDir, stack);
    assert.equal(first.envCreated, true);
    assert.equal(first.envSkipped, false);
    assert.deepEqual(first.dirsCreated, ["data", "logs", "repos"]);
    assert.deepEqual(first.dirsSkipped, []);

    const rerun = JSON.parse(runCli(args, fixture, home)) as InitStackResult;
    assert.equal(rerun.rootDir, stack);
    assert.equal(rerun.envCreated, false);
    assert.equal(rerun.envSkipped, true);
    assert.deepEqual(rerun.dirsCreated, []);
    assert.deepEqual(rerun.dirsSkipped, ["data", "logs", "repos"]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
