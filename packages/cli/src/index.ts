#!/usr/bin/env node

import { Command } from "commander";
import { config } from "dotenv";

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

program.parse();

// If no command is provided, show help
if (!process.argv.slice(2).length) {
  console.log("ProPR CLI - Interact with the ProPR backend");
  console.log("");
  console.log("Run 'propr --help' for usage information.");
}
