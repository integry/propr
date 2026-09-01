#!/usr/bin/env node

import { Command } from "commander";
import { config } from "dotenv";
import { readFileSync, realpathSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createConfigManager } from "./config/index.js";
import { completionScript } from "./completion.js";
import { isValidRemoteUrl } from "./commands/configCommands.js";
import {
  configureProjectOptionInheritance,
  normalizeProjectSlug,
  ProjectResolutionError,
} from "./utils/index.js";
import {
  createIssueCommand,
  createPlanCommand,
  createTaskCommand,
  createRepoCommand,
  createAgentCommand,
  createSettingCommand,
  createConfigCommand,
  createLogCommand,
  createTodoCommand,
  createRemoteStatusCommand,
  createQueueCommand,
  createBackendCommand,
  createInitCommand,
  createSetupCommand,
  createAgentSkillCommand,
  createCheckCommand,
  createImagesCommand,
  createStartCommand,
  createStackStatusCommand,
  createStopCommand,
  createUiCommand,
  createDocsCommand,
  createTunnelCommand,
  createConnectCommand,
  createTankCommand,
  createRelayCommand,
  createRuntimeCommand,
  runChecks,
  printChecks,
  STACK_CONFIG_CHECK_NAME,
} from "./commands/index.js";
import {
  CONNECT_STATUS_EXIT,
  invalidConnectRootStatus,
} from "./commands/connectCommand.js";

// Re-export completion generation for programmatic use
export { completionScript, buildCompletionMetadata } from "./completion.js";
export type { CompletionShell, CompletionMetadata } from "./completion.js";

// Re-export configuration module for programmatic use
export {
  ConfigManager,
  createConfigManager,
  isValidRemoteProfileName,
  DEFAULT_CONFIG,
} from "./config/index.js";
export type { CLIConfig, ConfigKey, RemoteProfile } from "./config/index.js";

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
  resolveOptionalProject,
  configureProjectOptionInheritance,
  ProjectResolutionError,
  isValidProjectSlug,
  normalizeProjectSlug,
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

/** Return only raw CLI arguments which precede the POSIX end-of-options marker. */
function argsBeforeEndOfOptions(argv: readonly string[]): readonly string[] {
  const args = argv.slice(2);
  const delimiterIndex = args.indexOf("--");
  return delimiterIndex === -1 ? args : args.slice(0, delimiterIndex);
}

/** Parse the discovery shape without depending on option order or spelling. */
export function isExplicitConnectStatusInvocation(argv: readonly string[]): boolean {
  const args = argsBeforeEndOfOptions(argv);
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--root") {
      const value = args[index + 1];
      if (value !== undefined && value !== "" && !value.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--root=")) {
      continue;
    }
    if (arg === "--project" || arg === "-p") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--project=") || arg === "--json" || arg === "-j") continue;
    if (!arg.startsWith("-")) positionals.push(arg);
  }
  return positionals[0] === "connect" && positionals[1] === "status";
}

/** Require one non-empty raw root option before Commander can reject or overwrite it. */
export function hasExactlyOneExplicitConnectStatusRoot(argv: readonly string[]): boolean {
  if (!isExplicitConnectStatusInvocation(argv)) return false;
  const args = argsBeforeEndOfOptions(argv);
  let rootCount = 0;
  let rootIsValid = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--root") {
      rootCount += 1;
      const value = args[index + 1];
      if (value === undefined || value === "" || value.startsWith("-")) {
        rootIsValid = false;
      } else {
        index += 1;
      }
    } else if (arg.startsWith("--root=")) {
      rootCount += 1;
      if (arg.slice("--root=".length).length === 0) rootIsValid = false;
    }
  }
  return rootCount === 1 && rootIsValid;
}

// Identify the command shape before Commander validates required, malformed, or
// duplicate root options. Every Connect status invocation (and therefore every
// --json failure shape) must avoid pre-reading a replaceable cwd/.env.
const connectStatusInvocation = isExplicitConnectStatusInvocation(process.argv);
const connectStatusHelpRequested = connectStatusInvocation
  && argsBeforeEndOfOptions(process.argv).some((arg) => arg === "--help" || arg === "-h");
const malformedConnectStatusRoot = connectStatusInvocation
  && !hasExactlyOneExplicitConnectStatusRoot(process.argv);
if (!connectStatusInvocation) config();

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
  $ propr skill install codex       Install the ProPR Operator Agent Skill
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
  $ propr task inspect                 # Active work, including queued tasks
  $ propr task inspect <task-id>       # Current state and full run history
  $ propr remote-status

Command Groups:
  Control Plane:  check, images, init [repo|stack], start, status, stop, ui, docs, tunnel, tank, runtime
  GitHub Relay:   relay [enroll|list|revoke]
  Configuration:  config, remote, use, login, logout
  Plans:          plan [create|list|get|delete|abort]
  Implementation: issue [implement]
  Tasks:          task [inspect|list|get|stop|delete|followup|import|revert]
  Repositories:   repo [list|add|remove|toggle|index|status]
  Agents:         agent [list|add|enable|disable|delete]
  Settings:       setting [get|update|reindex-summaries]
  To-Dos:         todo [list|get|add|complete|delete]
  Logs:           log [list]
  Backend:        backend [status|queue], remote-status, queue
  Agent Skills:   skill [install|status|remove]
  Shell:          completion [bash|zsh|fish]

For more information on a command, run:
  $ propr <command> --help
`);

configureProjectOptionInheritance(program);

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
      if (!isValidRemoteUrl(url)) {
        throw new Error("Invalid remote URL. Expected an http:// or https:// URL.");
      }
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
      const normalizedProject = normalizeProjectSlug(project);
      if (normalizedProject === null) {
        throw new ProjectResolutionError(
          `Invalid project "${project}". Expected owner/repo format.`
        );
      }
      await configManager.setDefaultProject(normalizedProject);
      console.log(`Default project set to: ${normalizedProject}`);
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

program
  .command("completion <shell>")
  .description("Generate shell completion script for bash, zsh, or fish")
  .action((shell: string) => {
    if (shell !== "bash" && shell !== "zsh" && shell !== "fish") {
      console.error("Error: shell must be one of: bash, zsh, fish");
      process.exit(1);
    }
    process.stdout.write(completionScript(program, shell));
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
program.addCommand(createConnectCommand());
program.addCommand(createTankCommand());
program.addCommand(createRelayCommand());
program.addCommand(createRuntimeCommand());
program.addCommand(createConfigCommand());

// Setup + backend client command groups
program.addCommand(createInitCommand());
program.addCommand(createSetupCommand());
program.addCommand(createAgentSkillCommand());
program.addCommand(createPlanCommand());
program.addCommand(createIssueCommand());
program.addCommand(createTaskCommand());
program.addCommand(createRepoCommand());
program.addCommand(createAgentCommand());
program.addCommand(createSettingCommand());
program.addCommand(createLogCommand());
program.addCommand(createTodoCommand());
program.addCommand(createBackendCommand());
program.addCommand(createRemoteStatusCommand());
program.addCommand(createQueueCommand());

function isCliEntryPoint(): boolean {
  const invocation = process.argv[1];
  if (!invocation) return false;

  try {
    return realpathSync(invocation) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Importing @propr/cli exposes its programmatic API without executing a command.
// Bare `propr` (no args) runs the environment check, then hints at next steps.
if (isCliEntryPoint() && !process.argv.slice(2).length) {
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
} else if (isCliEntryPoint() && connectStatusHelpRequested) {
  // Parse a canonical help shape so a malformed `--root` cannot consume the
  // help flag as its required value. Commander remains the help authority.
  program.parse([...process.argv.slice(0, 2), "connect", "status", "--help"]);
} else if (isCliEntryPoint() && malformedConnectStatusRoot) {
  const document = invalidConnectRootStatus();
  process.stdout.write(`${JSON.stringify(document)}\n`);
  process.stderr.write(`ProPR Connect discovery: ${document.status}.\n`);
  process.exitCode = CONNECT_STATUS_EXIT[document.status];
} else if (isCliEntryPoint()) {
  program.parse();
}
