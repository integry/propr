/**
 * Deploy sequence and both targets with fakes. Run with:
 * `npx tsx --test src/commands/deploy/flyDeployRunner.test.ts` (from packages/cli).
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { test } from "node:test";
import { createFlyctlRunner, FlyctlBackend, renderSecretsImport, type FlyctlRunner } from "./flyctlBackend.js";
import { createFlyctlTarget, createMachinesApiTarget, runFlyDeploy, writeFlyFiles, type FlyDeployTarget } from "./flyDeployRunner.js";
import type { FlyMachinesApi } from "./flyMachinesApi.js";
import { renderFlyToml, type FlyDeployPlan } from "./flyMachineConfig.js";

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

/** A relay token, so the deploy has GitHub credentials and pins routing_websocket intake. */
const RELAY = { PROPR_GH_RELAY_TOKEN: "rt" };
const ROUTED = { GITHUB_EVENT_INTAKE_MODE: "routing_websocket" };

function fakeTarget(existingSecrets: string[]): { target: FlyDeployTarget; set: Array<Record<string, string>>; steps: string[]; deployed: FlyDeployPlan[] } {
  const set: Array<Record<string, string>> = [];
  const steps: string[] = [];
  const deployed: FlyDeployPlan[] = [];
  return {
    set,
    steps,
    deployed,
    target: {
      kind: "machines-api",
      async orgPlan() { steps.push("org-plan"); return "free"; },
      async ensureApp() { steps.push("app"); return true; },
      async ensureVolume() { steps.push("volume"); return { id: "vol_1", created: true, sizeGb: 1 }; },
      async extendVolume() { throw new Error("not expected"); },
      async secretNames() { steps.push("secret-names"); return existingSecrets; },
      async setSecrets(_app, values) { steps.push("secrets"); set.push(values); },
      async deploy(deployPlan) { steps.push("deploy"); deployed.push(deployPlan); return "deployed"; },
    },
  };
}

test("the GitHub App key is wired in when this run uploads it, when the app already has it, and not otherwise", async () => {
  // Uploaded by this run (a base64 key from the stack .env; the plan flag was never set).
  const uploading = fakeTarget([]);
  const lines: string[] = [];
  await runFlyDeploy({ plan, secrets: { PROPR_GH_PRIVATE_KEY_B64: "a2V5", GH_APP_ID: "42", GH_INSTALLATION_ID: "777" }, generatedSecrets: {} }, uploading.target, (l) => lines.push(l));
  assert.equal(uploading.deployed[0]?.githubAppKey, true);
  assert.equal(lines.some((l) => l.includes("earlier deploy")), false);

  // Left by an earlier deploy.
  const retained = fakeTarget(["PROPR_GH_PRIVATE_KEY_B64", "GH_APP_ID", "GH_INSTALLATION_ID"]);
  await runFlyDeploy({ plan, secrets: {}, generatedSecrets: {} }, retained.target, (l) => lines.push(l));
  assert.equal(retained.deployed[0]?.githubAppKey, true);
  assert.ok(lines.some((l) => l.includes("Keeping the GitHub App private key from an earlier deploy")));

  // No key anywhere.
  const none = fakeTarget([]);
  await runFlyDeploy({ plan, secrets: { ...RELAY }, generatedSecrets: {} }, none.target);
  assert.equal(none.deployed[0]?.githubAppKey, false);
});

test("generated SESSION_SECRET is set once and kept on redeploy", async () => {
  const first = fakeTarget([]);
  const lines: string[] = [];
  const result = await runFlyDeploy({ plan, secrets: { ANTHROPIC_API_KEY: "k", ...RELAY }, generatedSecrets: { SESSION_SECRET: "fresh" } }, first.target, (l) => lines.push(l));
  assert.deepEqual(first.steps, ["app", "volume", "secret-names", "secrets", "deploy"]);
  assert.deepEqual(first.set[0], { ANTHROPIC_API_KEY: "k", ...RELAY, ...ROUTED, SESSION_SECRET: "fresh" });
  assert.deepEqual(result.secretsSet, ["ANTHROPIC_API_KEY", "GITHUB_EVENT_INTAKE_MODE", "PROPR_GH_RELAY_TOKEN", "SESSION_SECRET"]);
  assert.equal(lines.join("\n").includes("fresh"), false, "secret values are never logged");

  const again = fakeTarget(["SESSION_SECRET", "PROPR_GH_RELAY_TOKEN"]);
  const second = await runFlyDeploy({ plan, secrets: {}, generatedSecrets: { SESSION_SECRET: "other" } }, again.target);
  assert.deepEqual(again.set[0], ROUTED);
  assert.deepEqual(second.secretsKept, ["SESSION_SECRET"]);
});

test("an explicit secret wins over a generated one", async () => {
  const fake = fakeTarget([]);
  await runFlyDeploy({ plan, secrets: { SESSION_SECRET: "from-env", ...RELAY }, generatedSecrets: { SESSION_SECRET: "gen" } }, fake.target);
  assert.deepEqual(fake.set[0], { SESSION_SECRET: "from-env", ...RELAY, ...ROUTED });
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
  const calls: Array<{ args: string[]; input?: string; inherit?: boolean; cwd?: string }> = [];
  const runner: FlyctlRunner = (args, options = {}) => {
    calls.push({ args, input: options.input, inherit: options.inherit, cwd: options.cwd });
    if (args[0] === "apps" && args[1] === "list") return { status: 0, stdout: JSON.stringify([{ Name: "someone-else" }]), stderr: "" };
    if (args[0] === "volumes" && args[1] === "list") return { status: 0, stdout: JSON.stringify([{ id: "vol_1", name: "propr_data", region: "iad", size_gb: 1 }]), stderr: "" };
    if (args[0] === "secrets" && args[1] === "list") return { status: 0, stdout: "[]", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const outDir = mkdtempSync(join(tmpdir(), "propr-fly-test-"));
  try {
    const target = createFlyctlTarget(new FlyctlBackend(runner), outDir);
    const result = await runFlyDeploy({ plan, secrets: { A: "1", ...RELAY }, generatedSecrets: { SESSION_SECRET: "generated-session-value" } }, target);
    assert.equal(result.appCreated, true);
    assert.equal(result.volumeCreated, false);
    const argv = calls.map((c) => c.args.join(" "));
    assert.ok(argv.includes("apps create my-propr --org personal"));
    assert.ok(!argv.some((a) => a.startsWith("volumes create")));
    const importCall = calls.find((c) => c.args[1] === "import");
    assert.deepEqual(importCall?.args, ["secrets", "import", "--app", "my-propr", "--stage"]);
    assert.equal(importCall?.input, "A=1\nPROPR_GH_RELAY_TOKEN=rt\nGITHUB_EVENT_INTAKE_MODE=routing_websocket\nSESSION_SECRET=generated-session-value");
    assert.equal(argv.some((a) => a.includes("SESSION_SECRET")), false, "secrets never on argv");
    const deploy = calls.find((c) => c.args[0] === "deploy");
    assert.deepEqual(deploy?.args, [
      "deploy", "--app", "my-propr", "--config", join(outDir, "fly.toml"), "--image", "propr/app:0.9.3",
      "--primary-region", "iad", "--ha=false", "--yes",
    ]);
    assert.equal(deploy?.inherit, true);
    assert.equal(deploy?.cwd, outDir, "flyctl runs from the config directory");
    // flyctl resolves machine_config against its working directory, so the path is absolute.
    assert.ok(readFileSync(join(outDir, "fly.toml"), "utf-8").includes(`machine_config = ${JSON.stringify(join(outDir, "propr-machine.json"))}`));
    const machineConfig = readFileSync(join(outDir, "propr-machine.json"), "utf-8");
    assert.equal(machineConfig.includes("generated-session-value") || machineConfig.includes('"rt"'), false, "secret values never reach the files");
    // Multi-container Machines pass app secrets only to containers that list them.
    const app = (JSON.parse(machineConfig) as { containers: Array<{ name: string; secrets?: Array<{ env_var: string; name: string }> }> })
      .containers.find((c) => c.name === "app");
    assert.deepEqual(app?.secrets?.map((entry) => entry.name), ["A", "GITHUB_EVENT_INTAKE_MODE", "PROPR_GH_RELAY_TOKEN", "SESSION_SECRET"]);
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

const legacyPlan: FlyDeployPlan = { ...plan, memoryMb: 2048, volumeSizeGb: 20, legacyDocker: true, agentRuntime: "docker", rootfsSizeGb: 20 };

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

test("flyctl: an undersized reused volume is extended and confirmed before secrets; Docker is sized from the rootfs", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "propr-fly-test-"));
  try {
    const { calls, target } = sizedFlyctl([1, 20], outDir);
    const result = await runFlyDeploy({ plan: legacyPlan, secrets: { A: "1", ...RELAY }, generatedSecrets: {} }, target);
    const argv = calls.map((c) => c.join(" "));
    const extend = argv.indexOf("volumes extend vol_1 --app my-propr --size 20 --yes");
    assert.ok(extend > 0, argv.join("\n"));
    assert.equal(argv[extend + 1], "volumes list --app my-propr --json", "size is re-read after extending");
    assert.ok(extend < argv.findIndex((a) => a.startsWith("secrets import")), "extended before secrets are uploaded");
    assert.equal(result.volumeSizeGb, 20);
    // Docker images live on the persistent rootfs, so the volume does not size them.
    assert.equal(dockerDiskSizeArg(readFileSync(join(outDir, "propr-machine.json"), "utf-8")), "16");
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

test("a reused volume larger than requested is kept and does not size the Docker filesystem", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "propr-fly-test-"));
  try {
    const { calls, target } = sizedFlyctl([30], outDir);
    const result = await runFlyDeploy({ plan: legacyPlan, secrets: { ...RELAY }, generatedSecrets: {} }, target);
    assert.equal(calls.some((c) => c[1] === "extend"), false);
    assert.equal(result.volumeSizeGb, 30);
    assert.equal(dockerDiskSizeArg(readFileSync(join(outDir, "propr-machine.json"), "utf-8")), "16");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("Machines API: an undersized reused volume is extended and confirmed; the Docker filesystem follows the rootfs", async () => {
  const calls: string[] = [];
  const sizes = [1, 20];
  let listed = 0;
  let createdConfig: unknown;
  const api = {
    async orgPlan() { calls.push("org-plan"); return "paid"; },
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
  const result = await runFlyDeploy({ plan: legacyPlan, secrets: { A: "1", ...RELAY }, generatedSecrets: {} }, createMachinesApiTarget(api));
  assert.deepEqual(calls, ["org-plan", "list:1", "extend:vol_1:20", "list:20", "secrets"]);
  assert.equal(result.volumeSizeGb, 20);
  assert.equal(dockerDiskSizeArg(JSON.stringify(createdConfig)), "16");
  assert.deepEqual((createdConfig as { rootfs?: unknown }).rootfs, { size_gb: 20, persist: true });
});

test("Machines API: a volume Fly still reports undersized stops the deploy before secrets", async () => {
  const calls: string[] = [];
  const api = {
    async orgPlan() { return "unknown"; },
    async appExists() { return true; },
    async listVolumes() { return [{ id: "vol_1", name: "propr_data", region: "iad", size_gb: 1, state: "created" }]; },
    async extendVolume() { calls.push("extend"); },
    async setSecrets() { calls.push("secrets"); },
  } as unknown as FlyMachinesApi;
  await assert.rejects(runFlyDeploy({ plan: legacyPlan, secrets: {}, generatedSecrets: {} }, createMachinesApiTarget(api)), /still reports 1 GB/);
  assert.deepEqual(calls, ["extend"]);
});

/**
 * Stand-in for `flyctl deploy`: like flyctl, it resolves fly.toml's
 * machine_config against its OWN working directory, not the config file's.
 */
const FAKE_FLYCTL = `#!/usr/bin/env node
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const args = process.argv.slice(2);
const toml = readFileSync(args[args.indexOf("--config") + 1], "utf-8");
const name = JSON.parse(/machine_config = (".*")/.exec(toml)[1]);
if (!existsSync(resolve(process.cwd(), name))) {
  console.error("Converting to machine in process group 'app' will fail because of: open " + name + ": no such file or directory");
  process.exit(1);
}
JSON.parse(readFileSync(resolve(process.cwd(), name), "utf-8"));
`;

test("flyctl finds machine_config when the CLI runs from a different directory than --out", () => {
  const root = mkdtempSync(join(tmpdir(), "propr-fly-cwd-"));
  try {
    const bin = join(root, "flyctl");
    writeFileSync(bin, FAKE_FLYCTL);
    chmodSync(bin, 0o755);
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    // A relative --out, as `--out ./propr-fly` from the operator's shell.
    const relativeOut = relative(process.cwd(), join(root, "propr-fly"));
    const files = writeFlyFiles(plan, relativeOut);
    assert.ok(isAbsolute(files.flyToml));
    const input = { app: plan.app, configPath: files.flyToml, image: plan.images.app, region: plan.region };
    const real = createFlyctlRunner(bin);

    // As the deploy runs it.
    new FlyctlBackend(real).deploy(input);
    // The absolute machine_config path alone is enough, whatever flyctl's cwd.
    new FlyctlBackend((args, options) => real(args, { ...options, inherit: false, cwd: elsewhere })).deploy(input);
    // And the cwd alone is enough for a hand-edited relative name.
    writeFileSync(files.flyToml, renderFlyToml(plan));
    new FlyctlBackend((args, options) => real(args, { ...options, inherit: false })).deploy(input);
    // Before the fix: relative name, flyctl started elsewhere.
    assert.throws(
      () => new FlyctlBackend((args, options) => real(args, { ...options, inherit: false, cwd: elsewhere })).deploy(input),
      /open propr-machine\.json: no such file or directory/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Free-plan preflight: a volume over 5 GB stops the deploy before anything is created", async () => {
  const free = fakeTarget([]);
  await assert.rejects(
    runFlyDeploy({ plan: { ...plan, volumeSizeGb: 20 }, secrets: { ...RELAY }, generatedSecrets: {} }, free.target),
    (error: Error) => /Free plan, which caps volumes at 5 GB, but --volume-size is 20 GB/.test(error.message)
      && /Nothing was created/.test(error.message) && /without --volume-size \(default: 1 GB/.test(error.message),
  );
  assert.deepEqual(free.steps, ["org-plan"]);
});

test("Free-plan preflight: volumes within the cap are not looked up, and paid or unknown plans go ahead", async () => {
  const small = fakeTarget([]);
  small.target.ensureVolume = async () => ({ id: "vol_1", created: true, sizeGb: 5 });
  await runFlyDeploy({ plan: { ...plan, volumeSizeGb: 5 }, secrets: { ...RELAY }, generatedSecrets: {} }, small.target);
  assert.equal(small.steps.includes("org-plan"), false);

  for (const [orgPlan, warns] of [["paid", false], ["unknown", true]] as const) {
    const big = fakeTarget([]);
    big.target.orgPlan = async () => orgPlan;
    big.target.ensureVolume = async () => ({ id: "vol_1", created: true, sizeGb: 20 });
    const lines: string[] = [];
    await runFlyDeploy({ plan: { ...plan, volumeSizeGb: 20 }, secrets: { ...RELAY }, generatedSecrets: {} }, big.target, (l) => lines.push(l));
    assert.equal(big.deployed.length, 1, orgPlan);
    assert.equal(lines.some((l) => l.includes("Could not read the Fly plan of org personal")), warns, orgPlan);
  }
});

test("flyctl target reads the org plan with the session token from `fly auth token`", async () => {
  const requests: Array<{ url: string; authorization: string; body: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, authorization: String((init.headers as Record<string, string>).Authorization), body: String(init.body) });
    return new Response(JSON.stringify({ data: { organization: { slug: "personal", paidPlan: false } } }), { status: 200 });
  }) as unknown as typeof fetch;
  const runner: FlyctlRunner = (args) => args.join(" ") === "auth token"
    ? { status: 0, stdout: "FlyV1 fm2_abc\n", stderr: "" }
    : { status: 1, stdout: "", stderr: "unexpected" };
  assert.equal(await createFlyctlTarget(new FlyctlBackend(runner), tmpdir(), fetchImpl).orgPlan("personal"), "free");
  assert.equal(requests[0]?.url, "https://api.fly.io/graphql");
  assert.equal(requests[0]?.authorization, "FlyV1 fm2_abc");
  assert.match(requests[0]?.body ?? "", /paidPlan/);
  assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}").variables, { slug: "personal" });

  const noSession: FlyctlRunner = () => ({ status: 1, stdout: "", stderr: "not logged in" });
  assert.equal(await createFlyctlTarget(new FlyctlBackend(noSession), tmpdir(), fetchImpl).orgPlan("personal"), "unknown");
  assert.equal(requests.length, 1);
});
