import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Command } from "commander";
import { createPlanCommand } from "./planCommands.js";
import { createRepoCommand } from "./repoCommands.js";
import { createSettingCommand } from "./settingCommands.js";
import { createRemoteStatusCommand } from "./systemCommands.js";
import { createTaskCommand } from "./taskCommands.js";
import { createTodoCommand } from "./todoCommands.js";
import { LOGIN_REQUIRED_ERROR } from "../utils/apiErrorPresentation.js";

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const originalConsoleLog = console.log;
const originalProcessExit = process.exit;

class CommandExit extends Error {
  constructor(public readonly code: number) {
    super(`command exited with ${code}`);
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  console.log = originalConsoleLog;
  process.exit = originalProcessExit;
});

async function runApiErrorCommand(
  command: Command,
  args: string[],
  responseMessage = "Unauthorized",
  status = 401
): Promise<{ exitCode: number | undefined; stderr: string[] }> {
  const stderr: string[] = [];
  let exitCode: number | undefined;

  globalThis.fetch = (() => Promise.resolve(new Response(
    JSON.stringify({ error: responseMessage }),
    { status, headers: { "content-type": "application/json" } }
  ))) as typeof fetch;
  console.error = (...values: unknown[]) => {
    stderr.push(values.map(String).join(" "));
  };
  console.log = () => undefined;
  process.exit = ((code?: string | number | null) => {
    exitCode = typeof code === "number" ? code : Number(code ?? 0);
    throw new CommandExit(exitCode);
  }) as typeof process.exit;

  await assert.rejects(
    command.parseAsync(args, { from: "user" }),
    (error: Error) => error instanceof CommandExit && error.code === 1
  );

  return { exitCode, stderr };
}

test("repo add emits exact actionable login guidance and exits non-zero", async () => {
  const result = await runApiErrorCommand(
    createRepoCommand(),
    ["add", "integry/propr"]
  );

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.stderr, [LOGIN_REQUIRED_ERROR]);
});

test("repo list read command uses centralized login guidance", async () => {
  const result = await runApiErrorCommand(createRepoCommand(), ["list"]);

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.stderr, [LOGIN_REQUIRED_ERROR]);
});

test("task stop write command uses centralized login guidance", async () => {
  const result = await runApiErrorCommand(
    createTaskCommand(),
    ["stop", "task-123"]
  );

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.stderr, [LOGIN_REQUIRED_ERROR]);
});

test("typed 401 classification precedes misleading command-specific messages", async () => {
  const commands: Array<[Command, string[], string]> = [
    [createPlanCommand(), ["get", "plan-123"], "Authentication token not found"],
    [createTaskCommand(), ["get", "task-123"], "Authentication token not found"],
    [createTodoCommand(), ["get", "todo-123"], "Authentication token not found"],
    [createRepoCommand(), ["remove", "integry/propr"], "Repository not being monitored"],
    [createSettingCommand(), ["update", "analysis_model_fast", "model"], "409"],
    [createRemoteStatusCommand(), [], "Network request failed"],
  ];

  for (const [command, args, responseMessage] of commands) {
    const result = await runApiErrorCommand(command, args, responseMessage);
    assert.deepEqual(result.stderr, [LOGIN_REQUIRED_ERROR], responseMessage);
  }
});

test("typed 403 classification precedes a misleading not-found message", async () => {
  const result = await runApiErrorCommand(
    createPlanCommand(),
    ["get", "plan-123"],
    "Authentication token not found",
    403
  );

  assert.deepEqual(result.stderr, [
    "Error: Access denied. You do not have permission to view this plan.",
  ]);
});

test("typed non-auth status precedes conflicting legacy status text", async () => {
  const result = await runApiErrorCommand(
    createTaskCommand(),
    ["stop", "task-123"],
    "404 not found",
    400
  );

  assert.deepEqual(result.stderr, [
    "Error: Task cannot be stopped in its current state.",
  ]);
});
