#!/usr/bin/env node

import { Command } from "commander";
import { config } from "dotenv";
import { createConfigManager } from "./config/index.js";
import {
  createIssueCommand,
  createPlanCommand,
  createTaskCommand,
  createRepoCommand,
  createAgentCommand,
  createSettingCommand,
  createLogCommand,
  createStatusCommand,
  createQueueCommand,
} from "./commands/index.js";

// Re-export configuration module for programmatic use
export {
  ConfigManager,
  createConfigManager,
  CLIConfig,
  ConfigKey,
  DEFAULT_CONFIG,
} from "./config/index.js";

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
  ProjectOptions,
  ProjectResolutionError,
  formatOutput,
  printOutput,
  readJsonInput,
  validateJsonFields,
  isPlainObject,
  FormatOutputOptions,
  JsonInputError,
} from "./utils/index.js";

// Load environment variables
config();

const program = new Command();

program
  .name("propr")
  .description("CLI for interacting with the ProPR backend - AI-powered automated implementation of GitHub issues and pull requests")
  .version("1.0.0")
  .option("-p, --project <project>", "Specify the target project (owner/repo)")
  .option("-j, --json", "Output results as JSON for programmatic use")
  .addHelpText("before", `
ProPR CLI - AI-Powered GitHub Issue Implementation

ProPR enables automated implementation of GitHub issues using AI agents.
This CLI provides commands to manage plans, tasks, repositories, and agents.
`)
  .addHelpText("after", `
Quick Start:
  $ propr remote <url>              Set the backend API URL
  $ propr login <token>             Authenticate with GitHub
  $ propr use <owner/repo>          Set default project
  $ propr plan list                 View available implementation plans
  $ propr issue implement <id>      Implement a GitHub issue

JSON Output:
  Use --json (-j) flag with any command for machine-readable output:
  $ propr plan list --json
  $ propr agent list -j

Examples:
  $ propr remote https://api.propr.example.com
  $ propr login ghp_xxxxxxxxxxxx
  $ propr use myorg/myrepo
  $ propr plan create "Add dark mode toggle" --wait
  $ propr issue implement abc123/1 --wait --auto-merge
  $ propr task list -s processing
  $ propr status

Command Groups:
  Configuration:  remote, use, login, logout
  Plans:          plan [create|list|get|delete|abort]
  Implementation: issue [implement]
  Tasks:          task [list|get|stop|delete|revert]
  Repositories:   repo [list|add|remove|toggle|index|status]
  Agents:         agent [list|add|delete]
  Settings:       setting [get|update]
  Logs:           log [list]
  System:         status, queue

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

      // Interactive flow via gh CLI
      const { execSync, spawnSync } = await import("child_process");

      // Check if gh is installed
      try {
        execSync("gh --version", { stdio: "ignore" });
      } catch {
        console.error("Error: GitHub CLI (gh) is not installed.");
        console.log("");
        console.log("Install it from: https://cli.github.com");
        console.log("");
        console.log("Or provide a token directly:");
        console.log("  $ propr login <token>");
        process.exit(1);
      }

      // Try to get an existing token
      try {
        const existingToken = execSync("gh auth token", { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
        if (existingToken) {
          await configManager.setGithubToken(existingToken);
          console.log("Authenticated using existing gh CLI session.");
          console.log(`Token saved to: ${configManager.getConfigFilePath()}`);
          return;
        }
      } catch {
        // Not logged in yet — proceed to interactive login
      }

      // Launch interactive gh auth login
      console.log("No existing gh session found. Starting interactive login...");
      console.log("");

      const result = spawnSync("gh", ["auth", "login", "-s", "repo,read:org"], {
        stdio: "inherit",
      });

      if (result.status !== 0) {
        console.error("Error: GitHub login failed or was cancelled.");
        process.exit(1);
      }

      // Grab the token after successful login
      const ghToken = execSync("gh auth token", { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();

      if (!ghToken) {
        console.error("Error: Could not retrieve token after login.");
        process.exit(1);
      }

      await configManager.setGithubToken(ghToken);
      console.log("");
      console.log("Authentication successful!");
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

// Register command groups
program.addCommand(createPlanCommand());
program.addCommand(createIssueCommand());
program.addCommand(createTaskCommand());
program.addCommand(createRepoCommand());
program.addCommand(createAgentCommand());
program.addCommand(createSettingCommand());
program.addCommand(createLogCommand());
program.addCommand(createStatusCommand());
program.addCommand(createQueueCommand());

program.parse();

// If no command is provided, show help
if (!process.argv.slice(2).length) {
  console.log("ProPR CLI - Interact with the ProPR backend");
  console.log("");
  console.log("Run 'propr --help' for usage information.");
}
