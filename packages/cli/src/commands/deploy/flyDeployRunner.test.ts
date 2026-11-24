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
      async ensureVolume() { steps.push("volume"); return { id: "vol_1", created: true, sizeGb: 1 }; },
      async extendVolume() { throw new Error("not expected"); },
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
    if (args[0] === "volumes" && args[1] === "list") return { status: 0, stdout: JSON.stringify([{ id: "vol_1", name: "propr_data", region: "iad", size_gb: 1 }]), stderr: "" };
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

const legacyPlan: FlyDeployPlan = { ...plan, memoryMb: 2048, volumeSizeGb: 20, legacyDocker: true, agentRuntime: "docker" };

function dockerDiskSizeArg(machineConfig: string): string | undefined {
  const config = JSON.parse(machineConfig) as { containers: Array<{ name: string; files?: Array<{ raw_value: string }> }> };
  const docker = config.containers.find((c) => c.name === "docker");
  const script = Buffer.from(docker?.files?.[0]?.raw_value ?? "", "base64").toString();
  return /truncate -s (\d+)G/.exec(script)?.[1];
}

/** flyctl runner whose `volumes list` reports `sizes` in turn (the last one repeats). */
function sizedFlyctl(sizes: Array<number | undefined>, outDir: string) {
  const calls: string[][] = [];
  let listed = 0;
  const runner: FlyctlRunner = (args) => {
    calls.push(args);
    if (args[0] === "apps" && args[1] === "list") return { status: 0, stdout: JSON.stringify([{ Name: "my-propr" }]), stderr: "" };
    if (args[0] === "volumes" && args[1] === "list") {
      const size = sizes[Math.min(listed++, sizes.length - 1)];
      return { status: 0, stdout: JSON.stringify([{ id: "vol_1", name: "propr_data", region: "iad", ...(size === undefined ? {} : { size_gb: size }) }]), stderr: "" };
    }
    if (args[0] === "secrets" && args[1] === "list") return { status: 0, stdout: "[]", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, target: createFlyctlTarget(new FlyctlBackend(runner), outDir) };
}

test("flyctl: an undersized reused volume is extended and confirmed before secrets, and Docker is sized from it", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "propr-fly-test-"));
  try {
    const { calls, target } = sizedFlyctl([1, 20], outDir);
    const result = await runFlyDeploy({ plan: legacyPlan, secrets: { A: "1" }, generatedSecrets: {} }, target);
    const argv = calls.map((c) => c.join(" "));
    const extend = argv.indexOf("volumes extend vol_1 --app my-propr --size 20 --yes");
    assert.ok(extend > 0, argv.join("\n"));
    assert.equal(argv[extend + 1], "volumes list --app my-propr --json", "size is re-read after extending");
    assert.ok(extend < argv.findIndex((a) => a.startsWith("secrets import")), "extended before secrets are uploaded");
    assert.equal(result.volumeSizeGb, 20);
    assert.equal(dockerDiskSizeArg(readFileSync(join(outDir, "propr-machine.json"), "utf-8")), "18");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("flyctl: a volume that stays undersized after extending stops the deploy before secrets", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "propr-fly-test-"));
  try {
    const { calls, target } = sizedFlyctl([1], outDir);
    await assert.rejects(
      runFlyDeploy({ plan: legacyPlan, secrets: { A: "1" }, generatedSecrets: {} }, target),
      /still reports 1 GB after extending to 20 GB; extend it with `fly volumes extend vol_1 --size 20 --app my-propr`/,
    );
    assert.equal(calls.some((c) => c[0] === "secrets" || c[0] === "deploy"), false);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("flyctl: an unreadable volume size stops the deploy instead of assuming capacity", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "propr-fly-test-"));
  try {
    const { calls, target } = sizedFlyctl([undefined], outDir);
    await assert.rejects(runFlyDeploy({ plan: legacyPlan, secrets: {}, generatedSecrets: {} }, target), /could not read the size of volume propr_data/);
    assert.equal(calls.some((c) => c[1] === "extend" || c[0] === "secrets" || c[0] === "deploy"), false);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("a reused volume larger than requested is kept and sizes the Docker filesystem", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "propr-fly-test-"));
  try {
    const { calls, target } = sizedFlyctl([30], outDir);
    const result = await runFlyDeploy({ plan: legacyPlan, secrets: {}, generatedSecrets: {} }, target);
    assert.equal(calls.some((c) => c[1] === "extend"), false);
    assert.equal(result.volumeSizeGb, 30);
    assert.equal(dockerDiskSizeArg(readFileSync(join(outDir, "propr-machine.json"), "utf-8")), "28");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("Machines API: an undersized reused volume is extended, confirmed, and sizes the Docker filesystem", async () => {
  const calls: string[] = [];
  const sizes = [1, 20];
  let listed = 0;
  let createdConfig: unknown;
  const api = {
    async appExists() { return true; },
    async listVolumes() {
      const size = sizes[Math.min(listed++, sizes.length - 1)];
      calls.push(`list:${size}`);
      return [{ id: "vol_1", name: "propr_data", region: "iad", size_gb: size, state: "created" }];
    },
    async extendVolume(_app: string, id: string, sizeGb: number) { calls.push(`extend:${id}:${sizeGb}`); },
    async listSecretNames() { return []; },
    async setSecrets() { calls.push("secrets"); },
    async ensurePublicIps() { return []; },
    async listMachines() { return []; },
    async createMachine(_app: string, input: { config: unknown }) { createdConfig = input.config; return { id: "m-new", state: "created", region: "iad" }; },
    async waitForState() {},
  } as unknown as FlyMachinesApi;
  const result = await runFlyDeploy({ plan: legacyPlan, secrets: { A: "1" }, generatedSecrets: {} }, createMachinesApiTarget(api));
  assert.deepEqual(calls, ["list:1", "extend:vol_1:20", "list:20", "secrets"]);
  assert.equal(result.volumeSizeGb, 20);
  assert.equal(dockerDiskSizeArg(JSON.stringify(createdConfig)), "18");
});

test("Machines API: a volume Fly still reports undersized stops the deploy before secrets", async () => {
  const calls: string[] = [];
  const api = {
    async appExists() { return true; },
    async listVolumes() { return [{ id: "vol_1", name: "propr_data", region: "iad", size_gb: 1, state: "created" }]; },
    async extendVolume() { calls.push("extend"); },
    async setSecrets() { calls.push("secrets"); },
  } as unknown as FlyMachinesApi;
  await assert.rejects(runFlyDeploy({ plan: legacyPlan, secrets: {}, generatedSecrets: {} }, createMachinesApiTarget(api)), /still reports 1 GB/);
  assert.deepEqual(calls, ["extend"]);
});
