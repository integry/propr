/**
 * Agent Management Commands
 *
 * CLI commands for managing AI agent configurations.
 * Provides the `agent` command group with `list`, `add`, and `delete` subcommands.
 */

import { Command } from "commander";
import {
  listAgents,
  addAgent,
  deleteAgent,
  setAgentEnabled,
  AgentConfig,
  AgentType,
  AGENT_TYPES,
} from "../api/agents.js";
import {
  printOutput,
  readJsonInput,
  validateJsonFields,
  JsonInputError,
} from "../utils/index.js";

const AGENT_TYPE_LIST = AGENT_TYPES.join(", ");

/**
 * Formats an agent type for display.
 */
function formatType(type: string): string {
  const typeMap: Record<string, string> = {
    claude: "Claude",
    codex: "Codex",
    antigravity: "Antigravity",
    opencode: "OpenCode",
    vibe: "Mistral Vibe",
  };
  return typeMap[type?.toLowerCase()] || type;
}

/**
 * Truncates a string to a maximum length.
 */
function truncate(str: string | null | undefined, maxLen: number): string {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + "...";
}

/**
 * Displays a table of agents with clean formatting.
 */
function displayAgentsTable(agents: AgentConfig[]): void {
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

  const header = [
    "Alias".padEnd(aliasWidth),
    "Type".padEnd(typeWidth),
    "Enabled".padEnd(enabledWidth),
    "Default Model".padEnd(defaultModelWidth),
    "Supported Models".padEnd(modelsWidth),
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

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
 */
function isValidAgentType(type: string): type is AgentType {
  return AGENT_TYPES.includes(type.toLowerCase() as AgentType);
}

/**
 * Prompts the user for confirmation.
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
 * Creates the `agent` command group.
 */
export function createAgentCommand(): Command {
  const agent = new Command("agent")
    .description("Manage AI agent configurations")
    .addHelpText("after", `
Examples:
  $ propr agent list                              # List all agents
  $ propr agent add my-claude -t claude -m ...    # Add an agent
  $ propr agent delete my-agent                   # Delete an agent
`);

  // agent list
  agent
    .command("list")
    .description("List all configured AI agents with their models and status")
    .option("-j, --json", "Output as JSON for programmatic use")
    .addHelpText("after", `
Examples:
  $ propr agent list
  $ propr agent list --json
`)
    .action(async (options: { json?: boolean }) => {
      try {
        const result = await listAgents();

        if (printOutput(result, options.json ?? false)) {
          return;
        }

        console.log("Fetching agents...");

        if (result.agents.length === 0) {
          console.log("");
          console.log("No agents configured.");
          console.log("");
          console.log("To add an agent, use:");
          console.log("  propr agent add <alias> --type <type> --model <models>");
          console.log("");
          console.log("Example:");
          console.log("  propr agent add claude-prod --type claude --model claude-sonnet-4-20250514,claude-opus-4-20250514");
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

  // agent add
  agent
    .command("add [alias]")
    .description("Add a new AI agent configuration for code implementation")
    .option("-t, --type <type>", `Agent type (${AGENT_TYPE_LIST})`)
    .option("-m, --model <models>", "Comma-separated list of supported models")
    .option("-d, --default-model <model>", "Default model to use (defaults to first model)")
    .option("--docker-image <image>", "Docker image for the agent")
    .option("--config-path <path>", "Host path to mount for configuration")
    .option("--disabled", "Create the agent in disabled state")
    .option("-f, --file <path>", "Load agent configuration from JSON file (use '-' for stdin)")
    .option("-j, --json", "Output result as JSON")
    .addHelpText("after", `
Argument:
  alias    Unique identifier for the agent (required unless using --file)

Agent Types:
  claude       Anthropic Claude models
  codex        OpenAI Codex models
  antigravity  Antigravity models
  opencode     OpenCode models
  vibe         Mistral Vibe models

JSON File Format:
  {
    "alias": "my-agent",
    "type": "claude",
    "models": ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
    "defaultModel": "claude-sonnet-4-20250514",
    "dockerImage": "optional-image",
    "configPath": "/optional/path",
    "enabled": true
  }

Examples:
  $ propr agent add my-claude -t claude -m claude-sonnet-4-20250514
  $ propr agent add opencode -t opencode -m opencode/minimax-m3-free
  $ propr agent add prod-agent -t claude -m claude-sonnet-4-20250514,claude-opus-4-20250514 -d claude-sonnet-4-20250514
  $ propr agent add test-agent -t antigravity -m antigravity-gemini-3-pro-preview --disabled
  $ propr agent add --file agent-config.json
  $ cat config.json | propr agent add --file -
`)
    .action(
      async (
        aliasArg: string | undefined,
        options: {
          type?: string;
          model?: string;
          defaultModel?: string;
          dockerImage?: string;
          configPath?: string;
          disabled?: boolean;
          file?: string;
          json?: boolean;
        }
      ) => {
        try {
          let alias: string;
          let type: string;
          let models: string[];
          let defaultModel: string | undefined;
          let dockerImage: string | undefined;
          let configPath: string | undefined;
          let enabled: boolean;

          if (options.file) {
            try {
              const jsonConfig = await readJsonInput<{
                alias: string;
                type: string;
                models: string[];
                defaultModel?: string;
                dockerImage?: string;
                configPath?: string;
                enabled?: boolean;
              }>(options.file);

              validateJsonFields(jsonConfig, ["alias", "type", "models"]);

              alias = jsonConfig.alias;
              type = jsonConfig.type.toLowerCase();
              models = jsonConfig.models;
              defaultModel = jsonConfig.defaultModel;
              dockerImage = jsonConfig.dockerImage;
              configPath = jsonConfig.configPath;
              enabled = jsonConfig.enabled !== false;
            } catch (error) {
              if (error instanceof JsonInputError) {
                console.error(`Error: ${error.message}`);
              } else {
                console.error(`Error reading JSON file: ${(error as Error).message}`);
              }
              process.exit(1);
            }
          } else {
            if (!aliasArg) {
              console.error("Error: Alias is required. Provide it as an argument or use --file.");
              process.exit(1);
            }
            if (!options.type) {
              console.error("Error: --type is required when not using --file");
              process.exit(1);
            }
            if (!options.model) {
              console.error("Error: --model is required when not using --file");
              process.exit(1);
            }

            alias = aliasArg;
            type = options.type.toLowerCase();
            models = options.model
              .split(",")
              .map((m) => m.trim())
              .filter((m) => m.length > 0);
            defaultModel = options.defaultModel;
            dockerImage = options.dockerImage;
            configPath = options.configPath;
            enabled = !options.disabled;
          }

          if (!isValidAgentType(type)) {
            console.error(
              `Error: Invalid agent type '${type}'. Must be one of: ${AGENT_TYPE_LIST}`
            );
            process.exit(1);
          }

          if (models.length === 0) {
            console.error("Error: At least one model must be specified");
            process.exit(1);
          }

          if (defaultModel && !models.includes(defaultModel)) {
            console.error(
              `Error: Default model '${defaultModel}' is not in the list of supported models`
            );
            process.exit(1);
          }

          if (!options.json) {
            console.log(`Adding agent '${alias}'...`);
          }

          const result = await addAgent({
            alias,
            type,
            models,
            defaultModel,
            dockerImage,
            configPath,
            enabled,
          });

          if (result.success) {
            if (printOutput(result, options.json ?? false)) {
              return;
            }

            console.log("");
            console.log(`Agent '${alias}' added successfully!`);
            console.log("");
            console.log("Configuration:");
            console.log(`  Type:           ${formatType(type)}`);
            console.log(`  Enabled:        ${enabled ? "Yes" : "No"}`);
            console.log(`  Models:         ${models.join(", ")}`);
            console.log(`  Default Model:  ${defaultModel || models[0]}`);
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

  // agent enable / disable
  const applyEnabled = async (alias: string, enabled: boolean): Promise<void> => {
    try {
      const result = await setAgentEnabled(alias, enabled);
      if (result.success) {
        console.log(`Agent '${alias}' ${enabled ? "enabled" : "disabled"}.`);
      } else {
        console.error(`Failed to ${enabled ? "enable" : "disable"} agent '${alias}'`);
        process.exit(1);
      }
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.includes("ECONNREFUSED") || msg.includes("network") || msg.includes("fetch failed")) {
        console.error("Error: cannot reach the ProPR backend. Start the stack first: propr start");
      } else if (msg.includes("not found")) {
        console.error(`Error: Agent '${alias}' not found`);
      } else if (msg.includes("401") || msg.includes("unauthorized")) {
        console.error("Error: Unauthorized. Please run 'propr login' first.");
      } else {
        console.error(`Error updating agent: ${msg}`);
      }
      process.exit(1);
    }
  };

  agent
    .command("enable <alias>")
    .description("Enable an agent (requires the stack to be running)")
    .addHelpText("after", `
Example:
  $ propr agent enable claude-prod
`)
    .action(async (alias: string) => {
      await applyEnabled(alias, true);
    });

  agent
    .command("disable <alias>")
    .description("Disable an agent (requires the stack to be running)")
    .addHelpText("after", `
Example:
  $ propr agent disable claude-prod
`)
    .action(async (alias: string) => {
      await applyEnabled(alias, false);
    });

  // agent delete
  agent
    .command("delete <alias>")
    .description("Delete an AI agent configuration permanently")
    .option("-f, --force", "Skip confirmation prompt")
    .addHelpText("after", `
Argument:
  alias    The alias of the agent to delete

Examples:
  $ propr agent delete my-agent           # With confirmation
  $ propr agent delete my-agent --force   # Skip confirmation
`)
    .action(async (alias: string, options: { force?: boolean }) => {
      try {
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

  return agent;
}
