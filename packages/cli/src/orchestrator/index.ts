/**
 * Orchestrator loader.
 *
 * The orchestration core lives in a dependency-free `.mjs` shared with the
 * production launcher image (docker/launcher/orchestrator.mjs). At CLI build
 * time it is copied next to the compiled output (see scripts/copy-assets.mjs);
 * here we resolve and dynamically import it, typed via ./types.ts.
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { delimiter, dirname, join, posix, resolve, win32 } from "node:path";
import type { OrchestratorConfig, OrchestratorModule } from "./types.js";
import type { ConfigManager } from "../config/index.js";
import { readTrustedConnectTunnelOverride } from "../connectIdentity.js";

export type {
  OrchestratorConfig,
  OrchestratorModule,
  ImageFreshnessResult,
  ServiceState,
  StackStatus,
  ValidationResult,
} from "./types.js";

let cached: OrchestratorModule | undefined;
let cachedPath: string | undefined;

/**
 * Candidate locations for orchestrator.mjs, in priority order:
 *   1. Repo-checkout fallback first in src/tsx dev mode.
 *   2. Bundled next to this module in dist.
 */
function resolveOrchestratorPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, "orchestrator.mjs");

  const repoCheckout = (): string | undefined => {
    // Walk up looking for docker/launcher/orchestrator.mjs (dev / source tree).
    let dir = here;
    for (let i = 0; i < 8; i += 1) {
      const candidate = join(dir, "docker", "launcher", "orchestrator.mjs");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return undefined;
  };

  const devCheckout = here.includes(`${join("src", "orchestrator")}`);
  if (devCheckout) {
    const checkoutPath = repoCheckout();
    if (checkoutPath) return checkoutPath;
  }

  if (existsSync(bundled)) return bundled;

  const checkoutPath = repoCheckout();
  if (checkoutPath) return checkoutPath;

  throw new Error(
    "Could not locate orchestrator.mjs. Run `npm run build` in packages/cli to bundle it, " +
      "or run from a ProPR source checkout."
  );
}

/** Resolve the bundled manifest.json path (sits next to orchestrator.mjs). */
function resolveManifestPath(orchestratorPath: string): string | undefined {
  const manifest = join(dirname(orchestratorPath), "manifest.json");
  return existsSync(manifest) ? manifest : undefined;
}

/** Loads (and caches) the orchestrator module. */
export async function loadOrchestrator(): Promise<OrchestratorModule> {
  if (cached) return cached;
  cachedPath = resolveOrchestratorPath();
  cached = (await import(pathToFileURL(cachedPath).href)) as OrchestratorModule;
  return cached;
}

/**
 * Determine the stack root directory (where .env, data/, logs/, repos/ live).
 * Precedence: explicit flag → PROPR_ROOT env → saved config stackRoot → cwd.
 */
export function resolveStackRoot(
  configManager: ConfigManager | undefined,
  flagRoot?: string
): string {
  if (flagRoot) return resolve(flagRoot);
  if (process.env.PROPR_ROOT) return resolve(process.env.PROPR_ROOT);
  const saved = configManager?.getStackRoot();
  if (saved) return resolve(saved);
  return process.cwd();
}

/**
 * Convenience: load the orchestrator and resolve a host config for the given
 * (or resolved) stack root. When a ConfigManager is provided, persisted CLI
 * settings (docsEnabled and root-specific tunnel state) are forwarded as
 * overrides so `propr start` honors `propr docs on` and `propr tunnel on` for
 * the selected root. Note: uiEnabled is read
 * directly from ConfigManager at
 * call sites (e.g. render.ts) and passed to startStack(); it is not part of
 * the resolved config because resolveConfig does not consume it.
 */
export async function getHostConfig(opts: {
  configManager?: ConfigManager;
  root?: string;
}): Promise<{ orch: OrchestratorModule; cfg: OrchestratorConfig; rootDir: string }> {
  const orch = await loadOrchestrator();
  const rootDir = resolveStackRoot(opts.configManager, opts.root);
  const orchPath = cachedPath ?? resolveOrchestratorPath();
  const manifestPath = resolveManifestPath(orchPath);
  if (!manifestPath) {
    throw new Error(
      `Could not locate manifest.json (expected next to ${orchPath}). Run \`npm run build\` in packages/cli to bundle it.`
    );
  }
  const cliOverrides: Record<string, unknown> = {};
  if (opts.configManager) {
    const docsExplicit = opts.configManager.get("docsEnabled");
    if (docsExplicit !== undefined) {
      cliOverrides.docsEnabled = docsExplicit;
    }
    const tunnelExplicit = opts.configManager.getTunnelEnabled(rootDir);
    if (tunnelExplicit !== undefined) {
      cliOverrides.uiTunnelEnabled = tunnelExplicit;
    }
  }
  const cfg = orch.resolveHostConfig({ rootDir, env: process.env, manifestPath, cliOverrides });
  return { orch, cfg, rootDir };
}

export interface ConnectHostConfigSnapshotInput {
  requestedRoot: string;
  envFileValues: Readonly<Record<string, string>>;
}

/**
 * Load all code/manifest state before Connect acquires root authority. The
 * returned resolver is synchronous so authorized root bytes never cross an
 * await boundary.
 */
const CONNECT_DOCKER_ENV_LIMITS = {
  DOCKER_HOST: 4096,
  DOCKER_CONTEXT: 255,
  DOCKER_TLS_VERIFY: 16,
  DOCKER_CERT_PATH: 4096,
  DOCKER_CONFIG: 4096,
} as const;

function environmentString(source: Readonly<Record<string, unknown>>, name: string, maximum = 4096): string | undefined {
  const value = source[name];
  if (value === undefined) return undefined;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\0")
    || /[\r\n]/.test(value)
    || Buffer.byteLength(value, "utf8") > maximum
  ) throw new Error("Connect process environment is invalid");
  return value;
}

function platformPath(value: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? win32.isAbsolute(value) : posix.isAbsolute(value);
}

function validateSearchPath(value: string, platform: NodeJS.Platform): void {
  const separator = platform === "win32" ? ";" : delimiter;
  const entries = value.split(separator);
  if (entries.length === 0 || entries.some((entry) => !entry || !platformPath(entry, platform))) {
    throw new Error("Connect executable search environment is invalid");
  }
}

function validateDockerHost(value: string, platform: NodeJS.Platform): void {
  try {
    const parsed = new URL(value);
    if (parsed.password || parsed.search || parsed.hash) throw new Error();
    if (parsed.protocol === "unix:") {
      if (platform === "win32" || parsed.hostname || !posix.isAbsolute(parsed.pathname)) throw new Error();
      return;
    }
    if (parsed.protocol === "npipe:") {
      if (platform !== "win32" || !/^\/\/\.\/pipe\/[A-Za-z0-9_.-]+$/.test(parsed.pathname)) throw new Error();
      return;
    }
    if (parsed.protocol === "tcp:" || parsed.protocol === "http:" || parsed.protocol === "https:") {
      if (parsed.username || !parsed.hostname || (parsed.pathname !== "" && parsed.pathname !== "/")) throw new Error();
      return;
    }
    if (parsed.protocol === "ssh:") {
      if (!parsed.hostname || parsed.pathname !== "" && parsed.pathname !== "/") throw new Error();
      return;
    }
  } catch {
    // Fall through to the single fixed redacted validation error below.
  }
  throw new Error("Connect Docker transport environment is invalid");
}

/**
 * Discovery needs executable lookup, OS bootstrap variables, and the trusted
 * parent process's documented Docker transport selection. ProPR/configuration
 * variables remain absent: the explicit root snapshot is their sole authority.
 */
export function connectExecutionEnvironment(
  source: Readonly<Record<string, unknown>>,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
    throw new Error("Connect process environment is invalid");
  }
  const allowed: NodeJS.ProcessEnv = {};
  const bootstrap = platform === "win32"
    ? ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TMP", "TEMP"] as const
    : ["PATH", "TMPDIR", "TMP", "TEMP", "HOME"] as const;
  for (const name of bootstrap) {
    const value = environmentString(source, name);
    if (value === undefined) continue;
    if (name === "PATH") validateSearchPath(value, platform);
    else if (name === "PATHEXT") {
      if (!value.split(";").every((entry) => /^\.[A-Za-z0-9]{1,16}$/.test(entry))) {
        throw new Error("Connect executable search environment is invalid");
      }
    } else if (!platformPath(value, platform)) {
      throw new Error("Connect platform environment is invalid");
    }
    allowed[name] = value;
  }
  if (platform === "win32") {
    const userProfile = environmentString(source, "USERPROFILE");
    const homeDrive = environmentString(source, "HOMEDRIVE");
    const homePath = environmentString(source, "HOMEPATH");
    if (userProfile !== undefined) {
      if (!win32.isAbsolute(userProfile)) throw new Error("Connect platform environment is invalid");
      allowed.USERPROFILE = userProfile;
    } else if (homeDrive !== undefined || homePath !== undefined) {
      if (!homeDrive || !/^[A-Za-z]:$/.test(homeDrive) || !homePath || !win32.isAbsolute(homePath)) {
        throw new Error("Connect platform environment is invalid");
      }
      allowed.HOMEDRIVE = homeDrive;
      allowed.HOMEPATH = homePath;
    }
  }
  for (const [name, maximum] of Object.entries(CONNECT_DOCKER_ENV_LIMITS)) {
    const value = environmentString(source, name, maximum);
    if (value === undefined) continue;
    if (name === "DOCKER_HOST") validateDockerHost(value, platform);
    else if (name === "DOCKER_CONTEXT" && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(value)) {
      throw new Error("Connect Docker transport environment is invalid");
    } else if (name === "DOCKER_TLS_VERIFY" && value !== "0" && value !== "1") {
      throw new Error("Connect Docker transport environment is invalid");
    } else if ((name === "DOCKER_CERT_PATH" || name === "DOCKER_CONFIG") && !platformPath(value, platform)) {
      throw new Error("Connect Docker transport environment is invalid");
    }
    allowed[name] = value;
  }
  // A named context may itself select an ssh endpoint; without opening Docker's
  // config here, preserving the socket when a context is explicit is the
  // narrowest way to keep those documented contexts functional.
  if (allowed.DOCKER_HOST?.startsWith("ssh://") || allowed.DOCKER_CONTEXT !== undefined) {
    const socket = environmentString(source, "SSH_AUTH_SOCK");
    if (socket !== undefined) {
      const valid = platform === "win32"
        ? win32.isAbsolute(socket) || /^\\\\\.\\pipe\\[A-Za-z0-9_.-]+$/.test(socket)
        : posix.isAbsolute(socket);
      if (!valid) throw new Error("Connect SSH transport environment is invalid");
      allowed.SSH_AUTH_SOCK = socket;
    }
  }
  return allowed;
}

export async function prepareConnectHostConfig(): Promise<{
  orch: OrchestratorModule;
  parseEnvFile(contents: string): Record<string, string>;
  resolveSnapshot(input: ConnectHostConfigSnapshotInput): Promise<OrchestratorConfig>;
  inspectTunnel(cfg: OrchestratorConfig): { kind: "ok"; running: boolean } | { kind: "internalFailure" };
}> {
  const orch = await loadOrchestrator();
  const orchPath = cachedPath ?? resolveOrchestratorPath();
  const manifestPath = resolveManifestPath(orchPath);
  if (!manifestPath) {
    throw new Error("Connect host configuration manifest is unavailable");
  }
  const executionEnv = connectExecutionEnvironment(process.env);
  return {
    orch,
    parseEnvFile: (contents) => orch.parseEnvFileContents(contents),
    resolveSnapshot: async ({ requestedRoot, envFileValues }) => {
      const tunnelOverride = await readTrustedConnectTunnelOverride(requestedRoot);
      return orch.resolveConfig(executionEnv, {
        envFileValues,
        stack: envFileValues.PROPR_STACK || "propr",
        network: envFileValues.PROPR_NETWORK
          || `${envFileValues.PROPR_STACK || "propr"}-net`,
        envFileLocal: join(requestedRoot, ".env"),
        envFileHost: join(requestedRoot, ".env"),
        hostData: join(requestedRoot, "data"),
        hostLogs: join(requestedRoot, "logs"),
        hostRepos: join(requestedRoot, "repos"),
        managedCredentialsDir: join(requestedRoot, "data", "agent-credentials"),
        validateHostPaths: true,
        manifestPath,
        ...(tunnelOverride === undefined ? {} : { uiTunnelEnabled: tunnelOverride }),
      });
    },
    inspectTunnel: (cfg) => {
      const inspection = orch.inspectStackStatus(cfg, { timeout: 3000, env: executionEnv });
      if (!inspection.status) return { kind: "internalFailure" };
      return {
        kind: "ok",
        running: Boolean(inspection.status.services.find((service) => service.service === "tunnel")?.running),
      };
    },
  };
}
