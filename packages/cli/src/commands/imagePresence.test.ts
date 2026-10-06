import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test, type TestContext } from "node:test";
import { configureOrchestratorManifestPath, getHostConfig } from "../orchestrator/index.js";
import { validateAgents } from "./agentValidation.js";
import { createAgentCommand } from "./agentCommands.js";
import { runChecks, type CheckResult } from "./checkCommands.js";

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
// The digest-pinned references a staged unsigned Linux preview binds into images.*.
const PINNED_AGENT = `propr/agent:${SHA}@${DIGEST}`;
const PINNED_APP = `propr/app:${SHA}@${DIGEST}`;
const TAGGED_REDIS = "redis:7-alpine";

/**
 * Fake `docker` with the real daemon's reference semantics: `images -q` filters
 * by repository[:tag] and never matches a combined repo:tag@digest reference,
 * while `image inspect` resolves the exact reference. Only references listed in
 * FAKE_DOCKER_PRESENT (one per line) exist; FAKE_DOCKER_PRESENCE=fail makes the
 * presence inspect itself fail.
 */
function installFakeDocker(t: TestContext, present: string[]): { log: () => string[] } {
  const root = mkdtempSync(join(tmpdir(), "propr-image-presence-"));
  const logPath = join(root, "docker.log");
  writeFileSync(logPath, "");
  writeFileSync(join(root, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
is_present() {
  printf '%s\\n' "$FAKE_DOCKER_PRESENT" | grep -Fqx -- "$1"
}
case "$1" in
  --version) echo "Docker version 27.0.0"; exit 0 ;;
  info) exit 0 ;;
  images)
    case "$3" in *@*) exit 0 ;; esac
    is_present "$3" && echo "0123456789ab"
    exit 0 ;;
  manifest) echo '{"Descriptor":{"digest":"${DIGEST}"}}'; exit 0 ;;
  run) echo "claude version 1.2.3"; exit 0 ;;
esac
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  ref="$5"
  if [ "$4" = "{{.Id}}" ] && [ "$FAKE_DOCKER_PRESENCE" = "fail" ]; then
    echo "Cannot connect to the Docker daemon" >&2
    exit 1
  fi
  if ! is_present "$ref"; then
    echo "Error response from daemon: No such image: $ref" >&2
    exit 1
  fi
  if [ "$4" = "{{.Id}}" ]; then echo "sha256:0123456789abcdef"; exit 0; fi
  repo="\${ref%%@*}"; repo="\${repo%:*}"
  echo "[\\"$repo@${DIGEST}\\"]"
  exit 0
fi
exit 1
`);
  chmodSync(join(root, "docker"), 0o755);
  const saved = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    FAKE_DOCKER_LOG: process.env.FAKE_DOCKER_LOG,
    FAKE_DOCKER_PRESENT: process.env.FAKE_DOCKER_PRESENT,
    FAKE_DOCKER_PRESENCE: process.env.FAKE_DOCKER_PRESENCE,
  };
  process.env.PATH = `${root}${delimiter}${process.env.PATH ?? ""}`;
  process.env.HOME = join(root, "home");
  mkdirSync(process.env.HOME);
  process.env.FAKE_DOCKER_LOG = logPath;
  process.env.FAKE_DOCKER_PRESENT = present.join("\n");
  delete process.env.FAKE_DOCKER_PRESENCE;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { log: () => readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean) };
}

/** Stack root whose bundled manifest pins the agent and app by tag@digest. */
function stackFixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "propr-image-presence-stack-"));
  const claudeDir = join(root, "claude");
  mkdirSync(claudeDir);
  writeFileSync(join(root, ".env"), `HOST_CLAUDE_DIR=${claudeDir}\n`);
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    version: "0.9.0",
    registry: "propr",
    images: { app: PINNED_APP, agent: PINNED_AGENT, redis: TAGGED_REDIS },
  }));
  configureOrchestratorManifestPath(manifestPath);
  t.after(() => {
    configureOrchestratorManifestPath(undefined);
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

const find = (results: CheckResult[], name: string): CheckResult | undefined => results.find((r) => r.name === name);

test("propr check reports pulled digest-pinned images and ordinary tagged images as present", async (t) => {
  const docker = installFakeDocker(t, [PINNED_AGENT, PINNED_APP, TAGGED_REDIS]);
  const root = stackFixture(t);

  const skipped = await runChecks({ root, skipRemoteImageCheck: true, verify: true, agents: ["claude"] });
  assert.deepEqual(find(skipped.results, "Image agent"), { name: "Image agent", status: "ok", detail: `${PINNED_AGENT} (local; remote check skipped)`, group: "Images" });
  assert.deepEqual(find(skipped.results, "Image app"), { name: "Image app", status: "ok", detail: `${PINNED_APP} (local; remote check skipped)`, group: "Images" });
  assert.equal(find(skipped.results, "Image redis")?.status, "ok");
  // --verify runs the agent CLI smoke test from the exact pinned reference.
  assert.match(find(skipped.results, "Verify: claude")?.detail ?? "", /^image runs/);
  assert.ok(docker.log().some((line) => line.startsWith("run ") && line.includes(` ${PINNED_AGENT} claude --version`)));

  // With registry checks the launcher's freshness probe resolves the same pinned reference.
  const remote = await runChecks({ root });
  assert.deepEqual(find(remote.results, "Image agent"), { name: "Image agent", status: "ok", detail: `${PINNED_AGENT} (current)`, group: "Images" });
  assert.deepEqual(find(remote.results, "Image app"), { name: "Image app", status: "ok", detail: `${PINNED_APP} (current)`, group: "Images" });
  assert.deepEqual(find(remote.results, "Image redis"), { name: "Image redis", status: "ok", detail: `${TAGGED_REDIS} (present)`, group: "Images" });
  assert.ok(docker.log().some((line) => line === `image inspect --format {{.Id}} ${PINNED_AGENT}`));
  assert.equal(docker.log().some((line) => line.startsWith("images ")), false);
});

for (const [label, present, presence] of [
  ["were never pulled", [TAGGED_REDIS], undefined],
  ["cannot be inspected", [PINNED_AGENT, PINNED_APP, TAGGED_REDIS], "fail"],
] as const) {
  test(`propr check reports digest-pinned images as missing when they ${label}`, async (t) => {
    const docker = installFakeDocker(t, [...present]);
    if (presence) process.env.FAKE_DOCKER_PRESENCE = presence;
    const root = stackFixture(t);

    for (const options of [{ skipRemoteImageCheck: true }, {}]) {
      const { results } = await runChecks({ root, ...options, verify: true, agents: ["claude"] });
      for (const [key, ref] of [["agent", PINNED_AGENT], ["app", PINNED_APP]]) {
        assert.equal(find(results, `Image ${key}`)?.status, "warn");
        assert.equal(find(results, `Image ${key}`)?.detail, `${ref} not present locally`);
      }
      assert.deepEqual(find(results, "Verify: claude"), {
        name: "Verify: claude", status: "warn", detail: `image ${PINNED_AGENT} not present — skipped`, group: "Agents",
      });
    }
    assert.equal(docker.log().some((line) => line.startsWith("run ")), false);
    assert.equal(docker.log().some((line) => line.startsWith("manifest ")), false);
  });
}

async function runAgentLogin(t: TestContext, root: string): Promise<{ exitCode?: number; errors: string[] }> {
  const errors: string[] = [];
  let exitCode: number | undefined;
  for (const stream of [process.stdin, process.stdout]) {
    const original = Object.getOwnPropertyDescriptor(stream, "isTTY");
    Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
    t.after(() => {
      if (original) Object.defineProperty(stream, "isTTY", original);
      else delete (stream as { isTTY?: boolean }).isTTY;
    });
  }
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", (line: string) => errors.push(line));
  t.mock.method(process, "exit", (code?: number) => {
    exitCode ??= code;
    throw new Error(`process.exit(${code})`);
  });
  await createAgentCommand().parseAsync(["login", "claude", "--root", root], { from: "user" }).catch(() => {});
  return { exitCode, errors };
}

test("propr agent login launches the pulled digest-pinned agent image", async (t) => {
  const docker = installFakeDocker(t, [PINNED_AGENT]);
  const root = stackFixture(t);

  const { exitCode, errors } = await runAgentLogin(t, root);

  assert.equal(exitCode, undefined, errors.join("\n"));
  const runs = docker.log().filter((line) => line.startsWith("run "));
  assert.equal(runs.length, 1);
  assert.match(runs[0], new RegExp(` ${PINNED_AGENT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `));
  assert.ok(docker.log().includes(`image inspect --format {{.Id}} ${PINNED_AGENT}`));
});

for (const [label, present, presence] of [
  ["is absent", [], undefined],
  ["cannot be inspected", [PINNED_AGENT], "fail"],
] as const) {
  test(`propr agent login refuses before Docker login when the pinned agent image ${label}`, async (t) => {
    const docker = installFakeDocker(t, [...present]);
    if (presence) process.env.FAKE_DOCKER_PRESENCE = presence;
    const root = stackFixture(t);

    const { exitCode, errors } = await runAgentLogin(t, root);

    assert.equal(exitCode, 1);
    assert.ok(errors.includes(`Image ${PINNED_AGENT} is not present locally. Pull it first: propr images pull`), errors.join("\n"));
    assert.equal(docker.log().some((line) => line.startsWith("run ")), false);
  });
}

test("agent validation probes a pulled digest-pinned image and skips a missing or uninspectable one", async (t) => {
  const docker = installFakeDocker(t, [PINNED_AGENT]);
  const root = stackFixture(t);
  const { orch, cfg } = await getHostConfig({ root });

  const [present] = await validateAgents(orch, cfg, { agents: ["claude"], skipHost: true });
  assert.equal(present.imageVersion, "1.2.3");
  assert.doesNotMatch(present.image.detail, /not present/);
  assert.ok(docker.log().some((line) => line.startsWith("run ") && line.includes(PINNED_AGENT)));

  for (const configure of [
    () => { process.env.FAKE_DOCKER_PRESENT = ""; },
    () => { process.env.FAKE_DOCKER_PRESENT = PINNED_AGENT; process.env.FAKE_DOCKER_PRESENCE = "fail"; },
  ]) {
    configure();
    const before = docker.log().length;
    const [missing] = await validateAgents(orch, cfg, { agents: ["claude"], skipHost: true });
    assert.equal(missing.imageVersion, undefined);
    assert.deepEqual(missing.image, { status: "warn", detail: `image ${PINNED_AGENT} not present — skipped` });
    assert.equal(docker.log().slice(before).some((line) => line.startsWith("run ")), false);
  }
});
