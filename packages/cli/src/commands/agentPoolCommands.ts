import { Command } from "commander";
import type { SyntheticAgentConfig } from "@propr/shared";
import {
  deleteSyntheticAgent,
  listSyntheticAgents,
  saveSyntheticAgents,
  type SyntheticAgentsResponse,
} from "../api/syntheticPools.js";
import { NetworkError } from "../api/errors.js";
import { JsonInputError, printOutput, readJsonInput } from "../utils/io.js";
import { presentApiError } from "../utils/apiErrorPresentation.js";

function poolsFromInput(value: unknown): SyntheticAgentConfig[] {
  if (Array.isArray(value)) return value as SyntheticAgentConfig[];
  if (value && typeof value === "object") {
    const pools = (value as Partial<SyntheticAgentsResponse>).synthetic_agents;
    if (Array.isArray(pools)) return pools;
  }
  throw new JsonInputError(
    "Input must be a synthetic_agents response from 'pool list --json' or an array of synthetic agents"
  );
}

function printPoolTable(pools: SyntheticAgentConfig[]): void {
  if (pools.length === 0) {
    console.log("No synthetic pools configured.");
    return;
  }

  console.log("Alias                 Enabled  Default model         Virtual models");
  console.log("---------------------------------------------------------------------");
  for (const pool of pools) {
    const models = pool.models.map((model) => model.id).join(", ");
    console.log(
      `${pool.alias.padEnd(21)} ${String(pool.enabled ? "Yes" : "No").padEnd(8)} ${pool.defaultModel.padEnd(21)} ${models}`
    );
  }
}

function reportPoolError(error: unknown, action: string): void {
  if (error instanceof NetworkError) {
    console.error("Error: cannot reach the ProPR backend. Start the stack first: propr start");
    return;
  }
  if (error instanceof JsonInputError) {
    console.error(`Error: ${error.message}`);
    return;
  }
  presentApiError(error, {
    forbiddenMessage: "Error: Access denied. You do not have permission to manage synthetic pools.",
    // Preserve the backend's nested-field validation message verbatim.
    fallbackMessage: (message) => `Error ${action} synthetic pools: ${message}`,
  });
}

export function createAgentPoolCommand(): Command {
  const pool = new Command("pool")
    .description("Manage synthetic agent pools")
    .addHelpText("after", `
Examples:
  $ propr agent pool list
  $ propr agent pool list --json > pools.json
  $ propr agent pool apply pools.json
  $ cat pools.json | propr agent pool apply -
  $ propr agent pool delete balanced-pool
`);

  pool.command("list")
    .description("List the complete synthetic pool configuration")
    .option("-j, --json", "Output JSON that can be passed unchanged to pool apply")
    .action(async (options: { json?: boolean }) => {
      try {
        const result = await listSyntheticAgents();
        if (printOutput(result, options.json ?? false)) return;
        printPoolTable(result.synthetic_agents);
      } catch (error) {
        reportPoolError(error, "listing");
        process.exitCode = 1;
      }
    });

  pool.command("apply <file>")
    .description("Replace synthetic pools from a JSON file, or '-' for stdin")
    .option("-j, --json", "Output the backend response as JSON")
    .action(async (file: string, options: { json?: boolean }) => {
      try {
        const pools = poolsFromInput(await readJsonInput(file));
        const result = await saveSyntheticAgents(pools);
        if (printOutput(result, options.json ?? false)) return;
        console.log(`Applied ${result.synthetic_agents.length} synthetic pool(s).`);
        for (const warning of result.warnings ?? []) console.warn(`Warning: ${warning}`);
      } catch (error) {
        reportPoolError(error, "applying");
        process.exitCode = 1;
      }
    });

  pool.command("delete <id-or-alias>")
    .description("Delete a synthetic pool by ID or alias")
    .option("-j, --json", "Output the backend response as JSON")
    .action(async (idOrAlias: string, options: { json?: boolean }) => {
      try {
        const result = await deleteSyntheticAgent(idOrAlias);
        if (printOutput(result, options.json ?? false)) return;
        console.log(`Deleted synthetic pool '${idOrAlias}'.`);
      } catch (error) {
        reportPoolError(error, "deleting");
        process.exitCode = 1;
      }
    });

  return pool;
}
