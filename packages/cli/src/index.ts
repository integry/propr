#!/usr/bin/env node

import { Command } from "commander";
import { config } from "dotenv";
import { createConfigManager } from "./config/index.js";
import { resolveProject, ProjectResolutionError } from "./utils/index.js";
import { listPlans, PlanSummary } from "./api/index.js";

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
} from "./utils/index.js";

// Load environment variables
config();

const program = new Command();

program
  .name("propr")
  .description("CLI for interacting with the ProPR backend")
  .version("1.0.0")
  .option("-p, --project <project>", "Specify the target project (owner/repo)");

// Remote command - set the API base URL
program
  .command("remote <url>")
  .description("Set the remote API base URL")
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
  .description("Set the default project (repository)")
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
  .description("Authenticate with a GitHub Personal Access Token")
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
  .description("Clear the stored GitHub token")
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
  .description("List implementation plans for a project")
  .option("-p, --project <project>", "Target project (owner/repo)")
  .action(async (options: { project?: string }) => {
    try {
      const configManager = await createConfigManager();
      const project = resolveProject(options, configManager);

      const result = await listPlans(project);

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

program.parse();

// If no command is provided, show help
if (!process.argv.slice(2).length) {
  console.log("ProPR CLI - Interact with the ProPR backend");
  console.log("");
  console.log("Run 'propr --help' for usage information.");
}
