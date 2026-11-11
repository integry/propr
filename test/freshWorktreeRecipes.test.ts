import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { scaffoldProprDirectory } from "../packages/cli/src/commands/initCommands.js";
import { parseRepositoryWorkflow } from "../packages/core/src/workflow/repositoryWorkflow.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowDoc = path.join(repoRoot, "docs", "docs", "features", "repository-workflow.md");

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "propr-fresh-worktree-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Stub commands record their working directory, connection settings and args.
async function writeStubs(binDir: string, logFile: string, names: string[]): Promise<void> {
  await mkdir(binDir, { recursive: true });
  for (const name of names) {
    const stub = path.join(binDir, name);
    await writeFile(
      stub,
      `#!/usr/bin/env bash\necho "${name} cwd=$PWD host=\${PGHOST-} port=\${PGPORT-} user=\${PGUSER-} args=$*" >>"${logFile}"\n`,
    );
    await chmod(stub, 0o755);
  }
}

function hookEnv(workspace: string, cacheDir: string, binDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("PG")) env[key] = value;
  }
  return {
    ...env,
    PATH: `${binDir}:${process.env.PATH}`,
    PROPR_WORKSPACE: workspace,
    PROPR_CACHE_DIR: cacheDir,
    PROPR_AGENT_TYPE: "claude",
  };
}

function uncommentExamples(setup: string): string {
  const lines = setup.split("\n");
  let inExample = false;
  return lines
    .map((line) => {
      if (/^# (Create local env files|Regenerate ignored code)/.test(line)) {
        inExample = true;
        return line;
      }
      if (line.trim() === "") inExample = false;
      return inExample ? line.replace(/^# /, "") : line;
    })
    .join("\n");
}

test("scaffolded setup.sh runs the enabled env and codegen examples in the repository root", async () => {
  await withTempDir(async (dir) => {
    const workspace = path.join(dir, "repo");
    const cacheDir = path.join(dir, "cache");
    const binDir = path.join(dir, "bin");
    const logFile = path.join(dir, "calls.log");
    await mkdir(workspace);
    await mkdir(cacheDir);
    await writeStubs(binDir, logFile, ["npm"]);
    await scaffoldProprDirectory({ cwd: workspace });
    await writeFile(path.join(workspace, ".env.example"), "ROOT_EXAMPLE=1\n");

    const setupPath = path.join(workspace, ".propr", "setup.sh");
    const enabled = uncommentExamples(await readFile(setupPath, "utf-8"));
    assert.match(enabled, /^ {2}cp \.env\.example \.env$/m);
    assert.match(enabled, /^npm run codegen --if-present$/m);
    await writeFile(setupPath, enabled);

    execFileSync("bash", [setupPath], { env: hookEnv(workspace, cacheDir, binDir), stdio: "pipe" });

    assert.strictEqual(await readFile(path.join(workspace, ".env"), "utf-8"), "ROOT_EXAMPLE=1\n");
    const calls = (await readFile(logFile, "utf-8")).trim().split("\n");
    assert.deepStrictEqual(calls, [
      `npm cwd=${path.join(workspace, ".propr")} host= port= user= args=install`,
      `npm cwd=${workspace} host= port= user= args=ci`,
      `npm cwd=${workspace} host= port= user= args=run codegen --if-present`,
    ]);
  });
});

test("docs database recipe creates, configures and drops the database on one server", async () => {
  const doc = await readFile(workflowDoc, "utf-8");
  const setupSnippet = [...doc.matchAll(/```bash\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .find((block) => block.includes("createdb"));
  assert.ok(setupSnippet, "database recipe found");
  const cleanupYaml = [...doc.matchAll(/```yaml\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .find((block) => block.includes("dropdb"));
  assert.ok(cleanupYaml, "cleanup recipe found");
  const beforeRemove = parseRepositoryWorkflow(cleanupYaml).hooks?.before_remove;
  assert.ok(beforeRemove, "cleanup recipe has before_remove");

  await withTempDir(async (dir) => {
    const workspace = path.join(dir, "repo");
    const cacheDir = path.join(dir, "cache");
    const binDir = path.join(dir, "bin");
    const logFile = path.join(dir, "calls.log");
    await mkdir(workspace);
    await mkdir(cacheDir);
    await writeStubs(binDir, logFile, ["createdb", "dropdb", "docker"]);
    const env = hookEnv(workspace, cacheDir, binDir);

    execFileSync("bash", ["-c", `set -euo pipefail\ncd "$PROPR_WORKSPACE"\n${setupSnippet}`], {
      env,
      stdio: "pipe",
    });
    execFileSync("bash", ["-c", beforeRemove], { cwd: workspace, env, stdio: "pipe" });

    const runId = (await readFile(path.join(cacheDir, "run-id"), "utf-8")).trim();
    const db = `app_test_${runId}`;
    const connection = "host=db.internal.example.com port=5432 user=app";
    const calls = (await readFile(logFile, "utf-8")).trim().split("\n");
    assert.strictEqual(calls[0], `createdb cwd=${workspace} ${connection} args=${db}`);
    assert.strictEqual(calls[1], `dropdb cwd=${workspace} ${connection} args=--if-exists ${db}`);
    const dotenv = await readFile(path.join(workspace, ".env"), "utf-8");
    assert.match(dotenv, new RegExp(`^DATABASE_URL=postgres://app@db\\.internal\\.example\\.com:5432/${db}$`, "m"));
  });
});
