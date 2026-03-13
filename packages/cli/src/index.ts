#!/usr/bin/env node

import { Command } from "commander";
import { config } from "dotenv";
import { createConfigManager } from "./config/index.js";
import { resolveProject, ProjectResolutionError } from "./utils/index.js";
import { listPlans, createPlan, getPlan, PlanSummary, Plan, PlanStatus } from "./api/index.js";
import { registerImplementCommands, registerPlanCommands, registerTaskCommands, registerRepoCommands, registerAgentCommands, registerSettingCommands, registerLogCommands, registerSystemCommands } from "./commands/index.js";

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
  $ propr list-plans                View available implementation plans
  $ propr implement-issue <id>      Implement a GitHub issue

JSON Output:
  Use --json (-j) flag with any command for machine-readable output:
  $ propr list-plans --json
  $ propr list-agents -j

Examples:
  $ propr remote https://api.propr.example.com
  $ propr login ghp_xxxxxxxxxxxx
  $ propr use myorg/myrepo
  $ propr create-plan "Add dark mode toggle" --wait
  $ propr implement-issue abc123/1 --wait --auto-merge
  $ propr list-tasks -s processing
  $ propr system-status

Command Groups:
  Configuration:  remote, use, login, logout
  Plans:          create-plan, list-plans, get-plan, delete-plan, abort-plan
  Implementation: implement-issue
  Tasks:          list-tasks, get-task, stop-task, delete-task, revert-task
  Repositories:   list-repos, add-repo, remove-repo, toggle-repo, index-repo, repo-status
  Agents:         list-agents, add-agent, delete-agent
  Settings:       get-settings, update-setting
  Logs:           list-logs
  System:         system-status, queue-stats

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

// Login command - authenticate with GitHub token
program
  .command("login [token]")
  .description("Authenticate with a GitHub Personal Access Token (PAT)")
  .addHelpText("after", `
Argument:
  token    GitHub Personal Access Token (optional - shows instructions if omitted)

Required Token Scopes:
  - repo      Full control of private repositories
  - read:org  Read organization membership

Example:
  $ propr login ghp_xxxxxxxxxxxx

To generate a token:
  1. Go to https://github.com/settings/tokens
  2. Click "Generate new token (classic)"
  3. Select scopes: repo, read:org
  4. Copy and use the generated token
`)
  .action(async (token?: string) => {
    try {
      const configManager = await createConfigManager();

      if (!token) {
        // No token provided - show instructions
        console.log("No token provided.");
        console.log("");
        console.log("Usage: propr login <token>");
        console.log("");
        console.log("To generate a GitHub Personal Access Token:");
        console.log("  1. Go to https://github.com/settings/tokens");
        console.log("  2. Click 'Generate new token (classic)'");
        console.log("  3. Select the required scopes (repo, read:org)");
        console.log("  4. Copy the generated token");
        console.log("  5. Run: propr login <your-token>");
        process.exit(1);
      }

      // Validate token format (basic check - GitHub tokens start with specific prefixes)
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
    } catch (error) {
      console.error(`Error saving token: ${(error as Error).message}`);
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

// List-plans command - list plans for a project
program
  .command("list-plans")
  .description("List all implementation plans for a project")
  .option("-p, --project <project>", "Target project (owner/repo)")
  .option("-j, --json", "Output as JSON for programmatic use")
  .addHelpText("after", `
Examples:
  $ propr list-plans                    # Use default project
  $ propr list-plans -p myorg/myrepo    # Specify project
  $ propr list-plans --json             # JSON output
`)
  .action(async (options: { project?: string; json?: boolean }) => {
    try {
      const configManager = await createConfigManager();
      const project = resolveProject(options, configManager);

      const result = await listPlans(project);

      // Handle JSON output
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.drafts.length === 0) {
        console.log(`No plans found for project: ${project}`);
        console.log("");
        console.log("To create a new plan, use the ProPR dashboard or API.");
        return;
      }

      console.log(`Plans for ${project}:`);
      console.log("");

      // Calculate column widths for neat formatting
      const idWidth = Math.max(
        "ID".length,
        ...result.drafts.map((p: PlanSummary) => p.draft_id.length)
      );
      const nameWidth = Math.max(
        "Name".length,
        ...result.drafts.map((p: PlanSummary) => p.name.length)
      );
      const statusWidth = Math.max(
        "Status".length,
        ...result.drafts.map((p: PlanSummary) => p.status.length)
      );

      // Print header
      const header = `${"ID".padEnd(idWidth)}  ${"Name".padEnd(nameWidth)}  ${"Status".padEnd(statusWidth)}`;
      console.log(header);
      console.log("-".repeat(header.length));

      // Print each plan
      for (const plan of result.drafts) {
        console.log(
          `${plan.draft_id.padEnd(idWidth)}  ${plan.name.padEnd(nameWidth)}  ${plan.status.padEnd(statusWidth)}`
        );
      }

      console.log("");
      console.log(`Total: ${result.total} plan(s)`);

      if (result.hasMore) {
        console.log(`Showing page ${result.page} of results. More plans available.`);
      }
    } catch (error) {
      if (error instanceof ProjectResolutionError) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      console.error(`Error fetching plans: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// Create-plan command - create a new implementation plan
program
  .command("create-plan <prompt>")
  .description("Create a new implementation plan from a natural language prompt")
  .option("-p, --project <project>", "Target project (owner/repo)")
  .option("-b, --branch <branch>", "Target branch (default: main)", "main")
  .option("-w, --wait", "Wait for plan generation to complete")
  .addHelpText("after", `
Argument:
  prompt    Natural language description of what to implement

Examples:
  $ propr create-plan "Add user authentication with JWT"
  $ propr create-plan "Fix the login page styling" --wait
  $ propr create-plan "Add dark mode" -b develop -p myorg/myrepo --wait
`)
  .action(async (prompt: string, options: { project?: string; branch: string; wait?: boolean }) => {
    try {
      const configManager = await createConfigManager();
      const project = resolveProject(options, configManager);

      console.log(`Creating plan for ${project}...`);

      // Create the plan
      const plan = await createPlan(project, prompt, {
        contextConfig: {
          branch: options.branch,
        },
      });

      console.log(`Plan created with ID: ${plan.draft_id}`);
      console.log(`Status: ${plan.status}`);

      if (!options.wait) {
        // Return immediately with the plan ID
        console.log("");
        console.log(`Use 'propr list-plans' to check the status.`);
        return;
      }

      // Poll for completion
      console.log("");
      console.log("Waiting for plan generation to complete...");

      const terminalStatuses: PlanStatus[] = ["draft", "review", "approved", "failed", "executed", "merged", "pr_created"];
      const pollIntervalMs = 3000;
      const maxWaitMs = 600000; // 10 minutes
      const startTime = Date.now();

      let currentPlan: Plan = plan;
      let lastStatus = plan.status;

      while (Date.now() - startTime < maxWaitMs) {
        // Wait before polling
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

        currentPlan = await getPlan(plan.draft_id);

        // Print progress if status changed
        if (currentPlan.status !== lastStatus) {
          console.log(`Status: ${currentPlan.status}`);
          lastStatus = currentPlan.status;
        }

        // Check if we've reached a terminal state
        if (terminalStatuses.includes(currentPlan.status)) {
          break;
        }
      }

      // Final status
      console.log("");
      if (currentPlan.status === "failed") {
        console.error("Plan generation failed.");
        process.exit(1);
      } else if (terminalStatuses.includes(currentPlan.status)) {
        console.log(`Plan generation completed.`);
        console.log(`Final status: ${currentPlan.status}`);
        if (currentPlan.name) {
          console.log(`Name: ${currentPlan.name}`);
        }
      } else {
        console.log(`Timeout: Plan is still ${currentPlan.status} after ${Math.round((Date.now() - startTime) / 1000)} seconds.`);
        console.log(`Plan ID: ${currentPlan.draft_id}`);
        console.log(`Use 'propr list-plans' to check the status.`);
      }
    } catch (error) {
      if (error instanceof ProjectResolutionError) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      console.error(`Error creating plan: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// Register implementation commands
registerImplementCommands(program);

// Register plan management commands
registerPlanCommands(program);

// Register task management commands
registerTaskCommands(program);

// Register repository management commands
registerRepoCommands(program);

// Register agent management commands
registerAgentCommands(program);

// Register system settings commands
registerSettingCommands(program);

// Register LLM log commands
registerLogCommands(program);

// Register system status commands
registerSystemCommands(program);

program.parse();

// If no command is provided, show help
if (!process.argv.slice(2).length) {
  console.log("ProPR CLI - Interact with the ProPR backend");
  console.log("");
  console.log("Run 'propr --help' for usage information.");
}
