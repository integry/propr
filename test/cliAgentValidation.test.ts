import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { planAgentLogin, validateAgents } from "../packages/cli/src/commands/agentValidation.js";
import type { OrchestratorConfig, OrchestratorModule } from "../packages/cli/src/orchestrator/index.js";

function installFakeDocker(): () => void {
  const binDir = mkdtempSync(join(tmpdir(), "propr-cli-agent-docker-"));
  const dockerPath = join(binDir, "docker");
  writeFileSync(dockerPath, `#!/bin/sh
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
  process.env.PATH = `${binDir}${delimiter}${previousPath}`;
  return () => {
    process.env.PATH = previousPath;
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
    images: { "agent-claude": "propr/agent-claude:test" },
    manifestPath: "/tmp/manifest.json",
    ...overrides,
  };
}

function fakeOrchestrator(): OrchestratorModule {
  return {
    docker: () => ({ status: 0, stdout: "image-id\n", stderr: "" }),
    validateDockerBindPath: (name, value) => (!value || value.startsWith("/") ? null : `${name} must be absolute`),
  } as unknown as OrchestratorModule;
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

test("planAgentLogin runs the login container as the invoking host user", () => {
  const { plan, error } = planAgentLogin("claude", fakeConfig({ hostClaudeDir: "/tmp/claude" }), "/tmp/propr-login");
  assert.equal(error, undefined);
  assert.ok(plan);
  assert.equal(plan.dockerArgs[plan.dockerArgs.indexOf("--user") + 1], `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`);
});
