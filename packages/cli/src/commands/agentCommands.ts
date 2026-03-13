/**
 * Agent Management Commands
 *
 * CLI commands for managing AI agent configurations.
 * Provides the `list-agents`, `add-agent`, and `delete-agent` commands.
 */

import { Command } from "commander";
import {
  listAgents,
  addAgent,
  deleteAgent,
  AgentConfig,
  AgentType,
} from "../api/agents.js";

/**
 * Formats an agent type for display.
 *
 * @param type - The agent type.
 * @returns A formatted type string.
 */
function formatType(type: string): string {
  const typeMap: Record<string, string> = {
    claude: "Claude",
    codex: "Codex",
    gemini: "Gemini",
  };
  return typeMap[type?.toLowerCase()] || type;
}

/**
 * Truncates a string to a maximum length.
 *
 * @param str - The string to truncate.
 * @param maxLen - The maximum length.
 * @returns The truncated string with "..." if it was too long.
 */
function truncate(str: string | null | undefined, maxLen: number): string {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + "...";
}

/**
 * Displays a table of agents with clean formatting.
 *
 * @param agents - The agents to display.
 */
function displayAgentsTable(agents: AgentConfig[]): void {
  // Calculate column widths
  const aliasWidth = Math.max(
    "Alias".length,
    ...agents.map((a) => a.alias.length)
  );
  const typeWidth = Math.max(
    "Type".length,
    ...agents.map((a) => formatType(a.type).length)
  );
  const enabledWidth = "Enabled".length;
  const defaultModelWidth = Math.max(
    "Default Model".length,
    ...agents.map((a) => truncate(a.defaultModel, 30).length)
  );
  const modelsWidth = Math.max(
    "Supported Models".length,
    ...agents.map((a) => truncate(a.supportedModels.join(", "), 40).length)
  );

  // Print header
  const header = [
    "Alias".padEnd(aliasWidth),
    "Type".padEnd(typeWidth),
    "Enabled".padEnd(enabledWidth),
    "Default Model".padEnd(defaultModelWidth),
    "Supported Models".padEnd(modelsWidth),
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  // Print each agent
  for (const agent of agents) {
    const row = [
      agent.alias.padEnd(aliasWidth),
      formatType(agent.type).padEnd(typeWidth),
      (agent.enabled ? "Yes" : "No").padEnd(enabledWidth),
      truncate(agent.defaultModel, 30).padEnd(defaultModelWidth),
      truncate(agent.supportedModels.join(", "), 40).padEnd(modelsWidth),
    ].join("  ");

    console.log(row);
  }
}

/**
 * Validates that the agent type is valid.
 *
 * @param type - The type string to validate.
 * @returns True if valid, false otherwise.
 */
function isValidAgentType(type: string): type is AgentType {
  return ["claude", "codex", "gemini"].includes(type.toLowerCase());
}

/**
 * Prompts the user for confirmation.
 *
 * @param message - The confirmation message.
 * @returns A promise resolving to true if confirmed, false otherwise.
 */
async function confirm(message: string): Promise<boolean> {
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

/**
 * Registers agent management commands on the given program.
 *
 * @param program - The Commander program to add commands to.
 */
export function registerAgentCommands(program: Command): void {
  // List agents command
  program
    .command("list-agents")
    .description("List all configured AI agents")
    .action(async () => {
      try {
        console.log("Fetching agents...");

        const result = await listAgents();

        if (result.agents.length === 0) {
          console.log("");
          console.log("No agents configured.");
          console.log("");
          console.log("To add an agent, use:");
          console.log("  propr add-agent <alias> --type <type> --model <models>");
          console.log("");
          console.log("Example:");
          console.log("  propr add-agent claude-prod --type claude --model claude-sonnet-4-20250514,claude-opus-4-20250514");
          return;
        }

        console.log("");
        displayAgentsTable(result.agents);

        console.log("");
        console.log(`Total: ${result.agents.length} agent(s)`);
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (
          errorMessage.includes("401") ||
          errorMessage.includes("unauthorized")
        ) {
          console.error(
            "Error: Unauthorized. Please run 'propr login' first."
          );
        } else {
          console.error(`Error listing agents: ${errorMessage}`);
        }
        process.exit(1);
      }
    });

  // Add agent command
  program
    .command("add-agent <alias>")
    .description("Add a new AI agent configuration")
    .requiredOption("-t, --type <type>", "Agent type (claude, codex, or gemini)")
    .requiredOption("-m, --model <models>", "Comma-separated list of supported models")
    .option("-d, --default-model <model>", "Default model to use (defaults to first model)")
    .option("--docker-image <image>", "Docker image for the agent")
    .option("--config-path <path>", "Host path to mount for configuration")
    .option("--disabled", "Create the agent in disabled state")
    .action(
      async (
        alias: string,
        options: {
          type: string;
          model: string;
          defaultModel?: string;
          dockerImage?: string;
          configPath?: string;
          disabled?: boolean;
        }
      ) => {
        try {
          // Validate agent type
          const type = options.type.toLowerCase();
          if (!isValidAgentType(type)) {
            console.error(
              `Error: Invalid agent type '${options.type}'. Must be one of: claude, codex, gemini`
            );
            process.exit(1);
          }

          // Parse models
          const models = options.model
            .split(",")
            .map((m) => m.trim())
            .filter((m) => m.length > 0);

          if (models.length === 0) {
            console.error("Error: At least one model must be specified");
            process.exit(1);
          }

          // Validate default model if specified
          if (options.defaultModel && !models.includes(options.defaultModel)) {
            console.error(
              `Error: Default model '${options.defaultModel}' is not in the list of supported models`
            );
            process.exit(1);
          }

          console.log(`Adding agent '${alias}'...`);

          const result = await addAgent({
            alias,
            type,
            models,
            defaultModel: options.defaultModel,
            dockerImage: options.dockerImage,
            configPath: options.configPath,
            enabled: !options.disabled,
          });

          if (result.success) {
            console.log("");
            console.log(`Agent '${alias}' added successfully!`);
            console.log("");
            console.log("Configuration:");
            console.log(`  Type:           ${formatType(type)}`);
            console.log(`  Enabled:        ${!options.disabled ? "Yes" : "No"}`);
            console.log(`  Models:         ${models.join(", ")}`);
            console.log(`  Default Model:  ${options.defaultModel || models[0]}`);
            console.log("");
            console.log(`Total agents configured: ${result.agents.length}`);
          } else {
            console.error("Failed to add agent");
            process.exit(1);
          }
        } catch (error) {
          const errorMessage = (error as Error).message;
          if (
            errorMessage.includes("401") ||
            errorMessage.includes("unauthorized")
          ) {
            console.error(
              "Error: Unauthorized. Please run 'propr login' first."
            );
          } else if (errorMessage.includes("already exists")) {
            console.error(`Error: ${errorMessage}`);
          } else {
            console.error(`Error adding agent: ${errorMessage}`);
          }
          process.exit(1);
        }
      }
    );

  // Delete agent command
  program
    .command("delete-agent <alias>")
    .description("Delete an AI agent configuration")
    .option("-f, --force", "Skip confirmation prompt")
    .action(async (alias: string, options: { force?: boolean }) => {
      try {
        // Confirm deletion unless --force is used
        if (!options.force) {
          console.log(`About to delete agent: ${alias}`);
          console.log("");
          const confirmed = await confirm(
            "Are you sure you want to delete this agent?"
          );
          if (!confirmed) {
            console.log("Deletion cancelled.");
            return;
          }
        }

        console.log(`Deleting agent '${alias}'...`);

        const result = await deleteAgent(alias);

        if (result.success) {
          console.log("");
          console.log(`Agent '${alias}' deleted successfully!`);
          console.log(`Remaining agents: ${result.agents.length}`);
        } else {
          console.error("Failed to delete agent");
          process.exit(1);
        }
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (
          errorMessage.includes("401") ||
          errorMessage.includes("unauthorized")
        ) {
          console.error(
            "Error: Unauthorized. Please run 'propr login' first."
          );
        } else if (errorMessage.includes("not found")) {
          console.error(`Error: Agent '${alias}' not found`);
        } else {
          console.error(`Error deleting agent: ${errorMessage}`);
        }
        process.exit(1);
      }
    });
}
