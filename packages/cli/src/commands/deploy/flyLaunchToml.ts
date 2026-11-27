/**
 * The committed `fly.toml` files a Fly dashboard launch ("Launch an App → From
 * GitHub", #3827) reads. Rendered from the same builders as `propr deploy fly`
 * (flyMachineConfig.ts), so the env, health check, volume, VM size and
 * stop settings cannot drift; a test pins the committed files to this output.
 * Regenerate them with `npx tsx packages/cli/scripts/render-fly-launch-toml.ts`.
 *
 * Two configs that differ only in [build]:
 *
 * - `fly.toml` (root, the default): pulls the released `propr/app:<version>`
 *   image, pinned to the root package.json version (release:verify and a test
 *   fail when they differ). No build, so a launch takes about a minute.
 * - `deploy/fly/source/fly.toml`: builds docker/Dockerfile.app.prod from the
 *   fork, for modified forks and PR branches (the dashboard's Config path
 *   field). flyctl resolves `[build] dockerfile` against the config file's
 *   directory and uses the working directory (the repository root) as the
 *   build context, so the Dockerfile path climbs back to the root.
 *
 * Differences from the CLI layout, all forced by the dashboard flow:
 *
 * - ONE container. A dashboard deploy cannot list the Fly secrets each
 *   container of a multi-container Machine receives, so Redis runs inside the
 *   app container (scripts/fly-launch-entrypoint.sh) with the CLI's flags.
 *   The process exiting then stops the Machine, so an idle stop needs no
 *   Machines API token (PROPR_FLY_EXIT_STOPS_MACHINE).
 * - No secrets and no account-specific values. The app name, organization and
 *   region come from the dashboard; the env derived from the app name
 *   (public URL, OAuth callback, instance id, MCP defaults) is derived at boot
 *   from FLY_APP_NAME, and the secrets the CLI generates are generated on first
 *   boot and kept on the volume (src/flyLaunch/).
 * - Settings the setup wizard chooses (agent runtime, idle shutdown) are not
 *   in [env]: a value here would read as an operator override and win.
 * - Restart on failure only. With idle shutdown off (the default) nothing
 *   exits 0 except a stop Fly asked for; with it on, the exit 0 after an idle
 *   stop leaves the Machine stopped for the Fly proxy to start again.
 */

import { FLY_EXIT_STOPS_MACHINE_ENV, FLY_LAUNCH_ENV } from "@propr/shared";
import {
  buildAppEnv,
  buildHttpService,
  FLY_API_PORT,
  FLY_DATA_PATH,
  FLY_DEFAULTS,
  vmSizeLabel,
  type FlyDeployPlan,
  type JsonObject,
} from "./flyMachineConfig.js";

export const FLY_LAUNCH_DOCKERFILE = "docker/Dockerfile.app.prod";
export const FLY_LAUNCH_ENTRYPOINT = "scripts/fly-launch-entrypoint.sh";
export const FLY_LAUNCH_APP_IMAGE_REPOSITORY = "propr/app";
/** Repository-relative path of the build-from-source config. */
export const FLY_LAUNCH_SOURCE_CONFIG = "deploy/fly/source/fly.toml";

export type FlyLaunchBuild =
  | { kind: "prebuilt"; version: string }
  | { kind: "source" };

/** The committed configs, by repository-relative path. */
export function flyLaunchConfigs(version: string): { path: string; build: FlyLaunchBuild }[] {
  return [
    { path: "fly.toml", build: { kind: "prebuilt", version } },
    { path: FLY_LAUNCH_SOURCE_CONFIG, build: { kind: "source" } },
  ];
}

/** `[build] dockerfile` is relative to the config's directory in flyctl; the context stays the repo root. */
export function flyLaunchDockerfileFrom(configPath: string): string {
  const depth = configPath.split("/").length - 1;
  return `${"../".repeat(depth)}${FLY_LAUNCH_DOCKERFILE}`;
}

/**
 * The [processes] command. Images released before the dashboard launch have
 * no launch entry; instead of a missing-file crash loop, the Machine logs how
 * to build from source and exits 0, which the on-failure policy leaves stopped.
 */
export const FLY_LAUNCH_MISSING_ENTRY_MESSAGE =
  `fly-launch: this propr/app image has no ${FLY_LAUNCH_ENTRYPOINT}, it predates the Fly dashboard launch. ` +
  `Set the Config path to ${FLY_LAUNCH_SOURCE_CONFIG} to build from source, or deploy a newer release.`;
export const FLY_LAUNCH_PROCESS_SCRIPT =
  `if [ -f ${FLY_LAUNCH_ENTRYPOINT} ]; then exec sh ${FLY_LAUNCH_ENTRYPOINT}; fi; ` +
  `echo ${FLY_LAUNCH_MISSING_ENTRY_MESSAGE} >&2; exit 0`;

/**
 * buildAppEnv keys a dashboard launch leaves out of fly.toml: derived from the
 * app name at boot (src/flyLaunch/launchEnv.ts) or chosen by the wizard.
 */
export const FLY_LAUNCH_BOOT_ENV_KEYS: readonly string[] = [
  "API_PUBLIC_URL", "FRONTEND_URL", "GH_OAUTH_CALLBACK_URL", "PROPR_INSTANCE_ID",
  "MCP_ENABLED", "MCP_PUBLIC_ORIGIN", "MCP_INSTANCE_ID",
  "PROPR_AGENT_RUNTIME", "SPRITES_CLIENT_SIGNALS", "PROPR_IDLE_SHUTDOWN", "PROPR_IDLE_SHUTDOWN_AFTER",
];

/** The CLI plan a dashboard launch matches: defaults, own GitHub App key off (it lives on the volume). */
export function flyLaunchPlan(): FlyDeployPlan {
  return {
    app: "propr", org: FLY_DEFAULTS.org, region: FLY_DEFAULTS.region, images: { app: "", redis: "", cloudflared: "" },
    cpuKind: FLY_DEFAULTS.cpuKind, cpus: FLY_DEFAULTS.cpus, memoryMb: FLY_DEFAULTS.memoryMb,
    volumeName: FLY_DEFAULTS.volumeName, volumeSizeGb: FLY_DEFAULTS.volumeSizeGb,
    agentRuntime: "sprites", legacyDocker: false, githubAppKey: false, mcp: true,
  };
}

/** The static [env] of the launch fly.toml. */
export function flyLaunchEnv(): Record<string, string> {
  const env = buildAppEnv(flyLaunchPlan());
  for (const key of FLY_LAUNCH_BOOT_ENV_KEYS) delete env[key];
  env[FLY_LAUNCH_ENV] = "1";
  env[FLY_EXIT_STOPS_MACHINE_ENV] = "1";
  return env;
}

const toml = (value: unknown): string => JSON.stringify(value);

function buildLines(configPath: string, build: FlyLaunchBuild): string[] {
  if (build.kind === "prebuilt") {
    return [
      "[build]",
      "  # The released image, built from docker/Dockerfile.app.prod by the release",
      `  # workflow. To deploy your own changes, set the Config path to ${FLY_LAUNCH_SOURCE_CONFIG}.`,
      `  image = ${toml(`${FLY_LAUNCH_APP_IMAGE_REPOSITORY}:${build.version}`)}`,
    ];
  }
  return [
    "[build]",
    "  # Builds this checkout. flyctl resolves the path from this file's directory;",
    "  # the build context is the repository root.",
    `  dockerfile = ${toml(flyLaunchDockerfileFrom(configPath))}`,
  ];
}

export function renderFlyLaunchToml(configPath: string, build: FlyLaunchBuild): string {
  const plan = flyLaunchPlan();
  const service = buildHttpService({ ...plan, idleShutdownAfter: FLY_DEFAULTS.idleShutdownAfter });
  const [check] = service.checks as JsonObject[];
  const env = flyLaunchEnv();
  const lines = [
    "# Fly dashboard launch: Launch an App -> From GitHub (see docs/docs/tutorials/setup-fly.md).",
    build.kind === "prebuilt"
      ? "# Default: pulls the released image. Builds from source: " + FLY_LAUNCH_SOURCE_CONFIG + "."
      : "# Builds from source (modified forks, PR branches): set the dashboard's Config path to this file.",
    "# Generated by packages/cli/src/commands/deploy/flyLaunchToml.ts from the same builders as",
    "# `propr deploy fly`; regenerate with `npx tsx packages/cli/scripts/render-fly-launch-toml.ts`.",
    "# No secrets and no account-specific values: the dashboard picks the app name,",
    "# organization and region, and the instance generates its secrets on first boot.",
    "",
    "# allInOne drains on SIGTERM; give it time to finish acks and close SQLite.",
    "kill_signal = \"SIGTERM\"",
    "kill_timeout = \"60s\"",
    "",
    ...buildLines(configPath, build),
    "",
    "[processes]",
    "  # ProPR and Redis in one container (secrets reach it without a per-container list).",
    "  # An image without the launch entry logs how to build from source and stays stopped.",
    `  app = ${toml(`sh -c '${FLY_LAUNCH_PROCESS_SCRIPT}'`)}`,
    "",
    "[env]",
    ...Object.keys(env).sort().map((key) => `  ${key} = ${toml(env[key])}`),
    "",
    "[[mounts]]",
    `  source = ${toml(plan.volumeName)}`,
    `  destination = ${toml(FLY_DATA_PATH)}`,
    `  initial_size = ${toml(`${plan.volumeSizeGb}gb`)}`,
    "",
    "[http_service]",
    `  internal_port = ${FLY_API_PORT}`,
    "  force_https = true",
    "  # Fly proxy autostop is traffic-based and would stop the Machine during an",
    "  # agent run that has no HTTP traffic, so it stays off. ProPR's own idle",
    "  # shutdown (off unless chosen in the setup wizard) exits instead, and any",
    "  # request (UI, API, MCP, webhook) starts the stopped Machine again.",
    `  auto_stop_machines = ${toml(service.autostop)}`,
    `  auto_start_machines = ${toml(service.autostart)}`,
    `  min_machines_running = ${service.min_machines_running}`,
    "  processes = [\"app\"]",
    "",
    "[[http_service.checks]]",
    `  method = ${toml(check.method)}`,
    `  path = ${toml(check.path)}`,
    `  interval = ${toml(check.interval)}`,
    `  timeout = ${toml(check.timeout)}`,
    `  grace_period = ${toml(check.grace_period)}`,
    "",
    "[[restart]]",
    "  # Only an idle stop exits 0; leave the Machine stopped then, restart anything else.",
    "  policy = \"on-failure\"",
    "  retries = 10",
    "",
    "[[vm]]",
    `  size = ${toml(vmSizeLabel(plan))}`,
    `  memory = ${toml(`${plan.memoryMb}mb`)}`,
    "",
  ];
  return lines.join("\n");
}
