/**
 * The `propr deploy fly` sequence, independent of how Fly is reached:
 *
 *   0. preflight  a volume over 5 GB is refused when the org that owns (or,
 *                 for a new app, will own) the app is on the Fly Free plan,
 *                 which would reject it (see flyOrgPlan.ts)
 *   1. app        create it in the chosen org unless it exists
 *   2. volume     reuse the named volume in the region, else create it; a
 *                 reused volume smaller than the plan is extended and its new
 *                 size confirmed, and the deploy is sized from that capacity
 *   3. secrets    pin GITHUB_EVENT_INTAKE_MODE to a mode the Machine can run
 *                 (see flyIntake.ts), then upload the given secrets; generated ones (SESSION_SECRET, SYSTEM_TASK_SECRET,
 *                 MCP_ENCRYPTION_KEY; see flyGeneratedSecrets.ts)
 *                 only when the app does not already have them, so a redeploy
 *                 never logs everybody out or rotates encryption keys; a
 *                 GitHub App key left by an earlier deploy stays wired into
 *                 the Machine (key file + GH_PRIVATE_KEY_PATH); with idle
 *                 shutdown, the app-scoped token the Machine stops itself
 *                 with, created once (flyctl) unless given or already set
 *   4. deploy     the published app image directly (no build, no DinD);
 *                 the app container lists every secret name (set now or
 *                 kept), since a multi-container Machine passes app secrets
 *                 only to the containers that list them. With flyctl, config
 *                 keys an earlier layout left on the Machine are cleared, or
 *                 the Machine is replaced with the volume kept
 *                 (flyStaleMachineConfig.ts)
 *
 * Two targets implement the steps: flyctl (when installed) and the Machines
 * API with a user-provided token. Both are idempotent, so re-running the
 * command updates the existing deployment in place.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FlyctlBackend, type FlyctlMachine } from "./flyctlBackend.js";
import { selectFlyIntakeMode } from "./flyIntake.js";
import { flyAuthorizationHeader, FlyMachinesApi, type FlyMachine } from "./flyMachinesApi.js";
import { staleMachineConfigKeys, type LiveMachineConfig } from "./flyStaleMachineConfig.js";
import { assertVolumeFitsFlyPlan, exceedsFreePlanVolumeCap, fetchFlyOrgPlan, FLY_FREE_PLAN_MAX_VOLUME_GB, type FlyOrgPlan } from "./flyOrgPlan.js";
import {
  buildMachineConfig,
  FLY_CONTROL_PLANE_ROLE,
  FLY_CONTROL_PLANE_ROLE_KEY,
  FLY_GH_PRIVATE_KEY_SECRET,
  FLY_MACHINE_CONFIG_FILE,
  FLY_MACHINE_STOP_TOKEN_SECRET,
  renderFlyMachineConfigJson,
  renderFlyToml,
  type FlyDeployPlan,
} from "./flyMachineConfig.js";

export interface FlyDeployTarget {
  readonly kind: "flyctl" | "machines-api";
  /** The org's Fly plan; "unknown" when it cannot be read. Read only, never creates anything. */
  orgPlan(org: string): Promise<FlyOrgPlan>;
  /**
   * Whether the app exists and, if Fly says, the org that owns it. Read only:
   * an existing app's resources belong to its own org, not to `--org`.
   */
  appOwner(app: string): Promise<{ exists: boolean; org?: string }>;
  ensureApp(app: string, org: string): Promise<boolean>;
  ensureVolume(app: string, input: { name: string; region: string; sizeGb: number }): Promise<FlyVolumeRef>;
  /** Grow a volume (Fly volumes never shrink); resolves to the size Fly reports afterwards. */
  extendVolume(app: string, volumeId: string, sizeGb: number): Promise<number>;
  secretNames(app: string): Promise<string[]>;
  setSecrets(app: string, values: Record<string, string>): Promise<void>;
  deploy(plan: FlyDeployPlan, volume: { id?: string }, log?: (line: string) => void): Promise<string>;
  /** An app-scoped token for the Machine to stop itself with when idle; rejects when the target cannot create one. */
  createMachineStopToken(app: string): Promise<string>;
}

export interface FlyVolumeRef {
  id?: string;
  created: boolean;
  /** Capacity Fly reports for the volume; NaN when it could not be read. */
  sizeGb: number;
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
  /** Confirmed capacity of the data volume the deployment was sized for. */
  volumeSizeGb: number;
  deployed: string;
}

/**
 * Make sure the data volume really has the plan's capacity. Reuse matches by
 * name and region only, so a volume from an earlier, smaller deploy (1 GB by
 * default) would otherwise back a legacy Docker filesystem sized for 20 GB and
 * run SQLite and Redis out of space. Runs before any secret is uploaded.
 */
async function confirmVolumeCapacity(
  plan: FlyDeployPlan,
  volume: FlyVolumeRef,
  target: FlyDeployTarget,
  log: (line: string) => void,
): Promise<number> {
  const required = plan.volumeSizeGb;
  const extendHint = `extend it with \`fly volumes extend ${volume.id ?? "<volume id>"} --size ${required} --app ${plan.app}\` and rerun`;
  if (!Number.isFinite(volume.sizeGb)) {
    throw new Error(`could not read the size of volume ${plan.volumeName} in ${plan.region}; the deployment needs ${required} GB. Check it with \`fly volumes list --app ${plan.app}\`.`);
  }
  if (volume.sizeGb >= required) return volume.sizeGb;
  if (!volume.id) throw new Error(`volume ${plan.volumeName} is ${volume.sizeGb} GB but the deployment needs ${required} GB; ${extendHint}`);
  log(`Volume ${plan.volumeName} is ${volume.sizeGb} GB; extending it to ${required} GB.`);
  const extended = await target.extendVolume(plan.app, volume.id, required);
  if (!Number.isFinite(extended) || extended < required) {
    throw new Error(`volume ${plan.volumeName} still reports ${Number.isFinite(extended) ? `${extended} GB` : "an unknown size"} after extending to ${required} GB; ${extendHint}`);
  }
  log(`Volume ${plan.volumeName} is now ${extended} GB.`);
  return extended;
}

/**
 * Before anything is created: a volume Fly would reject on the Free plan
 * stops the deploy here rather than at `volumes create`/`extend`. Only a
 * volume over the cap needs the lookup; an unreadable plan does not block.
 * The plan checked is that of the org owning the volume: an existing app's
 * own org (`--org` only names where a new app is created), else `--org`.
 */
async function preflightFlyPlan(plan: FlyDeployPlan, target: FlyDeployTarget, log: (line: string) => void): Promise<void> {
  if (!exceedsFreePlanVolumeCap(plan)) return;
  const owner = await target.appOwner(plan.app);
  const org = owner.exists ? owner.org : plan.org;
  if (!org) {
    log(`Could not read the org of app ${plan.app}; on the Free plan Fly rejects volumes over ${FLY_FREE_PLAN_MAX_VOLUME_GB} GB.`);
    return;
  }
  const orgPlan = await target.orgPlan(org);
  assertVolumeFitsFlyPlan({ org, volumeSizeGb: plan.volumeSizeGb }, orgPlan);
  if (orgPlan === "unknown") {
    log(`Could not read the Fly plan of org ${org}; on the Free plan Fly rejects volumes over ${FLY_FREE_PLAN_MAX_VOLUME_GB} GB.`);
  }
}

export async function runFlyDeploy(
  input: FlyDeployInput,
  target: FlyDeployTarget,
  log: (line: string) => void = () => {},
): Promise<FlyDeployResult> {
  const { plan } = input;
  log(`Using ${target.kind === "flyctl" ? "flyctl" : "the Fly Machines API"}.`);
  await preflightFlyPlan(plan, target, log);

  const appCreated = await target.ensureApp(plan.app, plan.org);
  log(appCreated ? `Created app ${plan.app} in org ${plan.org}.` : `App ${plan.app} already exists.`);

  const volume = await target.ensureVolume(plan.app, { name: plan.volumeName, region: plan.region, sizeGb: plan.volumeSizeGb });
  log(volume.created
    ? `Created ${plan.volumeSizeGb} GB volume ${plan.volumeName} in ${plan.region}.`
    : `Reusing volume ${plan.volumeName} in ${plan.region}.`);
  const volumeSizeGb = await confirmVolumeCapacity(plan, volume, target, log);

  const existing = new Set(await target.secretNames(plan.app));
  const toSet: Record<string, string> = { ...input.secrets };
  // The container must write the GitHub App key file and point
  // GH_PRIVATE_KEY_PATH at it whenever the app has the key secret, or
  // GH_AUTH_MODE=app has no key to sign with: the key this run uploads (from a
  // key file or a base64 value in the stack .env) counts, and so does one left
  // by an earlier deploy, since Fly secrets are never removed.
  const uploadsKey = plan.githubAppKey || Boolean(toSet[FLY_GH_PRIVATE_KEY_SECRET]);
  const githubAppKey = uploadsKey || existing.has(FLY_GH_PRIVATE_KEY_SECRET);
  if (githubAppKey && !uploadsKey) log("Keeping the GitHub App private key from an earlier deploy.");
  // Pin an event intake mode the daemon can start with (or stop here, before
  // any secret is uploaded): unset means routing_websocket, which crashes the
  // Machine without a relay token.
  const intake = selectFlyIntakeMode(toSet, existing);
  Object.assign(toSet, intake.secrets);
  log(intake.summary);
  const secretsKept: string[] = [];
  if (plan.idleShutdownAfter) {
    if (toSet[FLY_MACHINE_STOP_TOKEN_SECRET]) {
      // Given with --machine-stop-token.
    } else if (existing.has(FLY_MACHINE_STOP_TOKEN_SECRET)) {
      secretsKept.push(FLY_MACHINE_STOP_TOKEN_SECRET);
    } else {
      toSet[FLY_MACHINE_STOP_TOKEN_SECRET] = await target.createMachineStopToken(plan.app);
      log(`Created an app-scoped deploy token for the Machine to stop itself when idle (secret ${FLY_MACHINE_STOP_TOKEN_SECRET}).`);
    }
  }
  for (const [name, value] of Object.entries(input.generatedSecrets)) {
    if (existing.has(name) || name in toSet) secretsKept.push(name);
    else toSet[name] = value;
  }
  // Size everything carved out of the volume (the legacy Docker filesystem)
  // from its confirmed capacity. Containers in a multi-container Machine see
  // only the secrets they list, so list every secret the app will have,
  // including ones left by earlier deploys (Fly never removes them).
  const deployPlan: FlyDeployPlan = {
    ...plan, volumeSizeGb, githubAppKey, secretNames: [...new Set([...existing, ...Object.keys(toSet)])].sort(),
  };
  await target.setSecrets(plan.app, toSet);
  const secretsSet = Object.keys(toSet).sort();
  // Names only: secret values are never printed.
  if (secretsSet.length) log(`Set ${secretsSet.length} secret(s): ${secretsSet.join(", ")}.`);
  if (secretsKept.length) log(`Kept existing secret(s): ${secretsKept.sort().join(", ")}.`);

  const deployed = await target.deploy(deployPlan, volume, log);
  log(deployed);
  return { appCreated, volumeCreated: volume.created, secretsSet, secretsKept, volumeSizeGb, deployed };
}

/**
 * Write fly.toml and its machine_config JSON; returns both paths. fly.toml
 * points at the JSON by absolute path: flyctl resolves machine_config against
 * its working directory, not against the config file, so a relative name
 * breaks `fly deploy --config <out>/fly.toml` run from anywhere else.
 */
export function writeFlyFiles(plan: FlyDeployPlan, outDir: string): { flyToml: string; machineConfig: string } {
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });
  const flyToml = join(dir, "fly.toml");
  const machineConfig = join(dir, FLY_MACHINE_CONFIG_FILE);
  writeFileSync(flyToml, renderFlyToml(plan, machineConfig));
  writeFileSync(machineConfig, renderFlyMachineConfigJson(plan));
  return { flyToml, machineConfig };
}

export interface FlyctlTargetOptions {
  /** How long to wait for a replaced Machine's volume to detach. */
  detachTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The control-plane Machine among flyctl's list, if any (see isControlPlane). */
function flyctlControlPlane(backend: FlyctlBackend, app: string, volumeId?: string): FlyctlMachine | undefined {
  const machines = backend.listMachines(app).filter((m) => isControlPlane(m, volumeId));
  if (machines.length > 1) {
    throw new Error(`app ${app} has ${machines.length} control-plane Machines; one SQLite volume supports exactly one. Destroy the extras first.`);
  }
  return machines[0];
}

/**
 * `fly deploy`, then make sure the Machine has no `volumes` or container
 * `mounts` the plan dropped. flyctl merges machine_config into the live
 * config; the JSON sends `[]` for those keys, which clears them, and if any
 * survive anyway the Machine is destroyed and deployed again. The volume is
 * kept: the new Machine is only created once the old one has released it, so
 * flyctl attaches the existing volume instead of creating an empty one.
 */
async function deployFlyctlWithoutStaleKeys(
  backend: FlyctlBackend,
  plan: FlyDeployPlan,
  volume: { id?: string },
  files: { flyToml: string; machineConfig: string },
  log: (line: string) => void,
  options: FlyctlTargetOptions,
): Promise<boolean> {
  const planned = JSON.parse(readFileSync(files.machineConfig, "utf-8")) as LiveMachineConfig;
  const run = () => backend.deploy({ app: plan.app, configPath: files.flyToml, image: plan.images.app, region: plan.region });
  const before = flyctlControlPlane(backend, plan.app, volume.id);
  const staleBefore = staleMachineConfigKeys(before?.config, planned);
  if (before && staleBefore.length) log(`Machine ${before.id} has config the new layout drops: ${staleBefore.join("; ")}. Clearing it.`);
  run();
  const after = flyctlControlPlane(backend, plan.app, volume.id);
  const stale = staleMachineConfigKeys(after?.config, planned);
  if (!after || !stale.length) return false;

  log(`flyctl kept ${stale.join("; ")} on Machine ${after.id}; replacing the Machine (volume ${plan.volumeName} is kept).`);
  backend.destroyMachine(plan.app, after.id);
  await waitForVolumeDetached(backend, plan, volume.id, after.id, options);
  run();
  const replaced = flyctlControlPlane(backend, plan.app, volume.id);
  const left = staleMachineConfigKeys(replaced?.config, planned);
  if (left.length) {
    throw new Error(`Machine ${replaced?.id ?? "?"} still has ${left.join("; ")} after being replaced; check \`fly machine status ${replaced?.id ?? "<machine-id>"} --app ${plan.app} --display-config\`.`);
  }
  return true;
}

async function waitForVolumeDetached(
  backend: FlyctlBackend,
  plan: FlyDeployPlan,
  volumeId: string | undefined,
  machineId: string,
  options: FlyctlTargetOptions,
): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const deadline = Date.now() + (options.detachTimeoutMs ?? 120_000);
  for (;;) {
    const found = backend.listVolumes(plan.app).find((v) => (volumeId ? v.id === volumeId : v.name === plan.volumeName && v.region === plan.region));
    if (found && found.attachedMachineId !== machineId) return;
    if (Date.now() >= deadline) {
      throw new Error(`volume ${plan.volumeName} is still ${found ? `attached to destroyed Machine ${machineId}` : "missing"}; check \`fly volumes list --app ${plan.app}\` and rerun.`);
    }
    await sleep(2000);
  }
}

export function createFlyctlTarget(
  backend: FlyctlBackend,
  outDir: string,
  fetchImpl: typeof fetch = fetch,
  options: FlyctlTargetOptions = {},
): FlyDeployTarget {
  return {
    kind: "flyctl",
    async orgPlan(org) {
      // `fly auth token` prints the token flyctl uses, FLY_API_TOKEN included.
      const token = backend.authToken();
      return token ? fetchFlyOrgPlan(flyAuthorizationHeader(token), org, fetchImpl) : "unknown";
    },
    async appOwner(app) {
      return backend.appOwner(app);
    },
    async ensureApp(app, org) {
      if (backend.appExists(app)) return false;
      backend.createApp(app, org);
      return true;
    },
    async ensureVolume(app, input) {
      const found = backend.listVolumes(app).find((v) => v.name === input.name && v.region === input.region);
      if (found) return { id: found.id, created: false, sizeGb: found.sizeGb };
      backend.createVolume(app, input);
      return { created: true, sizeGb: input.sizeGb };
    },
    async extendVolume(app, volumeId, sizeGb) {
      backend.extendVolume(app, volumeId, sizeGb);
      // Confirm from Fly rather than trusting the request.
      return backend.listVolumes(app).find((v) => v.id === volumeId)?.sizeGb ?? Number.NaN;
    },
    async secretNames(app) {
      return backend.listSecretNames(app);
    },
    async setSecrets(app, values) {
      backend.setSecrets(app, values);
    },
    async deploy(plan, volume, log = () => {}) {
      const files = writeFlyFiles(plan, outDir);
      const replaced = await deployFlyctlWithoutStaleKeys(backend, plan, volume, files, log, options);
      return `${replaced ? "Replaced the Machine and deployed" : "Deployed"} ${plan.images.app} with flyctl (config: ${files.flyToml}).`;
    },
    async createMachineStopToken(app) {
      return backend.createDeployToken(app, "propr idle stop");
    },
  };
}

/**
 * The control-plane Machine carries the role metadata (both backends write it)
 * or, whatever created it, already has the deployment's data volume attached:
 * a second Machine could never mount that volume, so it must be updated.
 */
function isControlPlane(machine: Pick<FlyMachine, "config">, volumeId?: string): boolean {
  if (machine.config?.metadata?.[FLY_CONTROL_PLANE_ROLE_KEY] === FLY_CONTROL_PLANE_ROLE) return true;
  return !!volumeId && (machine.config?.mounts ?? []).some((m) => m.volume === volumeId);
}

function volumeSize(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

export function createMachinesApiTarget(api: FlyMachinesApi): FlyDeployTarget {
  return {
    kind: "machines-api",
    async orgPlan(org) {
      return api.orgPlan(org);
    },
    async appOwner(app) {
      return api.appOwner(app);
    },
    async ensureApp(app, org) {
      if (await api.appExists(app)) return false;
      await api.createApp(app, org);
      return true;
    },
    async ensureVolume(app, input) {
      const volumes = await api.listVolumes(app);
      const found = volumes.find((v) => v.name === input.name && v.region === input.region && v.state !== "destroyed");
      if (found) return { id: found.id, created: false, sizeGb: volumeSize(found.size_gb) };
      const created = await api.createVolume(app, input);
      return { id: created.id, created: true, sizeGb: volumeSize(created.size_gb ?? input.sizeGb) };
    },
    async extendVolume(app, volumeId, sizeGb) {
      await api.extendVolume(app, volumeId, sizeGb);
      // Confirm from Fly rather than trusting the request or the extend response.
      return volumeSize((await api.listVolumes(app)).find((v) => v.id === volumeId)?.size_gb);
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
      const machines = (await api.listMachines(plan.app)).filter((m) => isControlPlane(m, volume.id));
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
    async createMachineStopToken(app) {
      // The Machines API has no token endpoint, and the deploy token given here may be org-wide: never store that one.
      throw new Error(
        `--idle-shutdown needs an app-scoped token for the Machine to stop itself when idle. Create one with \`fly tokens create deploy --app ${app}\` `
          + "and pass it with --machine-stop-token, or install flyctl so the deploy creates it. An app exit alone would leave Redis keeping the Machine started.",
      );
    },
  };
}
