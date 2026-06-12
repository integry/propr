/**
 * `propr start` — launch the local ProPR stack with a live dashboard.
 */

import { Command } from "commander";
import { createConfigManager } from "../config/index.js";
import { runStart } from "../tui/render.js";

export function createStartCommand(): Command {
  return new Command("start")
    .description("Start the local ProPR stack and show a live status dashboard")
    .option("--root <dir>", "Stack root directory (where .env/data/logs/repos live)")
    .option("--no-tui", "Skip the live dashboard; start and print a status snapshot")
    .option("--no-pull", "Skip pulling images before starting")
    .option("--restart", "Recreate services if the stack is already running")
    .addHelpText("after", `
Keys (live dashboard):
  b  background (keep the stack running)    q  stop the stack
  l  follow logs for the selected service   ↑/↓  select a service
  u  toggle the UI service                  r  refresh    ?  help

Examples:
  $ propr start
  $ propr start --restart
  $ propr start --no-tui
  $ propr start --root ~/propr
`)
    .action(async (options: { root?: string; tui?: boolean; pull?: boolean; restart?: boolean }) => {
      try {
        const configManager = await createConfigManager();
        await runStart(configManager, options);
      } catch (error) {
        console.error(`Error starting stack: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
