import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentCommand } from "./agentCommands.js";

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalHome = process.env.HOME;
const originalExitCode = process.exitCode;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  process.exitCode = originalExitCode;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

const document = {
  synthetic_agents: [{
    id: "11111111-1111-4111-8111-111111111111",
    alias: "balanced-pool",
    enabled: true,
    defaultModel: "balanced",
    models: [{
      id: "balanced",
      enabled: true,
      strategy: "round_robin",
      members: [{
        id: "22222222-2222-4222-8222-222222222222",
        directAgentAlias: "codex-a",
        model: "gpt-5.6-sol",
        enabled: true,
        priority: 100,
      }],
    }],
  }],
};

test("pool list JSON can be passed unchanged to pool apply", async () => {
  const temporaryHome = await mkdtemp(join(tmpdir(), "propr-pool-command-"));
  const file = join(temporaryHome, "pools.json");
  const stdout: string[] = [];
  const requests: Array<{ method: string; body?: unknown }> = [];
  process.env.HOME = temporaryHome;
  console.log = (...values: unknown[]) => stdout.push(values.map(String).join(" "));
  console.error = () => undefined;
  globalThis.fetch = (async (_input, init) => {
    const method = init?.method ?? "GET";
    requests.push({
      method,
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    });
    const body = method === "GET" ? document : { success: true, ...document };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await createAgentCommand().parseAsync(["pool", "list", "--json"], { from: "user" });
    assert.equal(stdout.length, 1);
    assert.deepEqual(JSON.parse(stdout[0]), document);
    await writeFile(file, stdout[0], "utf8");

    stdout.length = 0;
    await createAgentCommand().parseAsync(["pool", "apply", file, "--json"], { from: "user" });

    assert.deepEqual(requests, [
      { method: "GET" },
      { method: "POST", body: document },
    ]);
    assert.deepEqual(JSON.parse(stdout[0]), { success: true, ...document });
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

test("pool apply preserves backend nested validation messages", async () => {
  const temporaryHome = await mkdtemp(join(tmpdir(), "propr-pool-error-"));
  const file = join(temporaryHome, "pools.json");
  const stderr: string[] = [];
  process.env.HOME = temporaryHome;
  await writeFile(file, JSON.stringify(document), "utf8");
  console.log = () => undefined;
  console.error = (...values: unknown[]) => stderr.push(values.map(String).join(" "));
  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: "synthetic_agents.0.models.0.members.0.priority: Number must be greater than or equal to 0",
  }), { status: 400, headers: { "content-type": "application/json" } })) as typeof fetch;

  try {
    await createAgentCommand().parseAsync(["pool", "apply", file], { from: "user" });
    assert.match(stderr.join("\n"), /synthetic_agents\.0\.models\.0\.members\.0\.priority: Number must be greater than or equal to 0/);
    assert.equal(process.exitCode, 1);
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
});
