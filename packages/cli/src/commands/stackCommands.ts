/**
 * Control-plane stack commands: `propr status` and `propr stop`.
 *
 * (`propr start` lives in ../tui because it renders a live dashboard.)
 */

import { Command } from "commander";
import { createConfigManager } from "../config/index.js";
import { getHostConfig } from "../orchestrator/index.js";
import { renderStatusTable, renderTunnelSection } from "../orchestrator/format.js";
import { printOutput } from "../utils/index.js";

/** Creates the `status` command — local stack status. */
export function createStackStatusCommand(): Command {
  return new Command("status")
    .description("Show the status of the local ProPR stack")
    .option("--root <dir>", "Stack root directory")
    .option("--json", "Output raw JSON")
    .addHelpText("after", `
Examples:
  $ propr status
  $ propr status --json

(For backend job/queue status of a remote ProPR server, use 'propr remote-status'.)
`)
    .action(async (options: { root?: string; json?: boolean }) => {
      try {
        const configManager = await createConfigManager();
        const { orch, cfg } = await getHostConfig({ configManager, root: options.root });

        if (!orch.dockerAvailable()) {
          console.error("Error: cannot reach the Docker daemon. Run 'propr check'.");
          process.exit(1);
        }

        const status = orch.getStackStatus(cfg);
        // The Cloudflare tunnel is a local managed service, so its health is part
        // of local status. The reachability probe is best-effort with its own
        // timeout and never throws, so it cannot fail the status command.
        const tunnel = await orch.getTunnelStatus(cfg, status);
        if (printOutput({ ...status, tunnel }, options.json ?? false)) return;

        console.log("");
        console.log(renderStatusTable(status));
        console.log("");
        console.log(renderTunnelSection(tunnel));
        console.log("");
        if (!status.running) {
          console.log("Stack is not running. Start it with: propr start");
        }
      } catch (error) {
        console.error(`Error reading stack status: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}

/** Creates the `stop` command — stop (and remove) the local stack. */
export function createStopCommand(): Command {
  return new Command("stop")
    .description("Stop the local ProPR stack")
    .option("--root <dir>", "Stack root directory")
    .option("--keep", "Stop containers without removing them")
    .addHelpText("after", `
Examples:
  $ propr stop
  $ propr stop --keep
`)
    .action(async (options: { root?: string; keep?: boolean }) => {
      try {
        const configManager = await createConfigManager();
        const { orch, cfg } = await getHostConfig({ configManager, root: options.root });

        if (!orch.dockerAvailable()) {
          console.error("Error: cannot reach the Docker daemon. Run 'propr check'.");
          process.exit(1);
        }

        const before = orch.getStackStatus(cfg);
        if (!before.services.some((s) => s.exists)) {
          console.log("No ProPR stack containers found — nothing to stop.");
          return;
        }

        console.log("Stopping ProPR stack…");
        const { failed } = orch.stopStack(cfg, { remove: !options.keep, removeNetwork: !options.keep, onLog: (l) => console.log(l) });
        if (failed.length > 0) {
          console.error(`\nError: ${failed.length} container(s) could not be stopped: ${failed.join(", ")}`);
          console.error("Inspect them with `docker ps` / `docker logs` and retry `propr stop`.");
          process.exit(1);
        }
        console.log(options.keep ? "Stack stopped (containers kept)." : "Stack stopped and removed.");
      } catch (error) {
        console.error(`Error stopping stack: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
