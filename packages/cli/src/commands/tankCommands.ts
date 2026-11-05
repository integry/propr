/**
 * `propr tank bundled|external|off` — configure Agent Tank LLM usage tracking.
 *
 * Agent Tank is a backend setting rather than a stack container, so this is a
 * setting flip routed through the running ProPR API.
 */

import { Command } from "commander";
import { AGENT_TANK_MODES, type AgentTankMode } from "@propr/shared";
import { getAgentTank, setAgentTank } from "../api/agentTank.js";
import { NetworkError, UnauthorizedError } from "../api/errors.js";

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

/**
 * `on` is kept as a deprecated alias for `external` rather than for `bundled`:
 * an existing user typing `propr tank on` today means "use my host install",
 * and silently repointing them at a container would change behavior under them.
 */
export function parseTankMode(value: string): AgentTankMode | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "off") return "disabled";
  if (normalized === "on") return "external";
  return (AGENT_TANK_MODES as readonly string[]).includes(normalized)
    ? normalized as AgentTankMode
    : undefined;
}

/** Only `external` talks to a URL, so only `external` prints one. */
function describeSettings(mode: AgentTankMode, url?: string): string {
  return mode === "external" && url ? `${mode}  (${url})` : mode;
}

export function createTankCommand(): Command {
  const tank = new Command("tank")
    .description("Configure Agent Tank LLM usage tracking (requires the stack running)")
    .argument("[mode]", "bundled, external, or off (omit to show the current mode)")
    .option("--url <url>", "Agent Tank service URL (external mode only)")
    .addHelpText("after", `
Modes:
  bundled   ProPR runs the Agent Tank CLI inside the agent image (no host install)
  external  Talk to an Agent Tank daemon you run yourself
  off       No usage tracking at all

Examples:
  $ propr tank                                     # show current mode
  $ propr tank bundled
  $ propr tank external --url http://127.0.0.1:3456
  $ propr tank off
`)
    .action(async (mode: string | undefined, options: { url?: string }) => {
      try {
        if (!mode) {
          const current = await getAgentTank();
          console.log(`Agent Tank: ${describeSettings(current.mode, current.url)}`);
          return;
        }

        const parsed = parseTankMode(mode);
        if (!parsed) {
          console.error(`Error: invalid mode "${mode}". Use one of: ${AGENT_TANK_MODES.join(", ")}, off`);
          process.exit(1);
        }
        if (options.url && parsed !== "external") {
          console.error(`Error: --url only applies to external mode.`);
          process.exit(1);
        }
        if (mode.trim().toLowerCase() === "on") {
          console.warn(`Note: "propr tank on" is deprecated; use "propr tank external".`);
        }

        const result = await setAgentTank(parsed, options.url);
        console.log(`Agent Tank set to ${describeSettings(result.mode, result.url)}.`);
      } catch (error) {
        handleApiError(error);
      }
    });

  return tank;
}
