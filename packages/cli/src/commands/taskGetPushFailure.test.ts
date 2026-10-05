import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createTaskCommand } from "./taskCommands.js";

const originalFetch = globalThis.fetch;
const originalConsoleLog = console.log;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalConsoleLog;
});

const unblockUrl = "https://github.com/integry/propr/security/secret-scanning/unblock-secret/2Mf8bjCnMb7BJFkLxmEB";

const history = {
  taskId: "task-1",
  taskInfo: { repoOwner: "integry", repoName: "propr", number: 2736, type: "issue", title: "Salvage pushes" },
  history: [
    { state: "processing", timestamp: "2026-10-05T23:30:00.000Z" },
    {
      state: "failed",
      timestamp: "2026-10-05T23:40:00.000Z",
      reason: "Task failed: Push of branch 2736/fix was rejected (push_protection)",
      metadata: {
        pushFailure: {
          diagnosis: { classification: "push_protection", summary: "Push protection blocked the push.", unblockUrls: [unblockUrl] },
          rung: "rescue_ref",
          branchName: "2736/fix",
          repository: "integry/propr",
          rescueRef: "refs/propr/rescue/task-1",
          recoveryInstruction: "The commits were pushed to `refs/propr/rescue/task-1` on integry/propr.",
          attempts: [],
        },
      },
    },
  ],
};

async function runGet(args: string[]): Promise<string> {
  const stdout: string[] = [];
  globalThis.fetch = (async () => new Response(JSON.stringify(history), {
    status: 200, headers: { "content-type": "application/json" },
  })) as typeof fetch;
  console.log = (...values: unknown[]) => { stdout.push(values.map(String).join(" ")); };
  await createTaskCommand().parseAsync(["get", "task-1", ...args], { from: "user" });
  return stdout.join("\n");
}

test("task get shows the push rejection class, unblock URL and rescue location", async () => {
  const output = await runGet([]);
  assert.match(output, /Push Rejection:/);
  assert.match(output, /Class:\s+push_protection/);
  assert.ok(output.includes(`Unblock URL:  ${unblockUrl}`));
  assert.match(output, /Rescue ref:\s+refs\/propr\/rescue\/task-1/);
});

test("task get --json includes the push failure", async () => {
  const output = JSON.parse(await runGet(["--json"]));
  assert.equal(output.pushFailure.diagnosis.classification, "push_protection");
  assert.deepEqual(output.pushFailure.diagnosis.unblockUrls, [unblockUrl]);
});
