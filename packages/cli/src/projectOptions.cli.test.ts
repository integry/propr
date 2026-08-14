import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
  createConfigCommand,
  createIssueCommand,
  createPlanCommand,
  createTaskCommand,
  createTodoCommand,
} from "./commands/index.js";
import { ConfigManager } from "./config/index.js";

const entryPoint = fileURLToPath(new URL("./index.ts", import.meta.url));

function runCli(args: string[], home: string): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", entryPoint, ...args], {
      env: { ...process.env, HOME: home, NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function projectOptionPaths(command: Command, parents: string[] = []): string[] {
  const path = [...parents, command.name()].filter(Boolean);
  const ownPath = command.options.some((option) => option.long === "--project")
    ? [path.join(" ")]
    : [];
  return [
    ...ownPath,
    ...command.commands.flatMap((child) => projectOptionPaths(child, path)),
  ];
}

test("every advertised nested project option remains in the command surface audit", () => {
  const program = new Command();
  program.addCommand(createPlanCommand());
  program.addCommand(createTodoCommand());
  program.addCommand(createTaskCommand());
  program.addCommand(createIssueCommand());
  program.addCommand(createConfigCommand());

  assert.deepEqual(projectOptionPaths(program).sort(), [
    "config profile set",
    "issue implement",
    "plan create",
    "plan list",
    "task import",
    "task list",
    "todo add",
    "todo category add",
    "todo category list",
    "todo category move",
    "todo list",
    "todo move",
  ]);
});

test("CLI command paths send nested and global project values to the backend", async () => {
  const temporaryHome = await mkdtemp(join(tmpdir(), "propr-cli-project-options-"));
  const requests: URL[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    requests.push(url);
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/api/tasks") {
      response.end(JSON.stringify({ tasks: [], total: 0, limit: 50, offset: 0 }));
      return;
    }
    response.end(JSON.stringify({ drafts: [], total: 0, page: 1, limit: 20, hasMore: false }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const manager = new ConfigManager(join(temporaryHome, ".propr"));
    await manager.init();
    await manager.setRemoteUrl(`http://127.0.0.1:${address.port}`);
    await manager.setDefaultProject("configured/repo");

    const nestedPlan = await runCli(
      ["plan", "list", "-p", "nested/repo", "--json"],
      temporaryHome
    );
    assert.equal(nestedPlan.status, 0, nestedPlan.stderr);
    assert.equal(requests.at(-1)?.searchParams.get("repository"), "nested/repo");

    const globalPlan = await runCli(
      ["-p", "global/repo", "plan", "list", "--json"],
      temporaryHome
    );
    assert.equal(globalPlan.status, 0, globalPlan.stderr);
    assert.equal(requests.at(-1)?.searchParams.get("repository"), "global/repo");

    const nestedWins = await runCli(
      ["-p", "global/repo", "plan", "list", "-p", "nested/repo", "--json"],
      temporaryHome
    );
    assert.equal(nestedWins.status, 0, nestedWins.stderr);
    assert.equal(requests.at(-1)?.searchParams.get("repository"), "nested/repo");

    const taskFilter = await runCli(
      ["task", "list", "-p", " does-not-exist/nope ", "--limit", "1", "--json"],
      temporaryHome
    );
    assert.equal(taskFilter.status, 0, taskFilter.stderr);
    assert.equal(requests.at(-1)?.pathname, "/api/tasks");
    assert.equal(requests.at(-1)?.searchParams.get("repository"), "does-not-exist/nope");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

test("invalid project flags fail before an API request", async () => {
  const temporaryHome = await mkdtemp(join(tmpdir(), "propr-cli-invalid-project-"));
  try {
    const result = await runCli(
      ["task", "list", "-p", "not-a-project", "--json"],
      temporaryHome
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid project/);
    assert.doesNotMatch(result.stderr, /fetch failed|ECONNREFUSED/);
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
});
