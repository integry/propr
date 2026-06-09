/**
 * Service toggle commands: `propr ui on|off` and `propr docs on|off`.
 *
 * The UI and docs services are plain containers, so toggling them is just
 * starting/stopping the container. The desired state is persisted in the CLI
 * config so `propr start` and restarts honor it.
 */

import { Command } from "commander";
import { createConfigManager } from "../config/index.js";
import { getHostConfig } from "../orchestrator/index.js";

type ServiceName = "ui" | "docs";

function parseState(value: string): boolean {
  const v = value.toLowerCase();
  if (v === "on" || v === "enable" || v === "true") return true;
  if (v === "off" || v === "disable" || v === "false") return false;
  throw new Error(`expected 'on' or 'off', got '${value}'`);
}

async function toggleService(service: ServiceName, stateArg: string, root?: string): Promise<void> {
  const enable = parseState(stateArg);
  const configManager = await createConfigManager();
  const { orch, cfg } = await getHostConfig({ configManager, root });

  if (!orch.dockerAvailable()) {
    console.error("Error: cannot reach the Docker daemon. Run 'propr check'.");
    process.exit(1);
  }

  // Persist desired state first so it survives restarts.
  if (service === "ui") {
    await configManager.setUiEnabled(enable);
  } else {
    await configManager.setDocsEnabled(enable);
  }

  if (enable) {
    console.log(`Starting ${service}…`);
    orch.startService(cfg, service, { onLog: (l) => console.log(l) });
    const port = service === "ui" ? cfg.uiPort : cfg.docsPort;
    console.log(`${service} is up on http://localhost:${port}`);
  } else {
    console.log(`Stopping ${service}…`);
    orch.stopService(cfg, service, { remove: true, onLog: (l) => console.log(l) });
    console.log(`${service} stopped.`);
  }
}

function makeToggleCommand(service: ServiceName, description: string): Command {
  return new Command(service)
    .description(description)
    .argument("<state>", "on or off")
    .option("--root <dir>", "Stack root directory")
    .addHelpText("after", `
Examples:
  $ propr ${service} on
  $ propr ${service} off
`)
    .action(async (state: string, options: { root?: string }) => {
      try {
        await toggleService(service, state, options.root);
      } catch (error) {
        console.error(`Error toggling ${service}: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}

export function createUiCommand(): Command {
  return makeToggleCommand("ui", "Start or stop the web UI service");
}

export function createDocsCommand(): Command {
  return makeToggleCommand("docs", "Start or stop the docs service");
}
