import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { OrchestratorConfig, OrchestratorModule } from "../../orchestrator/index.js";
import type { DockerCommandResult } from "../../orchestrator/types.js";
import { agentImagePresent } from "../agentValidation.js";
import { createDefaultAgentSetupActions } from "./agentHostActions.js";

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
// The reference a staged unsigned Linux preview binds into images.agent.
const PINNED = `propr/agent:${SHA}@${DIGEST}`;

/**
 * Local image store with Docker's reference semantics: after pulling a
 * tag@digest reference the daemon records the repository tag and the
 * repository digest separately. `docker images -q <ref>` filters those listed
 * repository[:tag] references, so it never matches the combined reference;
 * `docker image inspect` resolves it (the digest wins over the tag).
 */
function fakeDocker(pulled: boolean): { orch: OrchestratorModule; calls: string[][] } {
  const tags = new Set(pulled ? [`propr/agent:${SHA}`, "propr/agent:latest"] : []);
  const digests = new Set(pulled ? [`propr/agent@${DIGEST}`] : []);
  const calls: string[][] = [];
  const resolves = (ref: string): boolean => {
    const at = ref.indexOf("@");
    if (at < 0) return tags.has(ref);
    const repository = ref.slice(0, at).replace(/:[^/:]+$/, "");
    return digests.has(`${repository}${ref.slice(at)}`);
  };
  const run = (args: string[]): DockerCommandResult => {
    calls.push(args);
    if (args[0] === "images" && args[1] === "-q") {
      return { status: 0, stdout: tags.has(args[2]) ? "0123456789ab\n" : "", stderr: "" };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      const ref = args[args.length - 1];
      return resolves(ref)
        ? { status: 0, stdout: "sha256:0123456789ab\n", stderr: "" }
        : { status: 1, stdout: "", stderr: `Error: No such image: ${ref}\n` };
    }
    return { status: 1, stdout: "", stderr: `unexpected docker ${args.join(" ")}` };
  };
  const orch = {
    docker: (args: string[]) => run(args),
    dockerAsync: async (args: string[]) => run(args),
    validateDockerBindPath: () => null,
  } as unknown as OrchestratorModule;
  return { orch, calls };
}

function hostDirFixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "propr-agent-host-actions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "claude");
}

test("the agent image presence check resolves the exact digest-pinned preview reference", () => {
  const { orch } = fakeDocker(true);
  // The filter-based listing cannot see the combined tag@digest reference.
  assert.equal(orch.docker(["images", "-q", PINNED], { capture: true }).stdout, "");
  assert.equal(agentImagePresent(orch, PINNED), true);
  assert.equal(agentImagePresent(orch, `propr/agent:${SHA}@sha256:${"c".repeat(64)}`), false);
  assert.equal(agentImagePresent(fakeDocker(false).orch, PINNED), false);
});

test("setup login launches authentication for a pulled digest-pinned preview agent image", async (t) => {
  const { orch, calls } = fakeDocker(true);
  const cfg = { images: { agent: PINNED }, hostClaudeDir: hostDirFixture(t) } as unknown as OrchestratorConfig;
  const handoffs: string[][] = [];
  const actions = createDefaultAgentSetupActions(undefined, {
    loadHostConfig: async () => ({ orch, cfg }),
    authenticationHandoff: async (_command, args) => {
      handoffs.push(args);
      return { status: 0 };
    },
  });

  const result = await actions.loginAgent("/stack", "claude");

  assert.equal(result.success, true, result.detail);
  assert.equal(handoffs.length, 1);
  assert.ok(handoffs[0].includes(PINNED));
  assert.deepEqual(calls.filter((args) => args[0] === "image").map((args) => args.at(-1)), [PINNED]);
  assert.equal(calls.some((args) => args[0] === "images"), false);
});

test("setup login still refuses before authentication when the pinned agent image is absent", async (t) => {
  const { orch } = fakeDocker(false);
  const cfg = { images: { agent: PINNED }, hostClaudeDir: hostDirFixture(t) } as unknown as OrchestratorConfig;
  let handedOff = false;
  const actions = createDefaultAgentSetupActions(undefined, {
    loadHostConfig: async () => ({ orch, cfg }),
    authenticationHandoff: async () => {
      handedOff = true;
      return { status: 0 };
    },
  });

  const result = await actions.loginAgent("/stack", "claude");

  assert.deepEqual(result, {
    available: true,
    success: false,
    detail: `image ${PINNED} not present locally — run \`propr images pull\``,
  });
  assert.equal(handedOff, false);
});

test("setup agent validation treats a pulled digest-pinned preview agent image as present", async (t) => {
  // Keep the version probe from reaching a real host CLI or Docker daemon.
  const emptyPath = mkdtempSync(join(tmpdir(), "propr-agent-host-actions-path-"));
  const originalPath = process.env.PATH;
  process.env.PATH = emptyPath;
  t.after(() => {
    process.env.PATH = originalPath;
    rmSync(emptyPath, { recursive: true, force: true });
  });
  const { orch } = fakeDocker(true);
  const cfg = { images: { agent: PINNED } } as unknown as OrchestratorConfig;
  const actions = createDefaultAgentSetupActions(undefined, { loadHostConfig: async () => ({ orch, cfg }) });

  const [row] = await actions.validateAgents("/stack", ["claude"]);

  assert.equal(row.type, "claude");
  assert.doesNotMatch(row.detail ?? "", /not present/);
  assert.match(row.detail ?? "", /HOST_CLAUDE_DIR is not set/);
});
