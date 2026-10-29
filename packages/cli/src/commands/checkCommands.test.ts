import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { OrchestratorConfig, OrchestratorModule } from "../orchestrator/index.js";
import type { AgentTankUsage, AgentValidationRow } from "./agentValidation.js";
import {
  claudeConfigCheck,
  configurationErrorCheck,
  createCheckCommand,
  isDockerInfoTemplateError,
  isLiveRendererFallbackError,
  printAgentTankUsage,
  summarizeDockerFailure,
  type AgentValidationFlowDependencies,
} from "./checkCommands.js";

test("Docker daemon failure detail is one bounded line without the home path", () => {
  const home = "/Users/jane";
  const stderr = `\nfailed to connect to the docker API at unix://${home}/.docker/run/docker.sock; check if the path is correct and if the daemon is running\nsecond line with ${home}/more\n`;
  const detail = summarizeDockerFailure(stderr, home);
  assert.equal(detail, ": failed to connect to the docker API at unix://~/.docker/run/docker.sock; check if the path is correct and if the daemon is running");
  assert.ok(!detail.includes(home));
  assert.ok(!detail.includes("second line"));
  assert.equal(summarizeDockerFailure("", home), "");
  assert.equal(summarizeDockerFailure(undefined, home), "");
  assert.equal(summarizeDockerFailure("   \n\t\n", home), "");
  const long = summarizeDockerFailure(`x${"y".repeat(400)}`, home);
  assert.equal(long.length, ": ".length + 200);
  assert.ok(long.endsWith("…"));
  assert.equal(summarizeDockerFailure("a\u001b[31mb\u001b[0m", "/"), ": a [31mb [0m");
});

test("Docker info template errors are distinguished from an unreachable daemon", () => {
  for (const text of [
    'Error: template: info:1:2: executing "info" at <.OSType>: can\'t evaluate field OSType in type *define.Info',
    "template: :1:2: executing \"\" at <.OSType>: can't evaluate field OSType in type entities.Info",
    "Error: cannot evaluate field OSType",
  ]) assert.equal(isDockerInfoTemplateError(text), true, text);
  for (const text of [
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    "failed to connect to the docker API at unix:///Users/jane/.docker/run/docker.sock",
    "permission denied while trying to connect to the Docker daemon socket",
    "",
    undefined,
  ]) assert.equal(isDockerInfoTemplateError(text), false, String(text));
});

test("propr check presents VAPID validation as a clear failure without key material", () => {
  const detail = "Web Push VAPID configuration is incomplete: set both key variables together, or remove both for automatic setup.";

  assert.deepEqual(configurationErrorCheck(detail), {
    name: "Web Push VAPID",
    status: "fail",
    detail,
    group: "Configuration",
  });
});

test("live renderer fallback recognizes the existing terminal error messages", () => {
  const matching = [
    new Error("Raw mode is unavailable"),
    new Error("setRawMode is not a function"),
    new Error("stdin cannot access this TTY"),
    new Error("input is not a tty"),
    new Error("Ink renderer failed"),
    "STDIN is unavailable on the current TTY",
  ];

  for (const error of matching) assert.equal(isLiveRendererFallbackError(error), true, String(error));
});

test("live renderer fallback rejects unrelated and cross-line stdin/tty messages", () => {
  const nonMatching = [
    new Error("renderer failed unexpectedly"),
    new Error("tty was checked before stdin"),
    new Error("stdin is unavailable\ntty is available"),
    new Error(`stdin${" unavailable".repeat(10_000)}`),
  ];

  for (const error of nonMatching) assert.equal(isLiveRendererFallbackError(error), false, String(error));
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

test("propr check reports whether the Claude config file is present and mounted", () => {
  const home = mkdtempSync(join(tmpdir(), "propr-check-claude-"));
  const claudeDir = join(home, ".claude");
  const claudeJson = join(home, ".claude.json");

  assert.equal(claudeConfigCheck({}), undefined, "no row when Claude is not configured");

  const missing = claudeConfigCheck({ hostClaudeDir: claudeDir });
  assert.equal(missing?.status, "warn");
  assert.match(missing?.detail ?? "", new RegExp(`${claudeJson} not found — not mounted`));
  assert.match(missing?.fix ?? "", /HOST_CLAUDE_JSON/);

  writeFileSync(claudeJson, "{}");
  const mounted = claudeConfigCheck({ hostClaudeDir: claudeDir, hostClaudeJson: claudeJson });
  assert.equal(mounted?.status, "ok");
  assert.match(mounted?.detail ?? "", /mounted read-only; each Claude run gets a private copy/);
  assert.equal(mounted?.group, "Agents");

  const badOverride = claudeConfigCheck({ hostClaudeDir: claudeDir, hostClaudeJson: join(home, "nope.json"), hostClaudeJsonExplicit: true });
  assert.equal(badOverride?.status, "fail");
  assert.match(badOverride?.fix ?? "", /HOST_CLAUDE_JSON/);
});
