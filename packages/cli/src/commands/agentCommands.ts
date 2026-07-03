/**
 * Agent Management Commands
 *
 * CLI commands for managing AI agent configurations.
 * Provides the `agent` command group with `list`, `add`, and `delete` subcommands.
 */

import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listAgents,
  addAgent,
  deleteAgent,
  setAgentEnabled,
  AgentConfig,
  AgentType,
  AGENT_TYPES,
} from "../api/agents.js";
import { createConfigManager } from "../config/index.js";
import { getHostConfig } from "../orchestrator/index.js";
import { planAgentLogin, loginableAgents } from "./agentValidation.js";
import { ApiError, NetworkError, NotFoundError, UnauthorizedError } from "../api/errors.js";
import {
  printOutput,
  readJsonInput,
  validateJsonFields,
  JsonInputError,
  confirm,
} from "../utils/index.js";
import {
  CLI_EXIT_CODES,
  exitWithError,
  exitWithUsageError,
  errorMessage,
  getExitCodeForError,
} from "../utils/cliErrors.js";

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
 * Creates the `agent` command group.
 */
export function createAgentCommand(): Command {
  const agent = new Command("agent")
    .description("Manage AI agent configurations")
    .addHelpText("after", `
Examples:
  $ propr agent list                              # List all agents
  $ propr agent add my-claude -t claude -m ...    # Add an agent
  $ propr agent login antigravity                 # Authenticate an agent via its image
  $ propr agent enable my-agent                   # Enable / disable an agent
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
  $ propr agent login antigravity
  $ propr agent enable claude
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
        if (error instanceof UnauthorizedError) {
          console.error("Error: Unauthorized. Please run 'propr login' first.");
        } else if (error instanceof NetworkError) {
          console.error("Error: cannot reach the ProPR backend. Start the stack first: propr start");
        } else {
          console.error(`Error listing agents: ${(error as Error).message}`);
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
  $ propr agent add opencode -t opencode -m opencode-minimax-m3-free
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
              if (options.json) {
                exitWithError(error, {
                  json: true,
                  message: errorMessage(error),
                  exitCode: CLI_EXIT_CODES.usage,
                  code: "JSON_INPUT_ERROR",
                });
              }
              if (error instanceof JsonInputError) {
                console.error(`Error: ${error.message}`);
              } else {
                console.error(`Error reading JSON file: ${(error as Error).message}`);
              }
              process.exit(CLI_EXIT_CODES.usage);
            }
          } else {
            if (!aliasArg) {
              exitWithUsageError("Alias is required. Provide it as an argument or use --file.", options.json);
            }
            if (!options.type) {
              exitWithUsageError("--type is required when not using --file", options.json);
            }
            if (!options.model) {
              exitWithUsageError("--model is required when not using --file", options.json);
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
            exitWithUsageError(`Invalid agent type '${type}'. Must be one of: ${AGENT_TYPE_LIST}`, options.json);
          }

          if (models.length === 0) {
            exitWithUsageError("At least one model must be specified", options.json);
          }

          if (defaultModel && !models.includes(defaultModel)) {
            exitWithUsageError(
              `Default model '${defaultModel}' is not in the list of supported models`,
              options.json
            );
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
            exitWithError(new Error("Failed to add agent"), {
              json: options.json,
              message: "Failed to add agent",
              exitCode: CLI_EXIT_CODES.general,
            });
          }
        } catch (error) {
          if (options.json) {
            exitWithError(error, {
              json: true,
              message: errorMessage(error),
              code: errorMessage(error).includes("already exists") ? "ALREADY_EXISTS" : undefined,
            });
          }
          if (error instanceof UnauthorizedError) {
            console.error("Error: Unauthorized. Please run 'propr login' first.");
          } else if (error instanceof NetworkError) {
            console.error("Error: cannot reach the ProPR backend. Start the stack first: propr start");
          } else if (error instanceof ApiError && (error as Error).message.includes("already exists")) {
            console.error(`Error: ${(error as Error).message}`);
          } else {
            console.error(`Error adding agent: ${(error as Error).message}`);
          }
          process.exit(getExitCodeForError(error));
        }
      }
    );

  // agent enable / disable
  const applyEnabled = async (alias: string, enabled: boolean, json?: boolean): Promise<void> => {
    try {
      const result = await setAgentEnabled(alias, enabled);
      if (result.success) {
        if (printOutput(result, json ?? false)) {
          return;
        }
        console.log(`Agent '${alias}' ${enabled ? "enabled" : "disabled"}.`);
      } else {
        exitWithError(new Error(`Failed to ${enabled ? "enable" : "disable"} agent '${alias}'`), {
          json,
          message: `Failed to ${enabled ? "enable" : "disable"} agent '${alias}'`,
          exitCode: CLI_EXIT_CODES.general,
        });
      }
    } catch (error) {
      if (json) {
        const message = errorMessage(error);
        exitWithError(error, {
          json: true,
          message,
          code: message.includes("not found") ? "NOT_FOUND" : undefined,
        });
      }
      if (error instanceof NetworkError) {
        console.error("Error: cannot reach the ProPR backend. Start the stack first: propr start");
      } else if (error instanceof NotFoundError || (error instanceof Error && error.message.includes("not found"))) {
        console.error(`Error: Agent '${alias}' not found`);
      } else if (error instanceof UnauthorizedError) {
        console.error("Error: Unauthorized. Please run 'propr login' first.");
      } else if (error instanceof ApiError) {
        console.error(`Error updating agent: ${error.message}`);
      } else {
        console.error(`Error updating agent: ${(error as Error).message}`);
      }
      process.exit(getExitCodeForError(error));
    }
  };

  agent
    .command("enable <alias>")
    .description("Enable an agent (requires the stack to be running)")
    .option("-j, --json", "Output result as JSON")
    .addHelpText("after", `
Example:
  $ propr agent enable claude-prod
  $ propr agent enable claude-prod --json
`)
    .action(async (alias: string, options: { json?: boolean }) => {
      await applyEnabled(alias, true, options.json);
    });

  agent
    .command("disable <alias>")
    .description("Disable an agent (requires the stack to be running)")
    .option("-j, --json", "Output result as JSON")
    .addHelpText("after", `
Example:
  $ propr agent disable claude-prod
  $ propr agent disable claude-prod --json
`)
    .action(async (alias: string, options: { json?: boolean }) => {
      await applyEnabled(alias, false, options.json);
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
        if (error instanceof UnauthorizedError) {
          console.error("Error: Unauthorized. Please run 'propr login' first.");
        } else if (error instanceof NotFoundError) {
          console.error(`Error: Agent '${alias}' not found`);
        } else if (error instanceof NetworkError) {
          console.error("Error: cannot reach the ProPR backend. Start the stack first: propr start");
        } else {
          console.error(`Error deleting agent: ${(error as Error).message}`);
        }
        process.exit(1);
      }
    });

  // agent login
  agent
    .command("login [type]")
    .description("Authenticate an agent by logging in through its Docker image (writes host credentials)")
    .option("--root <dir>", "Stack root directory (where .env/data/logs/repos live)")
    .addHelpText("after", `
Logs in using the agent's own pinned CLI inside its image, with the credential
directory mounted — so the credentials match exactly what runs jobs (no host
install or host/image version drift). Useful after a failed image check.

Examples:
  $ propr agent login antigravity
  $ propr agent login opencode
`)
    .action(async (type: string | undefined, options: { root?: string }) => {
      try {
        const available = loginableAgents();
        if (!type) {
          console.log("Usage: propr agent login <type>");
          console.log(`Agents with interactive login: ${available.join(", ")}`);
          return;
        }
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          console.error("Error: propr agent login requires an interactive terminal because Docker login runs with -it.");
          process.exit(1);
        }

        const configManager = await createConfigManager();
        const { orch, cfg } = await getHostConfig({ configManager, root: options.root });

        const tmp = mkdtempSync(join(tmpdir(), "propr-login-"));
        const workspaceDir = join(tmp, "workspace");
        mkdirSync(workspaceDir, { recursive: true });
        try {
          const loginType = type.toLowerCase();
          const { plan, error } = planAgentLogin(loginType, cfg, workspaceDir, orch.validateDockerBindPath);
          if (error || !plan) {
            console.error(`Error: ${error ?? "could not plan login"}`);
            if (available.length > 0) console.error(`Agents with interactive login: ${available.join(", ")}`);
            // exitCode + return (not process.exit) so the finally block still
            // removes the temp directory.
            process.exitCode = 1;
            return;
          }

          if (orch.docker(["images", "-q", plan.image], { capture: true }).stdout.trim().length === 0) {
            console.error(`Image ${plan.image} is not present locally. Pull it first: propr images pull`);
            process.exitCode = 1;
            return;
          }

          mkdirSync(plan.hostDir, { recursive: true, mode: 0o700 });
          console.log(`Logging in to ${loginType} via ${plan.image}`);
          console.log(`Credentials will be written to ${plan.hostDir}`);
          console.log("");
          const res = spawnSync("docker", plan.dockerArgs, { stdio: "inherit" });
          if (res.status === 0) {
            console.log("");
            console.log(`${loginType} login finished. Verify with: propr check agents --agents ${loginType}`);
          } else {
            console.error(`\n${loginType} login exited with code ${res.status ?? "?"}.`);
            process.exitCode = 1;
          }
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      } catch (error) {
        console.error(`Error during agent login: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  return agent;
}
