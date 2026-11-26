/**
 * `propr deploy fly` — run the control plane on one Fly Machine.
 *
 * The slim control plane (all-in-one app container: daemon + worker + API +
 * same-origin UI) and Redis share one Machine; SQLite and Redis persist on a
 * Fly volume. The published app image from the launcher manifest is deployed
 * as-is (no image build, no Docker-in-Docker). Agents run on Sprites (default)
 * or Fly Machines; `--legacy-docker` runs a Docker daemon in the Machine for
 * the Docker runtime instead.
 *
 * flyctl is used when installed; otherwise the Machines API with a token.
 * See flyMachineConfig.ts for the Machine layout and docs/docs/tutorials/deploy-fly.md.
 */

import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { createConfigManager } from "../config/index.js";
import { loadLauncherManifest, resolveStackRoot } from "../orchestrator/index.js";
import { buildTunnelSetupEnv } from "./tunnelCommand.js";
import { createFlyctlRunner, detectFlyctl, FlyctlBackend } from "./deploy/flyctlBackend.js";
import { FlyMachinesApi } from "./deploy/flyMachinesApi.js";
import { planFlyRelay, plannedFlyRelaySecrets, resolveFlyRelaySecrets, type FlyRelayDeps } from "./deploy/flyRelay.js";
import { selectFlyIntakeMode } from "./deploy/flyIntake.js";
import { flyDeployEnablesMcp, generateFlySecrets } from "./deploy/flyGeneratedSecrets.js";
import { describeFlyBrowserAuth, flyOAuthCallbackUrl, planFlyBrowserAuth, type FlyBrowserAuth } from "./deploy/flyBrowserAuth.js";
import {
  createFlyctlTarget,
  createMachinesApiTarget,
  runFlyDeploy,
  writeFlyFiles,
  type FlyDeployResult,
  type FlyDeployTarget,
} from "./deploy/flyDeployRunner.js";
import {
  FLY_AGENT_RUNTIMES,
  FLY_DEFAULTS,
  FLY_GH_PRIVATE_KEY_SECRET,
  FLY_MACHINE_STOP_TOKEN_SECRET,
  flyPublicUrl,
  selectEnvFileSecrets,
  validateFlyAppName,
  validateFlyVolumeName,
  legacyRootfsSizeGb,
  vmSizeLabel,
  type FlyAgentRuntime,
  type FlyDeployPlan,
} from "./deploy/flyMachineConfig.js";
import {
  FLY_ROOTFS_PRICE_PER_GB_MONTH,
  flyRootfsMonthlyCost,
  LEGACY_DOCKER_DEFAULT_MEMORY_MB,
  LEGACY_DOCKER_DEFAULT_ROOTFS_GB,
  LEGACY_DOCKER_MIN_MEMORY_MB,
  LEGACY_DOCKER_MIN_ROOTFS_GB,
} from "./deploy/flyLegacyDocker.js";
import { exceedsFreePlanVolumeCap, FLY_FREE_PLAN_MAX_VOLUME_GB } from "./deploy/flyOrgPlan.js";

export interface DeployFlyOptions {
  app: string;
  org?: string;
  region?: string;
  memory?: string;
  cpus?: string;
  volume?: string;
  volumeSize?: string;
  rootfsSize?: string;
  image?: string;
  agentRuntime?: string;
  spritesToken?: string;
  agentFlyToken?: string;
  envFile?: string | false;
  root?: string;
  githubAppKey?: string;
  token?: string;
  backend?: string;
  out?: string;
  tunnelToken?: string;
  tunnelUrl?: string;
  instanceId?: string;
  relay?: boolean;
  relayUrl?: string;
  installation?: string;
  idleShutdown?: boolean | string;
  /** App-scoped Fly token the Machine stops itself with when idle (the Machines API backend cannot create one). */
  machineStopToken?: string;
  legacyDocker?: boolean;
  dryRun?: boolean;
}

function positiveInt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) <= 0) throw new Error(`${name} must be a positive whole number (got "${value}")`);
  return Number(value);
}

/** Same bounds as PROPR_IDLE_SHUTDOWN_AFTER (#3770): 1m to 24h. */
export function parseIdleShutdownAfter(value: boolean | string | undefined): string | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return FLY_DEFAULTS.idleShutdownAfter;
  const match = /^(\d+)([smh])$/.exec(value.trim());
  const seconds = match ? Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2] as "s" | "m" | "h"] : NaN;
  if (!match || seconds < 60 || seconds > 86_400) {
    throw new Error(`--idle-shutdown must be a duration from 1m to 24h such as 15m (got "${value}")`);
  }
  return value.trim();
}

export function resolveFlyDeployPlan(options: DeployFlyOptions, images: Record<string, string>): FlyDeployPlan {
  const appError = validateFlyAppName(options.app);
  if (appError) throw new Error(appError);
  const volumeName = options.volume ?? FLY_DEFAULTS.volumeName;
  const volumeError = validateFlyVolumeName(volumeName);
  if (volumeError) throw new Error(volumeError);

  const legacyDocker = Boolean(options.legacyDocker);
  const agentRuntime = (options.agentRuntime ?? (legacyDocker ? "docker" : "sprites")) as FlyAgentRuntime;
  if (!FLY_AGENT_RUNTIMES.includes(agentRuntime)) {
    throw new Error(`--agent-runtime must be one of ${FLY_AGENT_RUNTIMES.join(", ")} (got "${options.agentRuntime}")`);
  }
  if (agentRuntime === "docker" && !legacyDocker) {
    throw new Error("--agent-runtime docker needs a Docker daemon in the Machine; add --legacy-docker or use sprites/fly-machines");
  }
  if (legacyDocker && agentRuntime !== "docker") {
    throw new Error("--legacy-docker runs agents with the Docker runtime; drop --agent-runtime or set it to docker");
  }

  const memoryMb = positiveInt(options.memory, "--memory", legacyDocker ? LEGACY_DOCKER_DEFAULT_MEMORY_MB : FLY_DEFAULTS.memoryMb);
  // The volume holds only SQLite and Redis in every mode; legacy Docker images
  // go on a persistent root filesystem, which the Free plan's 5 GB volume cap
  // does not limit.
  const volumeSizeGb = positiveInt(options.volumeSize, "--volume-size", FLY_DEFAULTS.volumeSizeGb);
  if (legacyDocker && memoryMb < LEGACY_DOCKER_MIN_MEMORY_MB) {
    throw new Error(`--legacy-docker needs at least ${LEGACY_DOCKER_MIN_MEMORY_MB} MB (--memory)`);
  }
  if (!legacyDocker && options.rootfsSize !== undefined) {
    throw new Error("--rootfs-size sizes the persistent root filesystem for Docker images; it needs --legacy-docker");
  }
  const rootfsSizeGb = legacyDocker ? positiveInt(options.rootfsSize, "--rootfs-size", LEGACY_DOCKER_DEFAULT_ROOTFS_GB) : undefined;
  if (rootfsSizeGb !== undefined && rootfsSizeGb < LEGACY_DOCKER_MIN_ROOTFS_GB) {
    throw new Error(`--legacy-docker keeps Docker images on the persistent root filesystem; use --rootfs-size ${LEGACY_DOCKER_MIN_ROOTFS_GB} or more`);
  }
  const app = images.app;
  const redis = images.redis;
  if (!app || !redis) throw new Error("the launcher manifest has no app/redis image");

  return {
    app: options.app,
    org: options.org ?? FLY_DEFAULTS.org,
    region: options.region ?? FLY_DEFAULTS.region,
    images: { app: options.image ?? app, redis, cloudflared: images.cloudflared ?? "cloudflare/cloudflared:2024.12.2" },
    cpuKind: FLY_DEFAULTS.cpuKind,
    cpus: positiveInt(options.cpus, "--cpus", FLY_DEFAULTS.cpus),
    memoryMb,
    volumeName,
    volumeSizeGb,
    agentRuntime,
    idleShutdownAfter: parseIdleShutdownAfter(options.idleShutdown),
    legacyDocker,
    ...(rootfsSizeGb !== undefined ? { rootfsSizeGb } : {}),
    githubAppKey: false,
  };
}

/** Keys moved only by explicit flags: a copied tunnel token would split traffic between two connectors. */
const ENV_FILE_TUNNEL_KEYS = ["PROPR_UI_TUNNEL_TOKEN", "TUNNEL_TOKEN"];

export interface CollectedSecrets {
  secrets: Record<string, string>;
  notes: string[];
}

/** Secrets from the stack .env, the GitHub App key, the tunnel and runtime tokens. */
export function collectFlySecrets(
  plan: FlyDeployPlan,
  options: DeployFlyOptions,
  envFileValues: Record<string, string>,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf-8"),
): CollectedSecrets {
  const notes: string[] = [];
  const secrets = selectEnvFileSecrets(envFileValues);
  for (const key of ENV_FILE_TUNNEL_KEYS) {
    if (key in secrets) {
      delete secrets[key];
      notes.push(`Not copying ${key} from the stack .env. To move the Connect tunnel to Fly, stop the local tunnel and pass --tunnel-token and --tunnel-url.`);
    }
  }

  const keyPath = options.githubAppKey ?? envFileValues.HOST_GH_PRIVATE_KEY;
  if (keyPath) secrets[FLY_GH_PRIVATE_KEY_SECRET] = Buffer.from(readFile(keyPath)).toString("base64");
  // A key file or a base64 key already in the stack .env: either way the
  // Machine must write the key file and point GH_PRIVATE_KEY_PATH at it.
  if (secrets[FLY_GH_PRIVATE_KEY_SECRET]) plan.githubAppKey = true;

  if (options.tunnelToken || options.tunnelUrl || options.instanceId) {
    const tunnel = buildTunnelSetupEnv({ token: options.tunnelToken ?? "", url: options.tunnelUrl, instanceId: options.instanceId });
    plan.tunnel = { instanceId: tunnel.PROPR_INSTANCE_ID, publicUrl: tunnel.PROPR_UI_PUBLIC_API_URL };
    secrets.PROPR_UI_TUNNEL_TOKEN = tunnel.PROPR_UI_TUNNEL_TOKEN;
    // cloudflared reads its token from TUNNEL_TOKEN, keeping it off argv.
    secrets.TUNNEL_TOKEN = tunnel.PROPR_UI_TUNNEL_TOKEN;
  }

  const spritesToken = options.spritesToken ?? process.env.SPRITES_TOKEN;
  if (spritesToken) secrets.SPRITES_TOKEN = spritesToken;
  else if (plan.agentRuntime === "sprites" && !secrets.SPRITES_TOKEN) {
    notes.push("No Sprites token: agent runs fail until you set one (`fly secrets set SPRITES_TOKEN=... --app " + plan.app + "`, or rerun with --sprites-token).");
  }
  if (options.machineStopToken) {
    if (!plan.idleShutdownAfter) throw new Error("--machine-stop-token is only used with --idle-shutdown");
    secrets[FLY_MACHINE_STOP_TOKEN_SECRET] = options.machineStopToken.trim();
  }
  if (options.agentFlyToken) secrets.PROPR_FLY_API_TOKEN = options.agentFlyToken;
  else if (plan.agentRuntime === "fly-machines" && !secrets.PROPR_FLY_API_TOKEN && !secrets.FLY_API_TOKEN) {
    notes.push("No agent Fly token: create a deploy token for the agent app and pass --agent-fly-token.");
  }
  return { secrets, notes };
}

function readEnvFile(options: DeployFlyOptions, rootDir: string): { path?: string; values: Record<string, string> } {
  if (options.envFile === false) return { values: {} };
  const path = options.envFile ? resolve(options.envFile) : join(rootDir, ".env");
  if (!existsSync(path)) {
    if (options.envFile) throw new Error(`env file not found: ${path}`);
    return { values: {} };
  }
  return { path, values: parseDotenv(readFileSync(path, "utf-8")) };
}

function selectTarget(options: DeployFlyOptions, outDir: string): FlyDeployTarget {
  const backend = options.backend ?? "auto";
  if (!["auto", "flyctl", "api"].includes(backend)) throw new Error(`--backend must be auto, flyctl or api (got "${backend}")`);
  const token = options.token ?? process.env.FLY_API_TOKEN ?? process.env.FLY_ACCESS_TOKEN;
  const flyctl = backend === "api" ? undefined : detectFlyctl();
  if (flyctl) {
    const env = token ? { ...process.env, FLY_API_TOKEN: token } : process.env;
    return createFlyctlTarget(new FlyctlBackend(createFlyctlRunner(flyctl, env)), outDir);
  }
  if (backend === "flyctl") throw new Error("flyctl is not installed (looked for `flyctl` and `fly` on PATH)");
  if (!token) {
    throw new Error("flyctl is not installed and no Fly token was given. Install flyctl, or pass --token (or set FLY_API_TOKEN) with a token from `fly tokens create org`.");
  }
  return createMachinesApiTarget(new FlyMachinesApi({ token }));
}

function printSummary(plan: FlyDeployPlan, browserAuth: FlyBrowserAuth): void {
  const url = flyPublicUrl(plan.app);
  console.log("");
  console.log(`Control plane: ${url}`);
  if (plan.tunnel) console.log(`Hosted UI:     https://app.propr.dev (through ${plan.tunnel.publicUrl})`);
  console.log(`Sign-in:       ${describeFlyBrowserAuth(plan, browserAuth)}`);
  console.log(`Machine:       ${vmSizeLabel(plan)}, ${plan.memoryMb} MB, ${plan.region}; volume ${plan.volumeName} (${plan.volumeSizeGb} GB)`);
  for (const line of describeFlyRootfs(plan)) console.log(line);
  console.log(`Agents:        ${plan.agentRuntime}`);
  if (plan.idleShutdownAfter) {
    console.log(`Idle shutdown: on after ${plan.idleShutdownAfter}; the Machine stops itself when idle, and HTTP starts it again.`);
    console.log(`Wake URL:      ${url}/wake  (register it as this instance's Connect wake target)`);
  }
  console.log("");
  console.log("Next steps:");
  console.log("  If no agent is configured yet, add and enable one in Settings → Agents before labeling an issue.");
  console.log(`  propr remote ${url}     # point this CLI at the Fly control plane`);
  console.log(`  fly logs --app ${plan.app}            # watch the first boot`);
}

/** Summary lines for a legacy plan's persistent root filesystem: its size and what it costs while stopped. */
export function describeFlyRootfs(plan: Pick<FlyDeployPlan, "legacyDocker" | "rootfsSizeGb">): string[] {
  if (!plan.legacyDocker) return [];
  const size = legacyRootfsSizeGb(plan);
  return [
    `Root fs:       ${size} GB, persistent (Docker images; SQLite and Redis stay on the volume)`,
    `Root fs cost:  ${flyRootfsMonthlyCost(size)}/month while the Machine is stopped ($${FLY_ROOTFS_PRICE_PER_GB_MONTH.toFixed(2)}/GB-month)`,
  ];
}

export interface PreparedFlyDeploy extends CollectedSecrets {
  plan: FlyDeployPlan;
  relayPlan: ReturnType<typeof planFlyRelay>;
  browserAuth: FlyBrowserAuth;
}

/**
 * Everything the deploy decides before contacting Fly, dry run or not. Validates the
 * runtime, administrator, relay and sign-in configuration before provisioning.
 */
export function prepareFlyDeploy(
  options: DeployFlyOptions,
  images: Record<string, string>,
  envFileValues: Record<string, string>,
  githubToken: string | undefined,
  readFile?: (path: string) => string,
): PreparedFlyDeploy {
  const plan = resolveFlyDeployPlan(options, images);
  if (!envFileValues.PROPR_ADMIN_USERS?.split(",").some((login) => login.trim())) {
    throw new Error("Set PROPR_ADMIN_USERS to at least one administrator's GitHub login in the environment or stack .env.");
  }
  const { secrets, notes } = collectFlySecrets(plan, options, envFileValues, readFile);
  const relayPlan = planFlyRelay(options, secrets, { connect: Boolean(plan.tunnel), githubToken });
  const browserAuth = planFlyBrowserAuth(plan, secrets);
  if (browserAuth === "github") {
    notes.push(`Browser sign-in uses the stack's GitHub OAuth client; its callback URL must be ${flyOAuthCallbackUrl(plan)}.`);
  }
  // Fly secrets are only ever added or replaced: a PROPR_DEMO_MODE=true left
  // by an earlier deploy would keep the API in demo mode (no sign-in at all)
  // while this run reports GitHub or Connect sign-in, so switch it off explicitly.
  if (browserAuth !== "demo" && !secrets.PROPR_DEMO_MODE) secrets.PROPR_DEMO_MODE = "false";
  plan.mcp = flyDeployEnablesMcp(secrets, browserAuth);
  return { plan, secrets, notes, relayPlan, browserAuth };
}

/**
 * The secrets a dry run reports, and the intake it selects: the relay auth
 * mode and URL a real run adds (no enrollment, so no network call), then the
 * intake check on the result, as a real run sequences them. Fly is not asked
 * for the secrets an earlier deploy left, so only this run's count. An
 * enrollment's token is unknown here, so its intake is not checked.
 */
export function planFlyDryRunSecrets(
  prepared: Pick<PreparedFlyDeploy, "secrets" | "relayPlan">,
  generatedSecrets: Record<string, string>,
): { secrets: Record<string, string>; intake?: ReturnType<typeof selectFlyIntakeMode> } {
  const relay = plannedFlyRelaySecrets(prepared.relayPlan, prepared.secrets);
  const secrets = { ...prepared.secrets, ...relay };
  const intake = relay ? selectFlyIntakeMode(secrets, new Set()) : undefined;
  return { secrets: { ...secrets, ...intake?.secrets, ...generatedSecrets }, intake };
}

export async function runDeployFly(options: DeployFlyOptions): Promise<void> {
  const configManager = await createConfigManager();
  const rootDir = resolveStackRoot(configManager, options.root);
  const manifest = loadLauncherManifest();
  const envFile = readEnvFile(options, rootDir);
  if (envFile.path) console.log(`Reading secrets from ${envFile.path}.`);
  const githubToken = configManager.getGithubToken();
  // Fails before any Fly call when the Machine could not work (see prepareFlyDeploy).
  const prepared = prepareFlyDeploy(options, manifest.images, {
    PROPR_ADMIN_USERS: process.env.PROPR_ADMIN_USERS ?? "",
    // Uploaded instead of a generated one; the stack .env still wins.
    SYSTEM_TASK_SECRET: process.env.SYSTEM_TASK_SECRET ?? "",
    ...envFile.values,
  }, githubToken);
  const { plan, notes, relayPlan, browserAuth } = prepared;
  const outDir = resolve(options.out ?? "propr-fly");
  const generatedSecrets = generateFlySecrets(plan);

  if (options.dryRun) {
    const { secrets: dryRunSecrets, intake } = planFlyDryRunSecrets(prepared, generatedSecrets);
    // A real run creates the Machine's stop token unless one is given or already set.
    if (plan.idleShutdownAfter && !dryRunSecrets[FLY_MACHINE_STOP_TOKEN_SECRET]) dryRunSecrets[FLY_MACHINE_STOP_TOKEN_SECRET] = "(created on deploy)";
    const files = writeFlyFiles({ ...plan, secretNames: Object.keys(dryRunSecrets) }, outDir);
    console.log(`Dry run: wrote ${files.flyToml} and ${files.machineConfig}; nothing was sent to Fly.`);
    console.log(`Secrets that would be set: ${Object.keys(dryRunSecrets).sort().join(", ") || "(none)"}`);
    if (intake) console.log(intake.summary);
    if (relayPlan.kind === "enroll") console.log("Note: a real run enrolls a GitHub relay token for this Machine.");
    if (exceedsFreePlanVolumeCap(plan)) {
      console.log(`Note: the Fly Free plan caps volumes at ${FLY_FREE_PLAN_MAX_VOLUME_GB} GB; a real run checks org ${plan.org}'s plan and stops before creating anything if this ${plan.volumeSizeGb} GB volume does not fit.`);
    }
    for (const note of notes) console.log(`Note: ${note}`);
    printSummary(plan, browserAuth);
    return;
  }

  const target = selectTarget(options, outDir);
  const context = { githubToken, label: `fly:${plan.app}@${hostname()}`, generatedSecrets };
  const result = await deployPreparedFly(prepared, options, target, context, (line) => console.log(line));
  for (const note of notes) console.log(`Note: ${note}`);
  printSummary({ ...plan, volumeSizeGb: result.volumeSizeGb }, browserAuth);
}

/** Enroll or complete the relay credentials, then run the deploy sequence against `target`. */
export async function deployPreparedFly(
  prepared: PreparedFlyDeploy,
  options: DeployFlyOptions,
  target: FlyDeployTarget,
  context: { githubToken?: string; label: string; generatedSecrets: Record<string, string> },
  log: (line: string) => void = () => {},
  relayDeps?: FlyRelayDeps,
): Promise<FlyDeployResult> {
  const { plan } = prepared;
  const secrets = { ...prepared.secrets };
  const relayContext = { connect: Boolean(plan.tunnel), githubToken: context.githubToken, label: context.label };
  const relay = await resolveFlyRelaySecrets(options, secrets, relayContext, relayDeps);
  if (relay) {
    Object.assign(secrets, relay.secrets);
    if (relay.enrolledInstallationId) log(`Enrolled a GitHub relay token for installation ${relay.enrolledInstallationId}.`);
  }
  return runFlyDeploy({ plan, secrets, generatedSecrets: context.generatedSecrets }, target, log);
}

export function createDeployCommand(): Command {
  const deploy = new Command("deploy").description("Deploy the control plane to a cloud host");

  deploy
    .command("fly")
    .description("Run the control plane (all-in-one + Redis) on one Fly Machine")
    .requiredOption("--app <name>", "Fly app name (becomes https://<name>.fly.dev)")
    .option("--org <slug>", `Fly organization (default: ${FLY_DEFAULTS.org})`)
    .option("--region <code>", `Fly region (default: ${FLY_DEFAULTS.region})`)
    .option("--memory <mb>", `Machine memory in MB (default: ${FLY_DEFAULTS.memoryMb})`)
    .option("--cpus <n>", `Shared vCPUs (default: ${FLY_DEFAULTS.cpus})`)
    .option("--volume <name>", `Volume for SQLite and Redis (default: ${FLY_DEFAULTS.volumeName})`)
    .option("--volume-size <gb>", `Volume size in GB (default: ${FLY_DEFAULTS.volumeSizeGb}; the Fly Free plan allows at most ${FLY_FREE_PLAN_MAX_VOLUME_GB})`)
    .option("--image <ref>", "App image (default: the launcher manifest's propr/app tag)")
    .option("--agent-runtime <runtime>", "Agent runtime: sprites (default), fly-machines, or docker with --legacy-docker")
    .option("--sprites-token <token>", "Sprites token for agent runs (or SPRITES_TOKEN)")
    .option("--agent-fly-token <token>", "Fly token the fly-machines agent runtime uses")
    .option("--root <dir>", "Stack root whose .env supplies secrets")
    .option("--env-file <path>", "Upload secrets from this .env (default: <stack root>/.env when present)")
    .option("--no-env-file", "Do not upload a stack .env")
    .option("--github-app-key <path>", "GitHub App private key (default: HOST_GH_PRIVATE_KEY from the .env)")
    .option("--token <token>", "Fly API token (or FLY_API_TOKEN); needed without flyctl")
    .option("--backend <kind>", "auto (flyctl when installed), flyctl, or api", "auto")
    .option("--out <dir>", "Where to write fly.toml and the machine config (default: ./propr-fly)")
    .option("--tunnel-token <token>", "Connector token from ProPR Connect (enables the hosted UI tunnel)")
    .option("--tunnel-url <url>", "Public proxy URL from ProPR Connect, e.g. https://t-<id>.propr.dev")
    .option("--instance-id <id>", "Instance id from ProPR Connect (derives the proxy URL)")
    .option("--relay", "Enroll a GitHub relay token for the Machine (default: when no relay token is configured and either Connect is on or there is no GitHub App)")
    .option("--no-relay", "Do not enroll a GitHub relay token")
    .option("--relay-url <url>", "Relay base URL (default: the hosted relay)")
    .option("--installation <id>", "GitHub App installation id for relay enrollment")
    .option("--idle-shutdown [after]", "Stop the Machine after it has been idle this long (1m to 24h, default 15m); HTTP starts it again")
    .option("--machine-stop-token <token>", "App-scoped Fly token the Machine stops itself with (default: created with flyctl; required for --backend api)")
    .option("--legacy-docker", "Run a Docker daemon in the Machine for Docker agents (default 2 GB, at least 1 GB; images on a persistent root filesystem)")
    .option("--rootfs-size <gb>", `With --legacy-docker: persistent root filesystem for Docker images, in GB (default: ${LEGACY_DOCKER_DEFAULT_ROOTFS_GB}, minimum ${LEGACY_DOCKER_MIN_ROOTFS_GB})`)
    .option("--dry-run", "Write fly.toml and the machine config, print the plan, change nothing")
    .addHelpText("after", `
The control plane and Redis run in one Machine; SQLite and Redis persist on a
volume. Default size: shared-cpu-1x, 1 GB (about $6.70/month always on in
iad, plus $0.15/GB-month of volume). --legacy-docker adds a persistent root
filesystem for Docker images (20 GB: $3.00/month while stopped) and keeps
the 1 GB volume, so it fits the Fly Free plan's 5 GB volume cap. Agents run on Sprites by default. The
Machine runs always on unless --idle-shutdown is given: then it stops itself
through the Machines API once idle, with an app-scoped token stored as the
${FLY_MACHINE_STOP_TOKEN_SECRET} secret (flyctl creates it; with the API
backend pass --machine-stop-token from \`fly tokens create deploy --app <app>\`).

Set PROPR_ADMIN_USERS to the GitHub logins of your instance administrators.
Browsers sign in through ProPR Connect (--tunnel-token and --tunnel-url) or a
GitHub OAuth client in the stack .env (GH_OAUTH_CLIENT_ID and
GH_OAUTH_CLIENT_SECRET, callback https://<app>.fly.dev/api/auth/github/callback).
Without either the command stops before creating anything on Fly.

Examples:
  $ propr deploy fly --app my-propr \\
      --tunnel-token <token> --tunnel-url https://t-<id>.propr.dev
  $ propr deploy fly --app my-propr   # GitHub OAuth client in the .env
  $ propr deploy fly --app my-propr --tunnel-token <token> --tunnel-url https://t-<id>.propr.dev --dry-run
`)
    .action(async (options: DeployFlyOptions) => {
      try {
        await runDeployFly(options);
      } catch (error) {
        console.error(`Error deploying to Fly: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  return deploy;
}
