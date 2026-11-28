/**
 * Redeploying over a Machine an earlier layout created. flyctl merges the
 * machine_config JSON into the live config and keeps keys the JSON leaves
 * out, so the deploy has to clear them or replace the Machine. Run with:
 * `npx tsx --test src/commands/deploy/flyStaleMachineConfig.test.ts` (from packages/cli).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FlyctlBackend, type FlyctlRunner } from "./flyctlBackend.js";
import { createFlyctlTarget, runFlyDeploy } from "./flyDeployRunner.js";
import { buildMachineMetadata, FLY_DATA_PATH, renderFlyMachineConfigJson, type FlyDeployPlan } from "./flyMachineConfig.js";
import { staleMachineConfigKeys } from "./flyStaleMachineConfig.js";

const plan: FlyDeployPlan = {
  app: "my-propr",
  org: "personal",
  region: "ams",
  images: { app: "propr/app:0.9.3", redis: "redis:7-alpine", cloudflared: "cloudflare/cloudflared:2024.12.2" },
  cpuKind: "shared",
  cpus: 1,
  memoryMb: 2048,
  volumeName: "propr_data",
  volumeSizeGb: 1,
  agentRuntime: "docker",
  legacyDocker: true,
  rootfsSizeGb: 20,
  githubAppKey: false,
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Go's `json.Unmarshal` into an existing value, as flyctl decodes
 * machine_config onto a copy of the live config: object keys merge, missing
 * keys keep their value, array elements decode into the element already at
 * that index and the length becomes the JSON array's (so `[]` empties it).
 * `emptyArraysClear: false` models a flyctl that ignored an empty array.
 */
function goUnmarshal(into: Json | undefined, from: Json, emptyArraysClear = true): Json {
  if (Array.isArray(from)) {
    if (!from.length && !emptyArraysClear && Array.isArray(into)) return into;
    const existing = Array.isArray(into) ? into : [];
    return from.map((item, i) => goUnmarshal(existing[i], item, emptyArraysClear));
  }
  if (from && typeof from === "object") {
    const base = into && typeof into === "object" && !Array.isArray(into) ? { ...into } : {};
    for (const [key, value] of Object.entries(from)) base[key] = goUnmarshal(base[key], value, emptyArraysClear);
    return base;
  }
  return from;
}

/** The control-plane Machine as the temp_dir layout (before 5086d37) left it. */
function tempDirLayoutMachine(): { [key: string]: Json } {
  const shared = [{ name: "propr_shared", path: "/var/lib/propr-shared" }];
  return {
    metadata: { ...buildMachineMetadata(), fly_release_id: "r1" },
    mounts: [{ volume: "vol_1", path: FLY_DATA_PATH }],
    volumes: [{ name: "propr_shared", temp_dir: { storage_type: "disk", size_mb: 8192 } }],
    containers: [
      { name: "redis", image: "redis:7-alpine" },
      { name: "docker", image: "docker:dind", mounts: shared },
      { name: "app", image: "propr/app:0.9.2", mounts: shared },
    ],
  };
}

/**
 * flyctl with one app, one volume and the Machines `fly deploy` maintains.
 * `deploy` merges machine_config into the live Machine (or creates one from
 * it); `machine destroy` removes the Machine and detaches the volume after
 * `detachAfterLists` volume listings.
 */
function fakeFlyctl(machine: { [key: string]: Json } | undefined, opts: { emptyArraysClear?: boolean; detachAfterLists?: number } = {}) {
  const calls: string[] = [];
  let machines: Array<{ id: string; config: Json }> = machine ? [{ id: "m-old", config: machine }] : [];
  let attachedTo: string | undefined = machine ? "m-old" : undefined;
  let detachIn = -1;
  let created = 0;
  const runner: FlyctlRunner = (args) => {
    const argv = args.join(" ");
    calls.push(argv);
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (argv === "apps list --json") return ok(JSON.stringify([{ Name: plan.app, Organization: { Slug: "personal" } }]));
    if (argv.startsWith("volumes list")) {
      if (detachIn > 0 && --detachIn === 0) attachedTo = undefined;
      return ok(JSON.stringify([{ id: "vol_1", name: "propr_data", region: "ams", size_gb: 1, attached_machine_id: attachedTo ?? null }]));
    }
    if (argv.startsWith("secrets list")) return ok("[]");
    if (argv.startsWith("machine list")) return ok(JSON.stringify(machines));
    if (args[0] === "machine" && args[1] === "destroy") {
      machines = machines.filter((m) => m.id !== args[2]);
      detachIn = opts.detachAfterLists ?? 1;
      return ok();
    }
    if (args[0] === "deploy") {
      const configPath = args[args.indexOf("--config") + 1];
      const machineConfig = JSON.parse(readFileSync(join(configPath, "..", "propr-machine.json"), "utf-8")) as Json;
      if (machines[0]) {
        machines[0].config = goUnmarshal(machines[0].config, machineConfig, opts.emptyArraysClear ?? true);
      } else {
        if (attachedTo) return { status: 1, stdout: "", stderr: "volume vol_1 is attached to another Machine" };
        const id = `m-new-${++created}`;
        attachedTo = id;
        machines = [{ id, config: goUnmarshal({ mounts: [{ volume: "vol_1", path: FLY_DATA_PATH }] }, machineConfig) }];
      }
      return ok();
    }
    return ok();
  };
  return { calls, runner, machines: () => machines };
}

async function redeploy(fly: ReturnType<typeof fakeFlyctl>, detachTimeoutMs = 60_000) {
  const outDir = mkdtempSync(join(tmpdir(), "propr-fly-stale-"));
  const lines: string[] = [];
  try {
    const target = createFlyctlTarget(new FlyctlBackend(fly.runner), outDir, fetch, { sleep: async () => {}, detachTimeoutMs });
    const result = await runFlyDeploy({ plan, secrets: { PROPR_GH_RELAY_TOKEN: "rt" }, generatedSecrets: {} }, target, (line) => lines.push(line));
    return { result, lines };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

function liveConfig(fly: ReturnType<typeof fakeFlyctl>) {
  return fly.machines()[0]?.config as { volumes?: unknown; containers?: Array<{ name: string; mounts?: unknown }> };
}

test("the temp_dir layout's volumes and container mounts are reported as stale against the current plan", () => {
  const planned = JSON.parse(renderFlyMachineConfigJson(plan));
  assert.deepEqual(staleMachineConfigKeys(tempDirLayoutMachine(), planned), [
    "volumes (propr_shared)",
    "mounts of container docker",
    "mounts of container app",
  ]);
  assert.deepEqual(staleMachineConfigKeys(planned, planned), []);
  assert.deepEqual(staleMachineConfigKeys(undefined, planned), []);
});

test("the machine_config JSON clears volumes and every container's mounts explicitly", () => {
  const doc = JSON.parse(renderFlyMachineConfigJson(plan)) as { volumes: unknown; containers: Array<{ mounts: unknown }> };
  assert.deepEqual(doc.volumes, []);
  assert.ok(doc.containers.length > 0);
  for (const container of doc.containers) assert.deepEqual(container.mounts, []);
});

test("redeploying over the temp_dir layout clears its volumes and mounts in place", async () => {
  const fly = fakeFlyctl(tempDirLayoutMachine());
  const { result, lines } = await redeploy(fly);
  const config = liveConfig(fly);
  assert.equal(fly.machines()[0]?.id, "m-old", "same Machine, updated in place");
  assert.deepEqual(config.volumes, []);
  assert.deepEqual(config.containers?.map((c) => [c.name, c.mounts]), [["redis", []], ["docker", []], ["app", []]]);
  assert.equal(fly.calls.some((c) => c.startsWith("machine destroy")), false);
  assert.ok(lines.some((l) => l.includes("Machine m-old has config the new layout drops: volumes (propr_shared)")));
  assert.match(result.deployed, /^Deployed /);
});

test("without the explicit [] the merge keeps the stale keys (negative check of the fake)", () => {
  const legacy = JSON.parse(renderFlyMachineConfigJson(plan)) as { [key: string]: Json };
  delete legacy.volumes;
  legacy.containers = (legacy.containers as Array<{ [key: string]: Json }>).map(({ mounts: _m, ...rest }) => rest);
  const merged = goUnmarshal(tempDirLayoutMachine(), legacy) as { volumes?: unknown };
  assert.equal(staleMachineConfigKeys(merged, legacy).length, 3);
});

test("when flyctl keeps the stale keys, the Machine is replaced after its volume detaches and the volume is reused", async () => {
  const fly = fakeFlyctl(tempDirLayoutMachine(), { emptyArraysClear: false, detachAfterLists: 3 });
  const { result, lines } = await redeploy(fly);
  const config = liveConfig(fly);
  assert.equal(fly.machines().length, 1);
  assert.equal(fly.machines()[0]?.id, "m-new-1");
  assert.deepEqual(config.volumes, []);
  assert.ok(config.containers?.every((c) => !Array.isArray(c.mounts) || c.mounts.length === 0));
  const destroyAt = fly.calls.indexOf("machine destroy m-old --app my-propr --force");
  const deploys = fly.calls.map((c, i) => (c.startsWith("deploy ") ? i : -1)).filter((i) => i >= 0);
  assert.ok(destroyAt > deploys[0]! && deploys[1]! > destroyAt, "destroy between the two deploys");
  assert.equal(fly.calls.slice(destroyAt, deploys[1]).filter((c) => c.startsWith("volumes list")).length, 3, "waited for the volume to detach");
  assert.equal(fly.calls.some((c) => c.startsWith("volumes create")), false, "the data volume is kept");
  assert.ok(lines.some((l) => l.includes("replacing the Machine (volume propr_data is kept)")));
  assert.match(result.deployed, /^Replaced the Machine and deployed /);
});

test("a volume that never detaches stops before deploying a second Machine", async () => {
  const fly = fakeFlyctl(tempDirLayoutMachine(), { emptyArraysClear: false, detachAfterLists: Number.MAX_SAFE_INTEGER });
  await assert.rejects(redeploy(fly, 0), /volume propr_data is still attached to destroyed Machine m-old/);
  assert.equal(fly.calls.filter((c) => c.startsWith("deploy ")).length, 1);
});

test("a fresh Machine and a Machine already on the current layout are deployed once, with no replacement", async () => {
  for (const machine of [undefined, JSON.parse(renderFlyMachineConfigJson(plan)) as { [key: string]: Json }]) {
    const fly = fakeFlyctl(machine && { ...machine, mounts: [{ volume: "vol_1", path: FLY_DATA_PATH }] });
    const { result, lines } = await redeploy(fly);
    assert.equal(fly.calls.filter((c) => c.startsWith("deploy ")).length, 1);
    assert.equal(fly.calls.some((c) => c.startsWith("machine destroy")), false);
    assert.equal(lines.some((l) => l.includes("drops")), false);
    assert.match(result.deployed, /^Deployed /);
  }
});
