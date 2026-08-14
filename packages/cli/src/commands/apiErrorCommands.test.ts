import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Command } from "commander";
import { createRepoCommand } from "./repoCommands.js";
import { createTaskCommand } from "./taskCommands.js";
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

async function runUnauthorizedCommand(
  command: Command,
  args: string[]
): Promise<{ exitCode: number | undefined; stderr: string[] }> {
  const stderr: string[] = [];
  let exitCode: number | undefined;

  globalThis.fetch = (() => Promise.resolve(new Response(
    JSON.stringify({ error: "Unauthorized" }),
    { status: 401, headers: { "content-type": "application/json" } }
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
  const result = await runUnauthorizedCommand(
    createRepoCommand(),
    ["add", "integry/propr"]
  );

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.stderr, [LOGIN_REQUIRED_ERROR]);
});

test("repo list read command uses centralized login guidance", async () => {
  const result = await runUnauthorizedCommand(createRepoCommand(), ["list"]);

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.stderr, [LOGIN_REQUIRED_ERROR]);
});

test("task stop write command uses centralized login guidance", async () => {
  const result = await runUnauthorizedCommand(
    createTaskCommand(),
    ["stop", "task-123"]
  );

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.stderr, [LOGIN_REQUIRED_ERROR]);
});
