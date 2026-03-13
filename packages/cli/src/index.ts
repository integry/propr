#!/usr/bin/env node

import { Command } from "commander";
import { config } from "dotenv";
import { createConfigManager } from "./config/index.js";

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

// Load environment variables
config();

const program = new Command();

program
  .name("propr")
  .description("CLI for interacting with the ProPR backend")
  .version("1.0.0");

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

program.parse();

// If no command is provided, show help
if (!process.argv.slice(2).length) {
  console.log("ProPR CLI - Interact with the ProPR backend");
  console.log("");
  console.log("Run 'propr --help' for usage information.");
}
