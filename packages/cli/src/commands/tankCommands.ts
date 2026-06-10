/**
 * `propr tank on|off` — toggle Agent Tank LLM usage tracking.
 *
 * Agent Tank is an external service, not a stack container, so this is a backend
 * setting flip routed through the running ProPR API.
 */

import { Command } from "commander";
import { getAgentTank, setAgentTank } from "../api/agentTank.js";
import { NetworkError, UnauthorizedError } from "../api/errors.js";
import { parseOnOffState } from "../utils/index.js";

function handleApiError(error: unknown): never {
  if (error instanceof NetworkError) {
    console.error("Error: cannot reach the ProPR backend. Start the stack first: propr start");
  } else if (error instanceof UnauthorizedError) {
    console.error("Error: Unauthorized. Please run 'propr login' first.");
  } else {
    console.error(`Error updating Agent Tank: ${(error as Error).message}`);
  }
  process.exit(1);
}

export function createTankCommand(): Command {
  const tank = new Command("tank")
    .description("Toggle Agent Tank LLM usage tracking (requires the stack running)")
    .argument("[state]", "on or off (omit to show current setting)")
    .option("--url <url>", "Agent Tank service URL")
    .addHelpText("after", `
Examples:
  $ propr tank              # show current setting
  $ propr tank on
  $ propr tank off
  $ propr tank on --url http://127.0.0.1:3456
`)
    .action(async (state: string | undefined, options: { url?: string }) => {
      try {
        if (!state) {
          const current = await getAgentTank();
          console.log(`Agent Tank: ${current.enabled ? "on" : "off"}${current.url ? `  (${current.url})` : ""}`);
          return;
        }
        const enable = parseOnOffState(state);
        const result = await setAgentTank(enable, options.url);
        console.log(`Agent Tank ${result.enabled ? "enabled" : "disabled"}${result.url ? `  (${result.url})` : ""}.`);
      } catch (error) {
        if (error instanceof Error && /expected 'on' or 'off'/.test(error.message)) {
          console.error(`Error: ${error.message}`);
          process.exit(1);
        }
        handleApiError(error);
      }
    });

  return tank;
}
