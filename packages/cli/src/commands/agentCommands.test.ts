import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REDACTED_AGENT_ENV_VALUE } from "@propr/shared";
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

// Unmistakably synthetic sentinel; not a real credential.
const SENTINEL = "SENTINEL-NOT-A-REAL-SECRET-cli-3333";

// Simulates a backend that predates server-side redaction and returns raw values.
const agents = [{
  id: "vibe-agent-id",
  type: "vibe",
  alias: "vibe-primary",
  enabled: true,
  dockerImage: "propr/agent:test",
  configPath: "/tmp/vibe",
  supportedModels: ["devstral-2"],
  defaultModel: "devstral-2",
  envVars: { MISTRAL_API_KEY: SENTINEL },
}];

async function runAgentCommand(args: string[]): Promise<string> {
  const temporaryHome = await mkdtemp(join(tmpdir(), "propr-agent-command-"));
  const output: string[] = [];
  process.env.HOME = temporaryHome;
  console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
  console.error = (...values: unknown[]) => output.push(values.map(String).join(" "));
  globalThis.fetch = (async (_input, init) => {
    const method = init?.method ?? "GET";
    const posted = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const body = method === "GET" ? { agents } : { success: true, agents: posted.agents };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await createAgentCommand().parseAsync(args, { from: "user" });
    return output.join("\n");
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
}

test("agent list JSON shows env var names but never their values", async () => {
  const output = await runAgentCommand(["list", "--json"]);
  assert.equal(output.includes(SENTINEL), false);
  assert.deepEqual(JSON.parse(output).agents[0].envVars, { MISTRAL_API_KEY: REDACTED_AGENT_ENV_VALUE });
});

test("agent list text output never prints env var values", async () => {
  const output = await runAgentCommand(["list"]);
  assert.match(output, /vibe-primary/);
  assert.equal(output.includes(SENTINEL), false);
});

test("agent add JSON output never echoes existing env var values", async () => {
  const output = await runAgentCommand([
    "add", "codex-second", "-t", "codex", "-m", "gpt-5.6-sol", "--config-path", "/tmp/codex", "--json",
  ]);
  assert.equal(output.includes(SENTINEL), false);
  assert.deepEqual(JSON.parse(output).agents[0].envVars, { MISTRAL_API_KEY: REDACTED_AGENT_ENV_VALUE });
});
