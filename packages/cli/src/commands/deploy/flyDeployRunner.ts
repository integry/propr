/**
 * The `propr deploy fly` sequence, independent of how Fly is reached:
 *
 *   1. app        create it in the chosen org unless it exists
 *   2. volume     reuse the named volume in the region, else create it
 *   3. secrets    upload the given secrets; generated ones (SESSION_SECRET)
 *                 only when the app does not already have them, so a redeploy
 *                 never logs everybody out or rotates encryption keys
 *   4. deploy     the published app image directly (no build, no DinD)
 *
 * Two targets implement the steps: flyctl (when installed) and the Machines
 * API with a user-provided token. Both are idempotent, so re-running the
 * command updates the existing deployment in place.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FlyctlBackend } from "./flyctlBackend.js";
import { FlyMachinesApi, type FlyMachine } from "./flyMachinesApi.js";
import {
  buildMachineConfig,
  FLY_MACHINE_CONFIG_FILE,
  renderFlyMachineConfigJson,
  renderFlyToml,
  type FlyDeployPlan,
} from "./flyMachineConfig.js";

export interface FlyDeployTarget {
  readonly kind: "flyctl" | "machines-api";
  ensureApp(app: string, org: string): Promise<boolean>;
  ensureVolume(app: string, input: { name: string; region: string; sizeGb: number }): Promise<{ id?: string; created: boolean }>;
  secretNames(app: string): Promise<string[]>;
  setSecrets(app: string, values: Record<string, string>): Promise<void>;
  deploy(plan: FlyDeployPlan, volume: { id?: string }): Promise<string>;
}

export interface FlyDeployInput {
  plan: FlyDeployPlan;
  /** Always uploaded (from the stack .env, relay enrollment, tunnel token, flags). */
  secrets: Record<string, string>;
  /** Uploaded only when the app does not already have a secret of that name. */
  generatedSecrets: Record<string, string>;
}

export interface FlyDeployResult {
  appCreated: boolean;
  volumeCreated: boolean;
  secretsSet: string[];
  secretsKept: string[];
  deployed: string;
}

export async function runFlyDeploy(
  input: FlyDeployInput,
  target: FlyDeployTarget,
  log: (line: string) => void = () => {},
): Promise<FlyDeployResult> {
  const { plan } = input;
  log(`Using ${target.kind === "flyctl" ? "flyctl" : "the Fly Machines API"}.`);

  const appCreated = await target.ensureApp(plan.app, plan.org);
  log(appCreated ? `Created app ${plan.app} in org ${plan.org}.` : `App ${plan.app} already exists.`);

  const volume = await target.ensureVolume(plan.app, { name: plan.volumeName, region: plan.region, sizeGb: plan.volumeSizeGb });
  log(volume.created
    ? `Created ${plan.volumeSizeGb} GB volume ${plan.volumeName} in ${plan.region}.`
    : `Reusing volume ${plan.volumeName} in ${plan.region}.`);

  const existing = new Set(await target.secretNames(plan.app));
  const toSet: Record<string, string> = { ...input.secrets };
  const secretsKept: string[] = [];
  for (const [name, value] of Object.entries(input.generatedSecrets)) {
    if (existing.has(name) || name in toSet) secretsKept.push(name);
    else toSet[name] = value;
  }
  await target.setSecrets(plan.app, toSet);
  const secretsSet = Object.keys(toSet).sort();
  // Names only: secret values are never printed.
  if (secretsSet.length) log(`Set ${secretsSet.length} secret(s): ${secretsSet.join(", ")}.`);
  if (secretsKept.length) log(`Kept existing secret(s): ${secretsKept.sort().join(", ")}.`);

  const deployed = await target.deploy(plan, volume);
  log(deployed);
  return { appCreated, volumeCreated: volume.created, secretsSet, secretsKept, deployed };
}

/** Write fly.toml and its machine_config JSON; returns the fly.toml path. */
export function writeFlyFiles(plan: FlyDeployPlan, outDir: string): { flyToml: string; machineConfig: string } {
  mkdirSync(outDir, { recursive: true });
  const flyToml = join(outDir, "fly.toml");
  const machineConfig = join(outDir, FLY_MACHINE_CONFIG_FILE);
  writeFileSync(flyToml, renderFlyToml(plan));
  writeFileSync(machineConfig, renderFlyMachineConfigJson(plan));
  return { flyToml, machineConfig };
}

export function createFlyctlTarget(backend: FlyctlBackend, outDir: string): FlyDeployTarget {
  return {
    kind: "flyctl",
    async ensureApp(app, org) {
      if (backend.appExists(app)) return false;
      backend.createApp(app, org);
      return true;
    },
    async ensureVolume(app, input) {
      const found = backend.listVolumes(app).find((v) => v.name === input.name && v.region === input.region);
      if (found) return { id: found.id, created: false };
      backend.createVolume(app, input);
      return { created: true };
    },
    async secretNames(app) {
      return backend.listSecretNames(app);
    },
    async setSecrets(app, values) {
      backend.setSecrets(app, values);
    },
    async deploy(plan) {
      const files = writeFlyFiles(plan, outDir);
      backend.deploy({ app: plan.app, configPath: files.flyToml, image: plan.images.app, region: plan.region });
      return `Deployed ${plan.images.app} with flyctl (config: ${files.flyToml}).`;
    },
  };
}

const CONTROL_PLANE_ROLE = "control-plane";

function isControlPlane(machine: FlyMachine): boolean {
  return machine.config?.metadata?.["propr-role"] === CONTROL_PLANE_ROLE;
}

export function createMachinesApiTarget(api: FlyMachinesApi): FlyDeployTarget {
  return {
    kind: "machines-api",
    async ensureApp(app, org) {
      if (await api.appExists(app)) return false;
      await api.createApp(app, org);
      return true;
    },
    async ensureVolume(app, input) {
      const volumes = await api.listVolumes(app);
      const found = volumes.find((v) => v.name === input.name && v.region === input.region && v.state !== "destroyed");
      if (found) return { id: found.id, created: false };
      const created = await api.createVolume(app, input);
      return { id: created.id, created: true };
    },
    async secretNames(app) {
      return api.listSecretNames(app);
    },
    async setSecrets(app, values) {
      await api.setSecrets(app, values);
    },
    async deploy(plan, volume) {
      const ips = await api.ensurePublicIps(plan.app);
      const config = buildMachineConfig(plan, volume.id ?? plan.volumeName);
      const machines = (await api.listMachines(plan.app)).filter(isControlPlane);
      if (machines.length > 1) {
        throw new Error(`app ${plan.app} has ${machines.length} control-plane Machines; one SQLite volume supports exactly one. Destroy the extras first.`);
      }
      const machine = machines[0]
        ? await api.updateMachine(plan.app, machines[0].id, { region: plan.region, config })
        : await api.createMachine(plan.app, { name: `${plan.app}-control-plane`, region: plan.region, config });
      await api.waitForState(plan.app, machine, "started");
      const ipNote = ips.length ? ` Allocated ${ips.join(" and ")}.` : "";
      return `${machines[0] ? "Updated" : "Created"} Machine ${machine.id} running ${plan.images.app}.${ipNote}`;
    },
  };
}
