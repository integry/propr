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
import { dirname, join, resolve } from "node:path";
import type { OrchestratorConfig, OrchestratorModule } from "./types.js";
import type { ConfigManager } from "../config/index.js";

export type {
  OrchestratorConfig,
  OrchestratorModule,
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
 * settings (docsEnabled) are forwarded as overrides so `propr start` honors
 * `propr docs on`. Note: uiEnabled is read directly from ConfigManager at
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
  }
  const cfg = orch.resolveHostConfig({ rootDir, env: process.env, manifestPath, cliOverrides });
  return { orch, cfg, rootDir };
}
