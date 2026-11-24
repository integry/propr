/**
 * Deploy sequence and both targets with fakes. Run with:
 * `npx tsx --test src/commands/deploy/flyDeployRunner.test.ts` (from packages/cli).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FlyctlBackend, renderSecretsImport, type FlyctlRunner } from "./flyctlBackend.js";
import { createFlyctlTarget, createMachinesApiTarget, runFlyDeploy, writeFlyFiles, type FlyDeployTarget } from "./flyDeployRunner.js";
import type { FlyMachinesApi } from "./flyMachinesApi.js";
import type { FlyDeployPlan } from "./flyMachineConfig.js";

const plan: FlyDeployPlan = {
  app: "my-propr",
  org: "personal",
  region: "iad",
  images: { app: "propr/app:0.9.3", redis: "redis:7-alpine", cloudflared: "cloudflare/cloudflared:2024.12.2" },
  cpuKind: "shared",
  cpus: 1,
  memoryMb: 1024,
  volumeName: "propr_data",
  volumeSizeGb: 1,
  agentRuntime: "sprites",
  legacyDocker: false,
  githubAppKey: false,
};

function fakeTarget(existingSecrets: string[]): { target: FlyDeployTarget; set: Array<Record<string, string>>; steps: string[] } {
  const set: Array<Record<string, string>> = [];
  const steps: string[] = [];
  return {
    set,
    steps,
    target: {
      kind: "machines-api",
      async ensureApp() { steps.push("app"); return true; },
      async ensureVolume() { steps.push("volume"); return { id: "vol_1", created: true }; },
      async secretNames() { steps.push("secret-names"); return existingSecrets; },
      async setSecrets(_app, values) { steps.push("secrets"); set.push(values); },
      async deploy() { steps.push("deploy"); return "deployed"; },
    },
  };
}

test("generated SESSION_SECRET is set once and kept on redeploy", async () => {
  const first = fakeTarget([]);
  const lines: string[] = [];
  const result = await runFlyDeploy({ plan, secrets: { ANTHROPIC_API_KEY: "k" }, generatedSecrets: { SESSION_SECRET: "fresh" } }, first.target, (l) => lines.push(l));
  assert.deepEqual(first.steps, ["app", "volume", "secret-names", "secrets", "deploy"]);
  assert.deepEqual(first.set[0], { ANTHROPIC_API_KEY: "k", SESSION_SECRET: "fresh" });
  assert.deepEqual(result.secretsSet, ["ANTHROPIC_API_KEY", "SESSION_SECRET"]);
  assert.equal(lines.join("\n").includes("fresh"), false, "secret values are never logged");

  const again = fakeTarget(["SESSION_SECRET"]);
  const second = await runFlyDeploy({ plan, secrets: {}, generatedSecrets: { SESSION_SECRET: "other" } }, again.target);
  assert.deepEqual(again.set[0], {});
  assert.deepEqual(second.secretsKept, ["SESSION_SECRET"]);
});

test("an explicit secret wins over a generated one", async () => {
  const fake = fakeTarget([]);
  await runFlyDeploy({ plan, secrets: { SESSION_SECRET: "from-env" }, generatedSecrets: { SESSION_SECRET: "gen" } }, fake.target);
  assert.deepEqual(fake.set[0], { SESSION_SECRET: "from-env" });
});

type FakeMachine = { id: string; role?: string; metadata?: Record<string, string>; mounts?: Array<{ volume: string; path: string }> };

function fakeApi(machines: FakeMachine[]): { api: FlyMachinesApi; calls: string[] } {
  const calls: string[] = [];
  const api = {
    async ensurePublicIps() { calls.push("ips"); return []; },
    async listMachines() {
      return machines.map((m) => ({
        id: m.id, state: "started", region: "iad",
        config: { metadata: m.metadata ?? (m.role ? { "propr-role": m.role } : {}), mounts: m.mounts ?? [] },
      }));
    },
    async createMachine(_app: string, input: { config: { mounts: unknown } }) {
      calls.push(`create:${JSON.stringify(input.config.mounts)}`);
      return { id: "m-new", state: "created", region: "iad" };
    },
    async updateMachine(_app: string, id: string) { calls.push(`update:${id}`); return { id, state: "started", region: "iad" }; },
    async waitForState(_app: string, machine: { id: string }) { calls.push(`wait:${machine.id}`); },
  } as unknown as FlyMachinesApi;
  return { api, calls };
}

test("Machines API target creates the control-plane Machine on the volume id", async () => {
  const { api, calls } = fakeApi([{ id: "other" }]);
  const summary = await createMachinesApiTarget(api).deploy(plan, { id: "vol_9" });
  assert.deepEqual(calls, ["ips", 'create:[{"volume":"vol_9","path":"/usr/src/app/data"}]', "wait:m-new"]);
  assert.match(summary, /Created Machine m-new/);
});

test("Machines API target updates the existing control-plane Machine in place", async () => {
  const { api, calls } = fakeApi([{ id: "m1", role: "control-plane" }]);
  await createMachinesApiTarget(api).deploy(plan, { id: "vol_9" });
  assert.deepEqual(calls, ["ips", "update:m1", "wait:m1"]);
});

test("a Machine created by flyctl is updated in place by a later Machines API deploy", async () => {
  // Same files the flyctl target writes; flyctl copies machine_config metadata onto the Machine.
  const outDir = mkdtempSync(join(tmpdir(), "propr-fly-test-"));
  try {
    const { machineConfig } = writeFlyFiles(plan, outDir);
    const flyctlMetadata = (JSON.parse(readFileSync(machineConfig, "utf-8")) as { metadata: Record<string, string> }).metadata;
    const { api, calls } = fakeApi([{ id: "m-fly", metadata: { ...flyctlMetadata, fly_release_id: "r1" } }]);
    const summary = await createMachinesApiTarget(api).deploy(plan, { id: "vol_9" });
    assert.deepEqual(calls, ["ips", "update:m-fly", "wait:m-fly"]);
    assert.match(summary, /Updated Machine m-fly/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("an untagged Machine that already holds the data volume is updated, not duplicated", async () => {
  const { api, calls } = fakeApi([{ id: "m-old", mounts: [{ volume: "vol_9", path: "/usr/src/app/data" }] }, { id: "other" }]);
  await createMachinesApiTarget(api).deploy(plan, { id: "vol_9" });
  assert.deepEqual(calls, ["ips", "update:m-old", "wait:m-old"]);
});

test("Machines API target refuses two control-plane Machines on one SQLite volume", async () => {
  const { api } = fakeApi([{ id: "m1", role: "control-plane" }, { id: "m2", role: "control-plane" }]);
  await assert.rejects(createMachinesApiTarget(api).deploy(plan, {}), /2 control-plane Machines/);
});

test("flyctl target: argv, stdin secrets and generated files", async () => {
  const calls: Array<{ args: string[]; input?: string; inherit?: boolean }> = [];
  const runner: FlyctlRunner = (args, options = {}) => {
    calls.push({ args, input: options.input, inherit: options.inherit });
    if (args[0] === "apps" && args[1] === "list") return { status: 0, stdout: JSON.stringify([{ Name: "someone-else" }]), stderr: "" };
    if (args[0] === "volumes" && args[1] === "list") return { status: 0, stdout: JSON.stringify([{ id: "vol_1", name: "propr_data", region: "iad" }]), stderr: "" };
    if (args[0] === "secrets" && args[1] === "list") return { status: 0, stdout: "[]", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const outDir = mkdtempSync(join(tmpdir(), "propr-fly-test-"));
  try {
    const target = createFlyctlTarget(new FlyctlBackend(runner), outDir);
    const result = await runFlyDeploy({ plan, secrets: { A: "1" }, generatedSecrets: { SESSION_SECRET: "s" } }, target);
    assert.equal(result.appCreated, true);
    assert.equal(result.volumeCreated, false);
    const argv = calls.map((c) => c.args.join(" "));
    assert.ok(argv.includes("apps create my-propr --org personal"));
    assert.ok(!argv.some((a) => a.startsWith("volumes create")));
    const importCall = calls.find((c) => c.args[1] === "import");
    assert.deepEqual(importCall?.args, ["secrets", "import", "--app", "my-propr", "--stage"]);
    assert.equal(importCall?.input, "A=1\nSESSION_SECRET=s");
    assert.equal(argv.some((a) => a.includes("SESSION_SECRET")), false, "secrets never on argv");
    const deploy = calls.find((c) => c.args[0] === "deploy");
    assert.deepEqual(deploy?.args, [
      "deploy", "--app", "my-propr", "--config", join(outDir, "fly.toml"), "--image", "propr/app:0.9.3",
      "--primary-region", "iad", "--ha=false", "--yes",
    ]);
    assert.equal(deploy?.inherit, true);
    assert.match(readFileSync(join(outDir, "fly.toml"), "utf-8"), /machine_config = "propr-machine\.json"/);
    assert.equal(readFileSync(join(outDir, "propr-machine.json"), "utf-8").includes("SESSION_SECRET"), false);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("flyctl failures surface stderr", () => {
  const backend = new FlyctlBackend(() => ({ status: 1, stdout: "", stderr: "Error: Not authorized" }));
  assert.throws(() => backend.createApp("a", "personal"), /apps create failed: Error: Not authorized/);
});

test("secrets import rejects multi-line values", () => {
  assert.throws(() => renderSecretsImport({ KEY: "a\nb" }), /single line/);
});
