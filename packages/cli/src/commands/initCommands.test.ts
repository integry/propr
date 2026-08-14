import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { InitCommandResult } from "./initCommands.js";
import type { InitStackResult } from "./initStack.js";

const entryPoint = fileURLToPath(new URL("../index.ts", import.meta.url));
const tsxLoader = createRequire(import.meta.url).resolve("tsx");
const repoScaffoldFiles = ["setup.sh", "package.json", ".gitignore", "README.md"];

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

for (const json of [false, true]) {
  test(`init repo --force${json ? " --json" : ""} overwrites only scaffold files`, () => {
    const fixture = mkdtempSync(join(tmpdir(), "propr-init-repo-force-"));
    const repo = join(fixture, "repo");
    const proprDir = join(repo, ".propr");
    const home = join(fixture, "home");
    const sentinelPath = join(proprDir, "sentinel.txt");
    const sentinel = "unrelated file must be preserved\n";
    mkdirSync(proprDir, { recursive: true });
    mkdirSync(home);

    for (const file of repoScaffoldFiles) {
      writeFileSync(join(proprDir, file), `modified ${file}\n`);
    }
    writeFileSync(sentinelPath, sentinel);

    try {
      const stdout = runCli(
        ["init", "repo", "--force", ...(json ? ["--json"] : [])],
        repo,
        home,
      );

      if (json) {
        const result = JSON.parse(stdout) as InitCommandResult;
        assert.deepEqual(result, {
          directory: proprDir,
          created: [],
          skipped: [],
          overwritten: repoScaffoldFiles,
        });
      } else {
        assert.match(stdout, /Overwritten: setup\.sh, package\.json, \.gitignore, README\.md/);
      }

      for (const file of repoScaffoldFiles) {
        assert.doesNotMatch(readFileSync(join(proprDir, file), "utf8"), /^modified /);
      }
      assert.equal(readFileSync(sentinelPath, "utf8"), sentinel);
      assert.deepEqual(readdirSync(proprDir).sort(), [...repoScaffoldFiles, "sentinel.txt"].sort());
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}

for (const json of [false, true]) {
  test(`init stack --force${json ? " --json" : ""} backs up only the selected root`, () => {
    const fixture = mkdtempSync(join(tmpdir(), "propr-init-stack-force-"));
    const caller = join(fixture, "caller");
    const stack = join(fixture, "selected-stack");
    const home = join(fixture, "home");
    const oldEnv = "SESSION_SECRET=existing-stack-secret\nSELECTED_ROOT_MARKER=keep-in-backup\n";
    const callerEnv = "SESSION_SECRET=unselected-root-secret\n";
    mkdirSync(caller);
    mkdirSync(stack);
    mkdirSync(home);
    writeFileSync(join(stack, ".env"), oldEnv);
    writeFileSync(join(caller, ".env"), callerEnv);

    try {
      const stdout = runCli(
        ["init", "stack", "--root", stack, "--force", ...(json ? ["--json"] : [])],
        caller,
        home,
      );
      const newEnv = readFileSync(join(stack, ".env"), "utf8");
      const newSecret = newEnv.match(/^SESSION_SECRET=(.+)$/m)?.[1];

      assert.equal(readFileSync(join(stack, ".env.bak"), "utf8"), oldEnv);
      assert.doesNotMatch(newEnv, /SELECTED_ROOT_MARKER|existing-stack-secret/);
      assert.ok(newSecret);
      assert.equal(readFileSync(join(caller, ".env"), "utf8"), callerEnv);
      assert.equal(existsSync(join(caller, ".env.bak")), false);

      if (json) {
        const result = JSON.parse(stdout) as InitStackResult;
        assert.equal(result.rootDir, stack);
        assert.equal(result.envCreated, true);
        assert.equal(result.envSkipped, false);
        assert.equal(result.envBackedUp, true);
        assert.deepEqual(result.dirsCreated, ["data", "logs", "repos"]);
        assert.deepEqual(result.dirsSkipped, []);
        assert.doesNotMatch(stdout, /existing-stack-secret|unselected-root-secret/);
        assert.equal(stdout.includes(newSecret), false);
      } else {
        assert.match(stdout, /Overwrote \.env from \.env\.example \(previous saved to \.env\.bak\)/);
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}
