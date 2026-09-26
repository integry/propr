import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";

import { planAgentLogin, validateAgentFilter, validateAgents } from "../packages/cli/src/commands/agentValidation.js";
import type { OrchestratorConfig, OrchestratorModule } from "../packages/cli/src/orchestrator/index.js";

function installFakeDocker(logFile?: string): () => void {
  const binDir = mkdtempSync(join(tmpdir(), "propr-cli-agent-docker-"));
  const dockerPath = join(binDir, "docker");
  writeFileSync(dockerPath, `#!/bin/sh
if [ -n "$PROPR_FAKE_DOCKER_LOG" ]; then
  printf '%s\\n' "$*" >> "$PROPR_FAKE_DOCKER_LOG"
fi
if [ "$1" = "images" ]; then
  echo "image-id"
  exit 0
fi
if [ "$1" = "run" ]; then
  echo "claude version 1.2.3"
  exit 0
fi
echo "unexpected docker command: $*" >&2
exit 1
`);
  chmodSync(dockerPath, 0o755);
  const previousPath = process.env.PATH || "";
  const previousLog = process.env.PROPR_FAKE_DOCKER_LOG;
  process.env.PATH = `${binDir}${delimiter}${previousPath}`;
  if (logFile) process.env.PROPR_FAKE_DOCKER_LOG = logFile;
  return () => {
    process.env.PATH = previousPath;
    if (previousLog === undefined) {
      delete process.env.PROPR_FAKE_DOCKER_LOG;
    } else {
      process.env.PROPR_FAKE_DOCKER_LOG = previousLog;
    }
  };
}

function fakeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    stack: "propr",
    network: "propr-net",
    envFileLocal: "/tmp/propr/.env",
    validateHostPaths: false,
    apiPort: "4000",
    uiPort: "5173",
    docsPort: "8080",
    redisExternalPort: "",
    docsEnabled: false,
    vibePromptCacheDir: "/tmp/propr-vibe-prompts",
    manifest: { version: "test", images: {} },
    images: { agent: "propr/agent:test" },
    manifestPath: "/tmp/manifest.json",
    ...overrides,
  };
}

function fakeOrchestrator(): OrchestratorModule {
  return {
    docker: () => ({ status: 0, stdout: "image-id\n", stderr: "" }),
    dockerAsync: async () => ({ status: 0, stdout: "image-id\n", stderr: "" }),
    validateDockerBindPath: (name, value) => (!value || value.startsWith("/") ? null : `${name} must be absolute`),
  } as unknown as OrchestratorModule;
}

async function waitForLog(logFile: string, predicate: (contents: string) => boolean): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const contents = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    if (predicate(contents)) return contents;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for validation log:\n${existsSync(logFile) ? readFileSync(logFile, "utf8") : "(empty)"}`);
}

test("validateAgents skips image validation when the stack credential mount is not configured", async () => {
  const restore = installFakeDocker();
  try {
    const rows = await validateAgents(fakeOrchestrator(), fakeConfig(), { agents: ["claude"] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].image.status, "warn");
    assert.match(rows[0].image.detail, /HOST_CLAUDE_DIR is not set/);
    assert.match(rows[0].image.detail, /stack will not mount/);
  } finally {
    restore();
  }
});

test("validateAgents defaults to configured stack agents only", async () => {
  const restore = installFakeDocker();
  try {
    const rows = await validateAgents(fakeOrchestrator(), fakeConfig());
    assert.deepEqual(rows, []);
  } finally {
    restore();
  }
});

test("validateAgents includes a configured credential mount by default", async () => {
  const hostDir = join(mkdtempSync(join(tmpdir(), "propr-cli-agent-creds-")), "claude");
  mkdirSync(hostDir);
  const restore = installFakeDocker();
  try {
    const rows = await validateAgents(fakeOrchestrator(), fakeConfig({ hostClaudeDir: hostDir }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, "claude");
  } finally {
    restore();
  }
});

test("validateAgentFilter accepts mixed-case agent names", () => {
  assert.deepEqual(validateAgentFilter(["Claude", " CODEX "]), { agents: ["claude", "codex"], unknown: [] });
});

test("validateAgents supports Vibe image validation with only MISTRAL_API_KEY", async () => {
  const restore = installFakeDocker();
  try {
    const rows = await validateAgents(fakeOrchestrator(), fakeConfig({ mistralApiKey: "test-key" }), { agents: ["vibe"] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].image.status, "ok");
  } finally {
    restore();
  }
});

test("validateAgents starts validation containers as root so entrypoints can drop to node", async () => {
  const logFile = join(mkdtempSync(join(tmpdir(), "propr-cli-agent-docker-log-")), "docker.log");
  const hostDir = join(mkdtempSync(join(tmpdir(), "propr-cli-agent-creds-")), "claude");
  mkdirSync(hostDir);
  const restore = installFakeDocker(logFile);
  try {
    await validateAgents(fakeOrchestrator(), fakeConfig({ hostClaudeDir: hostDir }), { agents: ["claude"] });
    const logged = readFileSync(logFile, "utf8");
    assert.match(logged, /run .*--user 0:0/);
  } finally {
    restore();
  }
});

test("Antigravity image validation leaves the prompt on stdin", async () => {
  const logFile = join(mkdtempSync(join(tmpdir(), "propr-cli-agent-docker-log-")), "docker.log");
  const hostDir = join(mkdtempSync(join(tmpdir(), "propr-cli-agent-creds-")), "antigravity");
  mkdirSync(hostDir);
  const restore = installFakeDocker(logFile);
  try {
    await validateAgents(fakeOrchestrator(), fakeConfig({ hostAntigravityDir: hostDir }), { agents: ["antigravity"] });
    const logged = readFileSync(logFile, "utf8");
    assert.match(logged, /exec agy --dangerously-skip-permissions/);
    assert.doesNotMatch(logged, /--print -/);
  } finally {
    restore();
  }
});

test("validateAgents drains staggered version, host, and image children before cleanup and cancellation", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "propr-cli-agent-drain-"));
  const eventLog = join(fixtureDir, "events.log");
  const executable = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const isDocker = path.basename(process.argv[1]) === "docker";
const kind = isDocker
  ? (args.includes("--network=none") ? "image-version" : "image-check")
  : (args[0] === "--version" ? "host-version" : "host-check");
const delay = { "host-version": 5, "host-check": 20, "image-check": 40, "image-version": 90 }[kind];
const log = process.env.PROPR_VALIDATION_EVENT_LOG;
const record = (event, ...extra) => fs.appendFileSync(log,
  [event, kind, process.pid, process.cwd(), ...extra].join("|") + "\\n");
// Each child reports whether the validation temporary root (the host check's
// parent directory) still exists at the moment it closes.
const temporaryRootPresent = () => {
  const hostCheck = fs.readFileSync(log, "utf8").split("\\n").find(line => line.startsWith("start|host-check|"));
  return hostCheck ? fs.existsSync(path.dirname(hostCheck.split("|")[3])) : "unknown";
};
process.on("SIGTERM", () => setTimeout(() => { record("exit", "root=" + temporaryRootPresent()); process.exit(0); }, delay));
record("start");
setInterval(() => undefined, 1000);
`;
  const dockerPath = join(fixtureDir, "docker");
  const claudePath = join(fixtureDir, "claude");
  writeFileSync(dockerPath, executable, { mode: 0o700 });
  writeFileSync(claudePath, executable, { mode: 0o700 });
  chmodSync(dockerPath, 0o700);
  chmodSync(claudePath, 0o700);
  const hostDir = join(fixtureDir, "claude-creds");
  mkdirSync(hostDir);
  const previousPath = process.env.PATH;
  const previousEventLog = process.env.PROPR_VALIDATION_EVENT_LOG;
  process.env.PATH = `${fixtureDir}${delimiter}${previousPath ?? ""}`;
  process.env.PROPR_VALIDATION_EVENT_LOG = eventLog;
  const controller = new AbortController();
  const cancellation = Object.assign(new Error("staggered cancellation"), { name: "AbortError" });
  let validation: Promise<unknown> | undefined;
  let logAtSettlement: string | undefined;
  let runningAtSettlement: string[] | undefined;
  try {
    validation = validateAgents(fakeOrchestrator(), fakeConfig({ hostClaudeDir: hostDir }), {
      agents: ["claude"],
      signal: controller.signal,
    });
    // Snapshot the children at settlement instead of polling for an
    // intermediate state, so a stalled event loop on a loaded runner cannot
    // make the ordering checks below miss or misread it. A child counts as
    // closed once it is gone, whether it exited on SIGTERM or was escalated
    // to SIGKILL after the grace period.
    const snapshot = () => {
      logAtSettlement = existsSync(eventLog) ? readFileSync(eventLog, "utf8") : "";
      runningAtSettlement = logAtSettlement.split("\n").filter(line => line.startsWith("start|")).filter(line => {
        try {
          process.kill(Number(line.split("|")[2]), 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
      });
    };
    void validation.then(snapshot, snapshot);
    const started = await waitForLog(eventLog, contents =>
      ["host-version", "host-check", "image-version", "image-check"]
        .every(kind => contents.includes(`start|${kind}|`))
    );
    const hostCheck = started.split("\n").find(line => line.startsWith("start|host-check|"));
    assert.ok(hostCheck);
    const temporaryRoot = dirname(hostCheck.split("|")[3]);

    controller.abort(cancellation);
    await assert.rejects(validation, error => error === cancellation);
    assert.ok(logAtSettlement !== undefined && runningAtSettlement !== undefined);
    assert.equal(logAtSettlement.split("\n").filter(line => line.startsWith("start|")).length, 4);
    assert.deepEqual(runningAtSettlement, [], `cancellation settled before every child closed:\n${logAtSettlement}`);
    const exits = logAtSettlement.split("\n").filter(line => line.startsWith("exit|"));
    assert.ok(exits.length > 0, `no child drained on SIGTERM:\n${logAtSettlement}`);
    for (const exit of exits) {
      assert.ok(exit.endsWith("|root=true"), `temporary validation resources were removed while a child was still running:\n${logAtSettlement}`);
    }
    const completed = readFileSync(eventLog, "utf8");
    assert.equal(existsSync(temporaryRoot), false);
    for (const line of completed.split("\n").filter(line => line.startsWith("start|"))) {
      const pid = Number(line.split("|")[2]);
      assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
    }
  } finally {
    process.env.PATH = previousPath;
    if (previousEventLog === undefined) delete process.env.PROPR_VALIDATION_EVENT_LOG;
    else process.env.PROPR_VALIDATION_EVENT_LOG = previousEventLog;
    controller.abort(cancellation);
    await validation?.catch(() => undefined);
    if (existsSync(eventLog)) {
      for (const line of readFileSync(eventLog, "utf8").split("\n").filter(line => line.startsWith("start|"))) {
        try { process.kill(Number(line.split("|")[2]), "SIGKILL"); } catch { /* already reaped */ }
      }
    }
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("planAgentLogin validates configured host paths before callers create them", () => {
  const { plan, error } = planAgentLogin(
    "claude",
    fakeConfig({ hostClaudeDir: "relative/claude" }),
    "/tmp/propr-login",
    (name, value) => (!value || value.startsWith("/") ? null : `${name} must be absolute`)
  );
  assert.equal(plan, undefined);
  assert.equal(error, "HOST_CLAUDE_DIR must be absolute");
});

test("planAgentLogin starts the login container as root so the entrypoint can drop to node", () => {
  const { plan, error } = planAgentLogin("claude", fakeConfig({ hostClaudeDir: "/tmp/claude" }), "/tmp/propr-login");
  assert.equal(error, undefined);
  assert.ok(plan);
  assert.equal(plan.dockerArgs[plan.dockerArgs.indexOf("--user") + 1], "0:0");
});
