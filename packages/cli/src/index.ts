#!/usr/bin/env node

import { Command } from "commander";
import { config } from "dotenv";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createConfigManager } from "./config/index.js";
import {
  createIssueCommand,
  createPlanCommand,
  createTaskCommand,
  createRepoCommand,
  createAgentCommand,
  createSettingCommand,
  createLogCommand,
  createTodoCommand,
  createRemoteStatusCommand,
  createQueueCommand,
  createInitCommand,
  createSetupCommand,
  createCheckCommand,
  createImagesCommand,
  createStartCommand,
  createStackStatusCommand,
  createStopCommand,
  createUiCommand,
  createDocsCommand,
  createTunnelCommand,
  createTankCommand,
  createRelayCommand,
  runChecks,
  printChecks,
  STACK_CONFIG_CHECK_NAME,
} from "./commands/index.js";

// Re-export configuration module for programmatic use
export {
  ConfigManager,
  createConfigManager,
  DEFAULT_CONFIG,
} from "./config/index.js";
export type { CLIConfig, ConfigKey } from "./config/index.js";

// Re-export API module for programmatic use
export {
  ApiClient,
  createApiClient,
  createApiClientWithConfig,
  ApiError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  BadRequestError,
  InternalServerError,
  NetworkError,
  TimeoutError,
  createApiError,
} from "./api/index.js";
export type {
  HttpMethod,
  RequestOptions,
  ApiClientOptions,
  ApiErrorCode,
  ApiErrorResponse,
  ApiResponse,
} from "./api/index.js";

// Re-export utilities module for programmatic use
export {
  resolveProject,
  ProjectResolutionError,
  formatOutput,
  printOutput,
  readJsonInput,
  validateJsonFields,
  isPlainObject,
  JsonInputError,
} from "./utils/index.js";
export type {
  ProjectOptions,
  FormatOutputOptions,
} from "./utils/index.js";

// Load environment variables
config();

const packageJson = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")
) as { version?: string };

const program = new Command();

program
  .name("propr")
  .description("ProPR control plane + backend client - run a local stack and implement GitHub issues with AI agents")
  .version(packageJson.version ?? "0.0.0")
  .option("-p, --project <project>", "Specify the target project (owner/repo)")
  .addHelpText("before", `
ProPR CLI - AI-Powered GitHub Issue Implementation

Run a local ProPR Docker stack (check / init / start / status / stop) and
drive the backend (plans, issues, tasks, repos, agents).
`)
  .addHelpText("after", `
Quick Start (local stack):
  $ propr                           Verify the environment (same as 'propr check')
  $ propr init stack                Scaffold .env + data/logs/repos, detect agents
  $ propr images pull               Pull stack images without starting
  $ propr start                     Start the stack with a live dashboard
  $ propr status                    Show local stack status
  $ propr stop                      Stop the stack

Quick Start (backend client):
  $ propr remote <url>              Set the backend API URL
  $ propr login <token>             Authenticate with GitHub
  $ propr use <owner/repo>          Set default project
  $ propr plan list                 View available implementation plans
  $ propr issue implement <id>      Implement a GitHub issue

JSON Output:
  Most commands support --json (-j) for machine-readable output:
  $ propr plan list --json
  $ propr agent list -j

Examples:
  $ propr remote https://api.propr.example.com
  $ propr login ghp_xxxxxxxxxxxx
  $ propr use myorg/myrepo
  $ propr plan create "Add dark mode toggle" --wait
  $ propr issue implement abc123/1 --wait --auto-merge
  $ propr task list -s processing
  $ propr remote-status

Command Groups:
  Control Plane:  check, images, init [repo|stack], start, status, stop, ui, docs, tunnel, tank
  GitHub Relay:   relay [enroll|list|revoke]
  Configuration:  remote, use, login, logout
  Plans:          plan [create|list|get|delete|abort]
  Implementation: issue [implement]
  Tasks:          task [list|get|stop|delete|revert]
  Repositories:   repo [list|add|remove|toggle|index|status]
  Agents:         agent [list|add|enable|disable|delete]
  Settings:       setting [get|update]
  To-Dos:         todo [list|get|add|complete|delete]
  Logs:           log [list]
  Backend:        remote-status, queue

For more information on a command, run:
  $ propr <command> --help
`);

// Remote command - set the API base URL
program
  .command("remote <url>")
  .description("Set the remote API base URL for ProPR backend")
  .addHelpText("after", `
Example:
  $ propr remote https://api.propr.example.com
`)
  .action(async (url: string) => {
    try {
      const configManager = await createConfigManager();
      await configManager.setRemoteUrl(url);
      console.log(`Remote URL set to: ${url}`);
      console.log(`Configuration saved to: ${configManager.getConfigFilePath()}`);
    } catch (error) {
      console.error(`Error setting remote URL: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// Use command - set the default project
program
  .command("use <project>")
  .description("Set the default project (repository) for subsequent commands")
  .addHelpText("after", `
Argument:
  project    Repository in owner/repo format (e.g., myorg/myrepo)

Example:
  $ propr use myorg/myrepo
`)
  .action(async (project: string) => {
    try {
      const configManager = await createConfigManager();
      await configManager.setDefaultProject(project);
      console.log(`Default project set to: ${project}`);
      console.log(`Configuration saved to: ${configManager.getConfigFilePath()}`);
    } catch (error) {
      console.error(`Error setting default project: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// Login command - authenticate with GitHub
program
  .command("login [token]")
  .description("Authenticate with GitHub (interactive via gh CLI, or provide a PAT)")
  .addHelpText("after", `
Argument:
  token    GitHub Personal Access Token (optional)

When no token is provided, the CLI uses 'gh' (GitHub CLI) to authenticate:
  - If you're already logged in to gh, your token is used automatically
  - If not, 'gh auth login' is launched interactively

Examples:
  $ propr login                       # Interactive login via gh CLI
  $ propr login ghp_xxxxxxxxxxxx      # Use a PAT directly
`)
  .action(async (token?: string) => {
    try {
      const configManager = await createConfigManager();

      if (token) {
        // Direct PAT flow
        const validPrefixes = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"];
        const hasValidPrefix = validPrefixes.some((prefix) => token.startsWith(prefix));

        if (!hasValidPrefix && token.length < 40) {
          console.warn(
            "Warning: The provided token does not appear to be a valid GitHub token format."
          );
          console.warn("GitHub personal access tokens typically start with 'ghp_'.");
          console.log("");
        }

        await configManager.setGithubToken(token);
        console.log("Authentication successful!");
        console.log(`Token saved to: ${configManager.getConfigFilePath()}`);
        return;
      }

      // Interactive flow via the gh CLI (shared with `propr setup`).
      const { loginWithGithubCli } = await import("./auth/githubLogin.js");
      const result = await loginWithGithubCli(configManager, {
        interactive: true,
        onLog: (line) => console.log(line),
      });
      if (!result.ok) {
        console.error(`Error: ${result.message}`);
        process.exit(1);
      }
      console.log("");
      console.log(result.message);
      console.log(`Token saved to: ${configManager.getConfigFilePath()}`);
    } catch (error) {
      console.error(`Error during login: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// Logout command - clear the GitHub token
program
  .command("logout")
  .description("Clear the stored GitHub token from configuration")
  .addHelpText("after", `
Example:
  $ propr logout
`)
  .action(async () => {
    try {
      const configManager = await createConfigManager();
      const existingToken = configManager.getGithubToken();

      if (!existingToken) {
        console.log("No token is currently configured.");
        return;
      }

      await configManager.clearGithubToken();
      console.log("Successfully logged out.");
      console.log("GitHub token has been removed from configuration.");
    } catch (error) {
      console.error(`Error clearing token: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// Control-plane commands (local Docker stack)
program.addCommand(createCheckCommand());
program.addCommand(createImagesCommand());
program.addCommand(createStartCommand());
program.addCommand(createStackStatusCommand());
program.addCommand(createStopCommand());
program.addCommand(createUiCommand());
program.addCommand(createDocsCommand());
program.addCommand(createTunnelCommand());
program.addCommand(createTankCommand());
program.addCommand(createRelayCommand());

// Setup + backend client command groups
program.addCommand(createInitCommand());
program.addCommand(createSetupCommand());
program.addCommand(createPlanCommand());
program.addCommand(createIssueCommand());
program.addCommand(createTaskCommand());
program.addCommand(createRepoCommand());
program.addCommand(createAgentCommand());
program.addCommand(createSettingCommand());
program.addCommand(createLogCommand());
program.addCommand(createTodoCommand());
program.addCommand(createRemoteStatusCommand());
program.addCommand(createQueueCommand());

// Bare `propr` (no args): run the environment check, then hint at next steps.
if (!process.argv.slice(2).length) {
  void (async () => {
    try {
      const outcome = await runChecks();
      printChecks(outcome);
      console.log("");
      if (outcome.results.some((r) => r.name === STACK_CONFIG_CHECK_NAME && r.status !== "ok")) {
        console.log("Next: `propr init stack` to scaffold a stack, then `propr start`.");
      } else {
        console.log("Next: `propr start` to launch the stack  ·  `propr --help` for all commands.");
      }
      process.exit(outcome.anyFail ? 1 : 0);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      console.log("Run 'propr --help' for usage information.");
      process.exit(1);
    }
  })();
} else {
  program.parse();
}
