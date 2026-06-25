/**
 * `propr start` entry point.
 *
 * Pulls images, starts the stack, then either renders the live ink dashboard
 * (TTY) or prints a one-shot status snapshot and exits (non-TTY / --no-tui).
 * In all cases the containers run detached, so the stack outlives this process.
 */

import type { ConfigManager } from "../config/index.js";
import { getHostConfig } from "../orchestrator/index.js";
import { renderStatusTable } from "../orchestrator/format.js";
import { ensureVibePromptCacheDir } from "../commands/initStack.js";
import { createInterface } from "node:readline/promises";

export interface StartOptions {
  root?: string;
  tui?: boolean; // commander sets this false for --no-tui
  pull?: boolean; // commander sets this false for --no-pull
  restart?: boolean;
}

async function confirmRestart(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Stack is already running. Restart all services? [y/N] ");
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

export async function runStart(configManager: ConfigManager, options: StartOptions): Promise<void> {
  const { orch, cfg, rootDir } = await getHostConfig({ configManager, root: options.root });

  if (!orch.dockerAvailable()) {
    console.error("Error: cannot reach the Docker daemon. Run 'propr check' for diagnostics.");
    process.exit(1);
  }

  // Pre-create the host Vibe prompt-cache dir owned by this user before Docker
  // can auto-create it as root on first bind-mount. Without this, a stack that
  // has run once leaves a root-owned cache dir that trips the writability check
  // below and blocks every subsequent `propr start`.
  try {
    ensureVibePromptCacheDir(cfg.hostVibePromptCacheDir);
  } catch {
    /* best-effort: validateEnv will surface an actionable error if needed */
  }

  const validation = orch.validateEnv(cfg);
  for (const w of validation.warnings) console.warn(`warning: ${w}`);
  if (!validation.ok) {
    console.error("\nCannot start — the stack environment is not ready:");
    for (const e of validation.errors) console.error(`  ✗ ${e}`);
    console.error("\nRun `propr init stack` and edit .env, then `propr check`.");
    process.exit(1);
  }

  console.log(`Starting ProPR stack (root: ${rootDir})`);

  const running = orch.isStackRunning(cfg);
  if (running) {
    if (!options.restart && !(await confirmRestart())) {
      console.error("\nStack is already running. Use `propr start --restart` to recreate all services.");
      process.exit(1);
    }
    console.log("\nRestarting all services…");
    orch.stopStack(cfg, { remove: true, onLog: (l) => console.log(l) });
  } else {
    console.log("\nStarting containers…");
  }

  if (options.pull !== false) {
    const { failedAgentImages } = orch.pullImages(cfg, { onLog: (l) => console.log(l) });
    if (failedAgentImages.length > 0) {
      console.warn(`\nwarning: ${failedAgentImages.length} agent image(s) could not be pulled:`);
      for (const t of failedAgentImages) console.warn(`    - ${t}`);
      console.warn("  Jobs using those agents will fail until the images are available.\n");
    }
  }

  const ui = configManager.getUiEnabled();
  const docs = cfg.docsEnabled;
  // cfg.uiTunnelEnabled already reflects a persisted `propr tunnel on|off`
  // toggle (forwarded as an override in getHostConfig), falling back to the
  // env-derived default when the toggle has never been set.
  const tunnel = cfg.uiTunnelEnabled;

  orch.ensureNetwork(cfg, (l) => console.log(l));
  const status = orch.startStack(cfg, { ui, docs, tunnel, onLog: (l) => console.log(l) });

  const interactive = options.tui !== false && Boolean(process.stdout.isTTY);

  if (!interactive) {
    console.log("");
    console.log(renderStatusTable(status));
    console.log("");
    console.log("Stack running in the background.");
    console.log("  propr status   # check status");
    console.log("  propr stop     # stop the stack");
    return;
  }

  // Hand off to the live dashboard. Loaded dynamically so the non-TTY path never
  // pulls in ink/react.
  const { renderDashboard } = await import("./app.js");
  const outcome = await renderDashboard({ orch, cfg, configManager });

  if (outcome === "stopped") {
    console.log("Stack stopped.");
  } else {
    console.log("\nStack still running in the background.");
    console.log("  propr status   # check status");
    console.log("  propr stop     # stop the stack");
  }
}
