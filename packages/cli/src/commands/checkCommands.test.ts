import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import type { OrchestratorConfig, OrchestratorModule } from "../orchestrator/index.js";
import type { AgentTankUsage, AgentValidationRow } from "./agentValidation.js";
import {
  configurationErrorCheck,
  createCheckCommand,
  printAgentTankUsage,
  type AgentValidationFlowDependencies,
} from "./checkCommands.js";

test("propr check presents VAPID validation as a clear failure without key material", () => {
  const detail = "Web Push VAPID configuration is incomplete: set all three variables together.";

  assert.deepEqual(configurationErrorCheck(detail), {
    name: "Web Push VAPID",
    status: "fail",
    detail,
    group: "Configuration",
  });
});

function usageFixture(): unknown {
  return JSON.parse(
    readFileSync(new URL("./fixtures/agent-tank-null-label.json", import.meta.url), "utf8")
  ) as unknown;
}

function captureLogs(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  return lines;
}

test("Agent Tank usage rendering omits invalid entries and falls back for a null label", (t) => {
  const fixture = usageFixture() as Record<string, { usage: Record<string, unknown> }>;
  fixture.codex.usage.unexpectedUndefined = undefined;
  const lines = captureLogs(t);

  assert.doesNotThrow(() => {
    printAgentTankUsage({ installed: true, version: "0.9.10", usage: fixture }, false);
  });

  const output = lines.join("\n");
  assert.match(output, /claude\s+Claude usage unavailable/);
  assert.match(output, /codex\s+usage: 12% \(resets 3d 4h\)/);
  assert.doesNotMatch(output, /usage: \?%/);
  assert.doesNotMatch(output, /fiveHour|unexpected/);
  assert.ok(output.indexOf("claude") < output.indexOf("codex"), "agent rows should be sorted");
});

test("Agent Tank usage rendering preserves top-level errors", (t) => {
  const lines = captureLogs(t);

  printAgentTankUsage({
    installed: true,
    version: "0.9.10",
    usage: usageFixture(),
    error: "Agent Tank upstream failed",
  }, false);

  const output = lines.join("\n");
  assert.match(output, /could not read usage: Agent Tank upstream failed/);
  assert.doesNotMatch(output, /usage: 12%/);
});

test("check agents prints completed rows and exits only for validation failures", async (t) => {
  const lines = captureLogs(t);
  const exitCodes: Array<number | string | null | undefined> = [];
  t.mock.method(process, "exit", ((code?: number | string | null) => {
    exitCodes.push(code);
    return undefined as never;
  }) as typeof process.exit);

  const rows: AgentValidationRow[] = [
    {
      type: "claude",
      hostVersion: "2.1.220",
      imageVersion: "2.1.220",
      host: { status: "ok", detail: "Claude host completed" },
      image: { status: "ok", detail: "Claude image completed" },
    },
    {
      type: "opencode",
      hostVersion: "1.2.3",
      imageVersion: "1.2.4",
      drift: "newer",
      host: { status: "fail", detail: "OpenCode host validation failed" },
      image: { status: "ok", detail: "OpenCode image completed" },
    },
  ];
  const dependencies: AgentValidationFlowDependencies = {
    loadHostConfig: async () => ({
      orch: {} as OrchestratorModule,
      cfg: {} as OrchestratorConfig,
    }),
    validateAgents: async () => rows,
    getAgentTankUsage: async (): Promise<AgentTankUsage> => ({
      installed: true,
      version: "0.9.10",
      usage: usageFixture(),
    }),
    isInteractiveTerminal: () => false,
  };

  await createCheckCommand(dependencies).parseAsync(["agents"], { from: "user" });

  const output = lines.join("\n");
  assert.match(output, /Claude host completed/);
  assert.match(output, /Claude image completed/);
  assert.match(output, /OpenCode host validation failed/);
  assert.match(output, /OpenCode image completed/);
  assert.match(output, /Claude usage unavailable/);
  assert.match(output, /usage: 12% \(resets 3d 4h\)/);
  assert.deepEqual(exitCodes, [1]);

  rows[1].host = { status: "ok", detail: "OpenCode host completed" };
  await createCheckCommand(dependencies).parseAsync(["agents"], { from: "user" });
  assert.deepEqual(exitCodes, [1], "malformed subscription usage must not add an exit failure");
});
