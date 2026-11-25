/**
 * Pure builders for `propr deploy fly`: the Fly Machine configuration that
 * runs the slim control plane (the all-in-one app container plus Redis in the
 * SAME Machine), rendered either as a Machines API `config` object or as the
 * `fly.toml` + `machine_config` JSON pair that `flyctl deploy` consumes.
 *
 * Nothing here talks to Fly; the API and flyctl backends only ship what these
 * functions return, so the whole layout is pinned by unit tests.
 *
 * Layout (one Machine, multi-container):
 *   app      propr/app running `node dist/src/allInOne.js` (daemon + worker +
 *            API + same-origin UI). Listens on 0.0.0.0:4000 for the Fly proxy.
 *   redis    redis:7-alpine bound to 127.0.0.1, AOF on the volume.
 *   tunnel   optional cloudflared sidecar when ProPR Connect is enrolled.
 *   docker   optional legacy Docker daemon (see flyLegacyDocker.ts).
 *
 * The Fly volume is mounted at /usr/src/app/data, the same path the local
 * stack bind-mounts, so SQLite and the Redis append-only file both persist.
 * Legacy mode keeps Docker images on a persistent root filesystem instead.
 */

import { Buffer } from "node:buffer";
import {
  buildLegacyDockerContainer,
  legacyDockerDiskSizeGb,
  LEGACY_DOCKER_DEFAULT_ROOTFS_GB,
  LEGACY_DOCKER_SHARED_ENV,
} from "./flyLegacyDocker.js";

export const FLY_DATA_PATH = "/usr/src/app/data";
export const FLY_DB_FILENAME = `${FLY_DATA_PATH}/propr.sqlite`;
export const FLY_REDIS_DIR = `${FLY_DATA_PATH}/redis`;
export const FLY_API_PORT = 4000;
export const FLY_REDIS_PORT = 6379;
// Keep the secret file on the container root filesystem; Pilot mounts tmpfs at /run.
export const FLY_GH_PRIVATE_KEY_PATH = "/etc/propr/github-app.pem";
/** Secret holding the base64 GitHub App private key, written to FLY_GH_PRIVATE_KEY_PATH. */
export const FLY_GH_PRIVATE_KEY_SECRET = "PROPR_GH_PRIVATE_KEY_B64";

/**
 * Secret holding the app-scoped token the Machine stops itself with when idle
 * (#3770). Read by the app image (src/flyMachineStop.ts): in a multi-container
 * Machine an app exit leaves Redis running, so only a Machines API stop of the
 * whole Machine lets it reach `stopped`, which the Fly proxy can start again.
 */
export const FLY_MACHINE_STOP_TOKEN_SECRET = "PROPR_FLY_MACHINE_STOP_TOKEN";

/**
 * Fly proxy connections reach the Machine from its private 172.16.0.0/12
 * gateway range; trusting it lets the API read the real client IP and HTTPS
 * scheme. Public traffic can only arrive through that proxy.
 */
export const FLY_PROXY_PEERS = "172.16.0.0/12";

export const FLY_DEFAULTS = {
  org: "personal",
  region: "iad",
  cpuKind: "shared",
  cpus: 1,
  memoryMb: 1024,
  volumeName: "propr_data",
  volumeSizeGb: 1,
  idleShutdownAfter: "15m",
} as const;

export type FlyAgentRuntime = "sprites" | "fly-machines" | "docker";
export const FLY_AGENT_RUNTIMES: readonly FlyAgentRuntime[] = ["sprites", "fly-machines", "docker"];

export interface FlyTunnelSettings {
  instanceId: string;
  publicUrl: string;
}

export interface FlyDeployPlan {
  app: string;
  org: string;
  region: string;
  images: { app: string; redis: string; cloudflared: string };
  cpuKind: string;
  cpus: number;
  memoryMb: number;
  volumeName: string;
  volumeSizeGb: number;
  agentRuntime: FlyAgentRuntime;
  /**
   * Opt-in idle shutdown (#3770); undefined keeps the Machine always on. When
   * idle, the app stops the whole Machine with the FLY_MACHINE_STOP_TOKEN_SECRET
   * token (gated by FLY_IDLE_SHUTDOWN_SUPPORTED in deployFly.ts).
   */
  idleShutdownAfter?: string;
  /** Hosted UI tunnel through ProPR Connect; undefined serves on <app>.fly.dev only. */
  tunnel?: FlyTunnelSettings;
  /** Run a Docker daemon in the Machine for Docker agents (legacy mode). */
  legacyDocker: boolean;
  /**
   * Legacy mode only: size of the Machine's persistent root filesystem, which
   * holds the Docker image store (see flyLegacyDocker.ts). Defaults to
   * LEGACY_DOCKER_DEFAULT_ROOTFS_GB.
   */
  rootfsSizeGb?: number;
  /** A GitHub App private key was supplied (as the FLY_GH_PRIVATE_KEY_SECRET secret). */
  githubAppKey: boolean;
  /** Extra plain (non-secret) env for the app container. */
  extraEnv?: Record<string, string>;
  /**
   * Names of every Fly app secret the Machine should see: the ones this run
   * sets and the ones earlier deploys left. In a multi-container Machine Fly
   * passes app secrets only to containers that list them, so the app
   * container (and the tunnel, for TUNNEL_TOKEN) gets them by name.
   */
  secretNames?: readonly string[];
}

/** The Machine's public origin through the Fly proxy. */
export function flyPublicUrl(app: string): string {
  return `https://${app}.fly.dev`;
}

/** Fly app names: lowercase letters, digits and dashes, 2–63 chars, not starting/ending with a dash. */
export function validateFlyAppName(name: string): string | null {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/.test(name)) {
    return `Fly app name "${name}" must be 2-63 lowercase letters, digits or dashes, and must not start or end with a dash`;
  }
  return null;
}

/** Fly volume names: lowercase letters, digits and underscores, at most 30 chars. */
export function validateFlyVolumeName(name: string): string | null {
  if (!/^[a-z0-9_]{1,30}$/.test(name)) {
    return `Fly volume name "${name}" must be 1-30 lowercase letters, digits or underscores`;
  }
  return null;
}

/**
 * Plain environment for the app container. Secrets (session secret, GitHub
 * credentials, agent keys, tunnel token) are set as Fly app secrets instead
 * and never appear here or in generated files.
 */
export function buildAppEnv(plan: FlyDeployPlan): Record<string, string> {
  const publicUrl = plan.tunnel?.publicUrl ?? flyPublicUrl(plan.app);
  const env: Record<string, string> = {
    NODE_ENV: "production",
    PROPR_CONTAINERIZED: "1",
    PROPR_PROFILE: "minimal",
    PROPR_INDEXING: "inline",
    PROPR_SERVE_UI: "1",
    PROPR_SERVED_UI_API_URL: "",
    DASHBOARD_API_PORT: String(FLY_API_PORT),
    REDIS_HOST: "127.0.0.1",
    REDIS_PORT: String(FLY_REDIS_PORT),
    SESSION_REDIS_HOST: "127.0.0.1",
    // The session store reads SESSION_REDIS_PORT before REDIS_PORT; pin it to
    // the in-Machine Redis so a stack .env override cannot redirect sessions.
    SESSION_REDIS_PORT: String(FLY_REDIS_PORT),
    DB_FILENAME: FLY_DB_FILENAME,
    DATA_DIR: FLY_DATA_PATH,
    CONFIG_REPO_PATH: "/tmp/config_repo",
    API_PUBLIC_URL: publicUrl,
    FRONTEND_URL: publicUrl,
    GH_OAUTH_CALLBACK_URL: `${publicUrl}/api/auth/github/callback`,
    PROPR_TRUSTED_PROXY_PEERS: FLY_PROXY_PEERS,
    PROPR_AGENT_RUNTIME: plan.agentRuntime,
  };
  if (plan.agentRuntime === "sprites") env.SPRITES_CLIENT_SIGNALS = "0";
  if (plan.tunnel) {
    // Same derivation as `propr tunnel setup`: the hosted UI drives this
    // instance through https://t-<id>.propr.dev. cloudflared reaches the API
    // over loopback, so loopback joins the trusted proxy peers.
    env.PROPR_UI_TUNNEL_ENABLED = "true";
    env.PROPR_INSTANCE_ID = plan.tunnel.instanceId;
    env.PROPR_UI_PUBLIC_API_URL = plan.tunnel.publicUrl;
    env.FRONTEND_URL = "https://app.propr.dev";
    env.PROPR_WEB_AUTH_MODE = "connect";
    env.PROPR_TRUSTED_PROXY_PEERS = `loopback,${FLY_PROXY_PEERS}`;
  }
  if (plan.githubAppKey) env.GH_PRIVATE_KEY_PATH = FLY_GH_PRIVATE_KEY_PATH;
  if (plan.idleShutdownAfter) {
    env.PROPR_IDLE_SHUTDOWN = "on";
    env.PROPR_IDLE_SHUTDOWN_AFTER = plan.idleShutdownAfter;
  }
  if (plan.legacyDocker) Object.assign(env, LEGACY_DOCKER_SHARED_ENV);
  return { ...env, ...(plan.extraEnv ?? {}) };
}

/**
 * Every key {@link buildAppEnv} can set, across all plan variants (tunnel,
 * GitHub App key, idle shutdown, legacy Docker, Sprites). Derived rather than
 * listed so a setting the builder owns can never be overridden by a stack .env
 * value uploaded as a Fly secret.
 */
function generatedAppEnvKeys(): string[] {
  const variants: FlyDeployPlan[] = FLY_AGENT_RUNTIMES.map((agentRuntime) => ({
    app: "propr", org: "personal", region: "iad", images: { app: "", redis: "", cloudflared: "" },
    cpuKind: "shared", cpus: 1, memoryMb: 1024, volumeName: "propr_data", volumeSizeGb: 1, agentRuntime,
    idleShutdownAfter: FLY_DEFAULTS.idleShutdownAfter, tunnel: { instanceId: "i", publicUrl: "https://t-i.propr.dev" },
    legacyDocker: true, githubAppKey: true,
  }));
  return variants.flatMap((plan) => Object.keys(buildAppEnv(plan)));
}

/** Keys the deploy owns; a stack .env value for one of these is never uploaded. */
export const FLY_MANAGED_ENV_KEYS: ReadonlySet<string> = new Set([
  ...generatedAppEnvKeys(),
  // Host/stack-only settings the Machine does not use or derives itself.
  "PROPR_UI_DIST_DIR", "DASHBOARD_API_HOST", "API_PORT", "UI_PORT", "DOCS_PORT", "REDIS_EXTERNAL_PORT",
  "PROPR_DATA_DIR", "PROPR_DATA_MOUNT", "PROPR_LOGS_DIR", "PROPR_REPOS_DIR", "PROPR_ENV_FILE", "PROPR_ROOT",
  "PROPR_STACK", "PROPR_CLOUDFLARED_IMAGE", "STAGING_ENV_FILE",
  // Created for this app by the deploy (or given with --machine-stop-token), never copied from a stack .env.
  FLY_MACHINE_STOP_TOKEN_SECRET,
]);

/**
 * Select the stack .env entries to upload as Fly secrets: everything that is
 * set, except host-only paths (HOST_*) and the keys the deploy manages itself.
 */
export function selectEnvFileSecrets(values: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === "" || key.startsWith("HOST_") || FLY_MANAGED_ENV_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export type JsonObject = Record<string, unknown>;

/** Secret the cloudflared sidecar reads its connector token from. */
export const FLY_TUNNEL_TOKEN_SECRET = "TUNNEL_TOKEN";

/** `secrets` entries exposing Fly app secrets as same-named env vars in one container. */
export function containerSecrets(names: Iterable<string>): Array<{ env_var: string; name: string }> {
  return [...new Set(names)].sort().map((name) => ({ env_var: name, name }));
}

/** Redis: loopback only, append-only file on the volume, never evict BullMQ keys. */
export function buildRedisContainer(redisImage: string): JsonObject {
  return {
    name: "redis",
    image: redisImage,
    cmd: [
      "sh", "-c",
      `mkdir -p ${FLY_REDIS_DIR} && exec redis-server --bind 127.0.0.1 --port ${FLY_REDIS_PORT} --dir ${FLY_REDIS_DIR} `
        + "--appendonly yes --save 300 1 --maxmemory-policy noeviction",
    ],
    healthchecks: [{ name: "redis", exec: { command: ["redis-cli", "-h", "127.0.0.1", "ping"] }, interval: 10, timeout: 5, grace_period: 5 }],
    restart: { policy: "always" },
  };
}

function buildAppContainer(plan: FlyDeployPlan, image: string): JsonObject {
  const container: JsonObject = {
    name: "app",
    image,
    cmd: ["node", "dist/src/allInOne.js"],
    env: buildAppEnv(plan),
    // Never gated on the legacy docker container: dockerd took ~34 s to listen
    // after a wake from an idle stop, and Fly's proxy fails the waking request
    // with 503 after ~45 s with nothing on port 4000. The API starts at once;
    // the worker waits for the Docker API itself (PROPR_DOCKER_STARTUP_WAIT_SECONDS).
    depends_on: [{ name: "redis", condition: "healthy" }],
    secrets: containerSecrets(plan.secretNames ?? []),
    healthchecks: [{
      name: "api", http: { port: FLY_API_PORT, method: "GET", path: "/health" },
      interval: 15, timeout: 5, grace_period: 60,
    }],
  };
  // A stop the Machines API did not accept exits 1 (src/allInOneConfig.ts):
  // the app must start again rather than leave Redis keeping a dead Machine up.
  if (plan.idleShutdownAfter) container.restart = { policy: "on-failure", max_retries: 10 };
  if (plan.githubAppKey) {
    container.files = [{ guest_path: FLY_GH_PRIVATE_KEY_PATH, secret_name: FLY_GH_PRIVATE_KEY_SECRET, mode: 0o400 }];
  }
  return container;
}

/**
 * cloudflared dials out to Cloudflare with TUNNEL_TOKEN (a Fly secret). The
 * Connect-managed ingress targets http://api:4000, so `api` resolves to the
 * Machine's shared loopback where the app container listens.
 */
function buildTunnelContainer(image: string, secretNames: readonly string[]): JsonObject {
  const hosts = "127.0.0.1 localhost api\n::1 localhost\n";
  return {
    name: "tunnel",
    image,
    cmd: ["tunnel", "--no-autoupdate", "run"],
    secrets: containerSecrets(secretNames.filter((name) => name === FLY_TUNNEL_TOKEN_SECRET)),
    files: [{ guest_path: "/etc/hosts", raw_value: Buffer.from(hosts).toString("base64") }],
    depends_on: [{ name: "app", condition: "started" }],
    restart: { policy: "always" },
  };
}

/** Multi-container list. `appImage` lets flyctl substitute the image it deploys. */
export function buildContainers(plan: FlyDeployPlan, appImage: string = plan.images.app): JsonObject[] {
  const containers = [buildRedisContainer(plan.images.redis)];
  if (plan.legacyDocker) containers.push(buildLegacyDockerContainer(legacyDockerDiskSizeGb(legacyRootfsSizeGb(plan))));
  containers.push(buildAppContainer(plan, appImage));
  if (plan.tunnel) containers.push(buildTunnelContainer(plan.images.cloudflared, plan.secretNames ?? []));
  return containers;
}

/**
 * Always on: restart always, never stopped by the proxy. Idle shutdown (#3770):
 * ProPR stops the whole Machine through the Machines API when idle and then
 * exits 0, so restart only on failure and let an HTTP request (UI, API, MCP,
 * webhook or the Connect `/wake` ping) start the stopped Machine again. An
 * exit 0 alone would not stop it: Redis keeps a multi-container Machine started.
 * Fly's traffic-based autostop stays off either way: it would stop the Machine
 * in the middle of an agent run that has no HTTP traffic.
 */
export function restartPolicy(plan: FlyDeployPlan): "always" | "on-failure" {
  return plan.idleShutdownAfter ? "on-failure" : "always";
}

export function buildHttpService(plan: FlyDeployPlan): JsonObject {
  return {
    protocol: "tcp",
    internal_port: FLY_API_PORT,
    autostop: "off",
    autostart: true,
    min_machines_running: plan.idleShutdownAfter ? 0 : 1,
    ports: [
      { port: 80, handlers: ["http"], force_https: true },
      { port: 443, handlers: ["tls", "http"] },
    ],
    checks: [{ type: "http", port: FLY_API_PORT, method: "GET", path: "/health", interval: "30s", timeout: "5s", grace_period: "60s" }],
  };
}

/** The Machines API `config` (POST /v1/apps/{app}/machines). */
export function buildMachineConfig(plan: FlyDeployPlan, volume: string = plan.volumeName): JsonObject {
  const config: JsonObject = {
    guest: { cpu_kind: plan.cpuKind, cpus: plan.cpus, memory_mb: plan.memoryMb },
    containers: buildContainers(plan),
    mounts: [{ volume, path: FLY_DATA_PATH }],
    services: [buildHttpService(plan)],
    restart: { policy: restartPolicy(plan), ...(plan.idleShutdownAfter ? { max_retries: 10 } : {}) },
    // allInOne drains on SIGTERM; give it time to finish acks and close SQLite.
    stop_config: { signal: "SIGTERM", timeout: "60s" },
    metadata: buildMachineMetadata(),
  };
  if (plan.legacyDocker) Object.assign(config, buildLegacyDockerMachineFields(plan));
  return config;
}

/** Metadata key/value that identifies the control-plane Machine on both backends. */
export const FLY_CONTROL_PLANE_ROLE_KEY = "propr-role";
export const FLY_CONTROL_PLANE_ROLE = "control-plane";

/**
 * Machine metadata shared by the Machines API config and the flyctl
 * machine_config JSON, so a Machine created by one backend is recognised and
 * updated in place by the other. `fly_platform_version`/`fly_process_group`
 * are what flyctl uses to treat a Machine as part of the app's `app` group.
 */
export function buildMachineMetadata(): Record<string, string> {
  return {
    [FLY_CONTROL_PLANE_ROLE_KEY]: FLY_CONTROL_PLANE_ROLE,
    fly_platform_version: "v2",
    fly_process_group: "app",
  };
}

/** The persistent rootfs size of a legacy plan. */
export function legacyRootfsSizeGb(plan: Pick<FlyDeployPlan, "rootfsSizeGb">): number {
  return plan.rootfsSizeGb ?? LEGACY_DOCKER_DEFAULT_ROOTFS_GB;
}

/**
 * Fly's `rootfs.persist` value for legacy mode. The Machine config field is a
 * string ("never", "always" or "restart", as in `fly machine run
 * --rootfs-persist`); flyctl rejects a boolean with "cannot unmarshal bool into
 * Go value of type string".
 */
export const LEGACY_DOCKER_ROOTFS_PERSIST = "always";

/**
 * Machine-level legacy fields: a persistent root filesystem for the Docker
 * image store, so Docker images stay off the Fly volume (capped at 5 GB on the
 * Free plan) and survive restarts. There is no `volumes`/`temp_dir` entry: the
 * directory both containers share is on the Fly volume (LEGACY_DOCKER_SHARED_DIR
 * in flyLegacyDocker.ts), because a `temp_dir` volume did not mount in this
 * multi-container Machine.
 */
function buildLegacyDockerMachineFields(plan: Pick<FlyDeployPlan, "rootfsSizeGb">): JsonObject {
  return {
    rootfs: { size_gb: legacyRootfsSizeGb(plan), persist: LEGACY_DOCKER_ROOTFS_PERSIST },
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Size label for `[[vm]]`, e.g. shared-cpu-1x. */
export function vmSizeLabel(plan: FlyDeployPlan): string {
  return `${plan.cpuKind === "performance" ? "performance" : "shared"}-cpu-${plan.cpus}x`;
}

export const FLY_MACHINE_CONFIG_FILE = "propr-machine.json";

/**
 * fly.toml for `flyctl deploy`. The containers live in the machine_config JSON
 * (flyctl >= 0.3.147); `container = "app"` tells flyctl which one receives the
 * deployed image. flyctl resolves a relative `machineConfigPath` against its
 * working directory, so the written file uses an absolute one (writeFlyFiles).
 * Only non-secret values are written.
 */
export function renderFlyToml(plan: FlyDeployPlan, machineConfigPath: string = FLY_MACHINE_CONFIG_FILE): string {
  const lines = [
    "# Generated by `propr deploy fly`. Secrets are Fly app secrets, never in this file.",
    `app = ${tomlString(plan.app)}`,
    `primary_region = ${tomlString(plan.region)}`,
    "",
    "[build]",
    `  image = ${tomlString(plan.images.app)}`,
    "",
    "[experimental]",
    `  machine_config = ${tomlString(machineConfigPath)}`,
    "  container = \"app\"",
    "",
    "[[mounts]]",
    `  source = ${tomlString(plan.volumeName)}`,
    `  destination = ${tomlString(FLY_DATA_PATH)}`,
    `  initial_size = ${tomlString(`${plan.volumeSizeGb}gb`)}`,
    "",
    "[http_service]",
    `  internal_port = ${FLY_API_PORT}`,
    "  force_https = true",
    "  # Fly proxy autostop is traffic-based and would stop the Machine during an",
    "  # agent run that has no HTTP traffic, so it stays off.",
    "  auto_stop_machines = \"off\"",
    "  auto_start_machines = true",
    `  min_machines_running = ${plan.idleShutdownAfter ? 0 : 1}`,
    "",
    "[[http_service.checks]]",
    "  method = \"GET\"",
    "  path = \"/health\"",
    "  interval = \"30s\"",
    "  timeout = \"5s\"",
    "  grace_period = \"60s\"",
    "",
    "[[restart]]",
    plan.idleShutdownAfter
      ? "  # Idle stop: the app stops the whole Machine, then exits 0; leave it stopped.\n  policy = \"on-failure\"\n  retries = 10"
      : "  policy = \"always\"",
    "",
    "[[vm]]",
    `  size = ${tomlString(vmSizeLabel(plan))}`,
    `  memory = ${tomlString(`${plan.memoryMb}mb`)}`,
    "",
  ];
  return lines.join("\n");
}

/**
 * The machine_config JSON referenced from fly.toml (root-level `containers`).
 * flyctl merges it into the live Machine config and keeps keys it leaves out,
 * so the keys this deploy never sets but an earlier layout did (top-level
 * `volumes`, per-container `mounts`) are sent as `[]`, which clears them
 * (flyStaleMachineConfig.ts).
 */
export function renderFlyMachineConfigJson(plan: FlyDeployPlan): string {
  const doc: JsonObject = {
    containers: buildContainers(plan).map((container) => ({ ...container, mounts: [] })),
    volumes: [],
    stop_config: { signal: "SIGTERM", timeout: "60s" },
    metadata: buildMachineMetadata(),
  };
  if (plan.legacyDocker) Object.assign(doc, buildLegacyDockerMachineFields(plan));
  return `${JSON.stringify(doc, null, 2)}\n`;
}
