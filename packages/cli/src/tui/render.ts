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

export interface StartOptions {
  root?: string;
  tui?: boolean; // commander sets this false for --no-tui
  pull?: boolean; // commander sets this false for --no-pull
}

export async function runStart(configManager: ConfigManager, options: StartOptions): Promise<void> {
  const { orch, cfg, rootDir } = await getHostConfig({ configManager, root: options.root });

  if (!orch.dockerAvailable()) {
    console.error("Error: cannot reach the Docker daemon. Run 'propr check' for diagnostics.");
    process.exit(1);
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

  if (options.pull !== false) {
    const { failedAgentImages } = orch.pullImages(cfg, { onLog: (l) => console.log(l) });
    if (failedAgentImages.length > 0) {
      console.warn(`\nwarning: ${failedAgentImages.length} agent image(s) could not be pulled:`);
      for (const t of failedAgentImages) console.warn(`    - ${t}`);
      console.warn("  Jobs using those agents will fail until the images are available.\n");
    }
  }

  const ui = configManager.getUiEnabled();
  const docs = configManager.getDocsEnabled();

  console.log("\nStarting containers…");
  orch.ensureNetwork(cfg, (l) => console.log(l));
  const status = orch.startStack(cfg, { ui, docs, onLog: (l) => console.log(l) });

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
