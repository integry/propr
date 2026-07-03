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
  createConfigCommand,
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
  Configuration:  config, remote, use, login, logout
  Plans:          plan [create|list|get|delete|abort]
  Implementation: issue [implement]
  Tasks:          task [list|get|stop|delete|followup|import|revert]
  Repositories:   repo [list|add|remove|toggle|index|status]
  Agents:         agent [list|add|enable|disable|delete]
  Settings:       setting [get|update|reindex-summaries]
  To-Dos:         todo [list|get|add|complete|delete]
  Logs:           log [list]
  Backend:        backend [status|queue], remote-status, queue

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

function createBackendCommand(): Command {
  const backend = new Command("backend")
    .description("Inspect remote ProPR backend status and queues");
  backend.addCommand(createRemoteStatusCommand().name("status"));
  backend.addCommand(createQueueCommand());
  return backend;
}

function completionScript(shell: "bash" | "zsh" | "fish"): string {
  const commands = [
    "check", "images", "init", "start", "status", "stop", "ui", "docs", "tunnel", "tank",
    "relay", "config", "remote", "use", "login", "logout", "plan", "issue", "task", "repo",
    "agent", "setting", "todo", "log", "backend", "remote-status", "queue", "completion",
  ];
  const subcommands: Record<string, string[]> = {
    plan: ["create", "list", "get", "delete", "abort", "generate", "finalize", "issues"],
    issue: ["implement"],
    task: ["list", "get", "stop", "delete", "followup", "import", "revert"],
    repo: ["list", "add", "remove", "toggle", "index", "status"],
    agent: ["list", "add", "enable", "disable", "delete"],
    setting: ["get", "update", "reindex-summaries"],
    config: ["list", "get", "profile"],
    backend: ["status", "queue"],
    completion: ["bash", "zsh", "fish"],
  };
  const nestedSubcommands: Record<string, Record<string, string[]>> = {
    config: {
      profile: ["use", "set"],
    },
  };
  const options: Record<string, string[]> = {
    "issue implement": ["--wait", "-w", "--project", "-p", "--agent", "-a", "--model", "-m", "--epic", "--auto-merge"],
    "task list": ["--project", "-p", "--status", "-s", "--limit", "-l", "--search", "--json", "-j"],
    "task get": ["--json", "-j"],
    "task delete": ["--force", "-f"],
    "task followup": ["--file", "-f"],
    "task import": ["--project", "-p", "--file", "-f"],
    "task revert": ["--owner", "-o", "--dry-run"],
    "setting get": ["--key", "-k", "--json", "-j"],
    "setting reindex-summaries": ["--ignore-cooldown", "--json", "-j"],
    "config list": ["--json", "-j"],
    "config get": ["--json", "-j"],
    "config profile set": ["--remote", "--token", "--project", "--clear-remote", "--clear-token", "--clear-project"],
  };
  const commandWords = commands.join(" ");
  const optionCases = Object.entries(options)
    .map(([path, opts]) => `    "${path}") COMPREPLY=( $(compgen -W "${opts.join(" ")}" -- "$cur") ); return 0 ;;`)
    .join("\n");
  const zshOptionCases = Object.entries(options)
    .map(([path, opts]) => `    "${path}") _values 'options' ${opts.map((option) => `${option}:${option}`).join(" ")}; return ;;`)
    .join("\n");

  if (shell === "zsh") {
    return `#compdef propr
_propr() {
  local -a commands
  commands=(${commands.map((cmd) => `${cmd}:${cmd}`).join(" ")})
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi
  if [[ "$words[CURRENT]" == -* ]]; then
    local path3="$words[2] $words[3] $words[4]"
    local path2="$words[2] $words[3]"
    case "$path3" in
${zshOptionCases}
    esac
    case "$path2" in
${zshOptionCases}
    esac
  fi
  if (( CURRENT == 4 )) && [[ "$words[2]" == "config" && "$words[3]" == "profile" ]]; then
    _values 'profile commands' use:use set:set
    return
  fi
  case "$words[2]" in
${Object.entries(subcommands).map(([cmd, subs]) => `    ${cmd}) _values '${cmd} commands' ${subs.map((sub) => `${sub}:${sub}`).join(" ")} ;;`).join("\n")}
  esac
}
_propr
`;
  }

  if (shell === "fish") {
    const lines = commands.map((cmd) => `complete -c propr -f -n '__fish_use_subcommand' -a '${cmd}'`);
    for (const [cmd, subs] of Object.entries(subcommands)) {
      lines.push(`complete -c propr -f -n '__fish_seen_subcommand_from ${cmd}' -a '${subs.join(" ")}'`);
    }
    for (const [cmd, nested] of Object.entries(nestedSubcommands)) {
      for (const [sub, subs] of Object.entries(nested)) {
        lines.push(`complete -c propr -f -n '__fish_seen_subcommand_from ${cmd}; and __fish_seen_subcommand_from ${sub}' -a '${subs.join(" ")}'`);
      }
    }
    for (const [path, opts] of Object.entries(options)) {
      const parts = path.split(" ");
      const condition = parts.map((part) => `__fish_seen_subcommand_from ${part}`).join("; and ");
      for (const option of opts) {
        lines.push(`complete -c propr -f -n '${condition}' -a '${option}'`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  return `_propr_completion() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${commandWords}" -- "$cur") )
    return 0
  fi
  if [[ "$cur" == -* ]]; then
    local path3="\${COMP_WORDS[1]} \${COMP_WORDS[2]} \${COMP_WORDS[3]}"
    local path2="\${COMP_WORDS[1]} \${COMP_WORDS[2]}"
    case "$path3" in
${optionCases}
    esac
    case "$path2" in
${optionCases}
    esac
  fi
  if [[ \${COMP_CWORD} -eq 3 ]]; then
    case "\${COMP_WORDS[1]} \${COMP_WORDS[2]}" in
${Object.entries(nestedSubcommands).flatMap(([cmd, nested]) => Object.entries(nested).map(([sub, subs]) => `      "${cmd} ${sub}") COMPREPLY=( $(compgen -W "${subs.join(" ")}" -- "$cur") ); return 0 ;;`)).join("\n")}
    esac
  fi
  case "\${COMP_WORDS[1]}" in
${Object.entries(subcommands).map(([cmd, subs]) => `    ${cmd}) COMPREPLY=( $(compgen -W "${subs.join(" ")}" -- "$cur") ) ;;`).join("\n")}
  esac
}
complete -F _propr_completion propr
`;
}

program
  .command("completion <shell>")
  .description("Generate shell completion script for bash, zsh, or fish")
  .action((shell: string) => {
    if (shell !== "bash" && shell !== "zsh" && shell !== "fish") {
      console.error("Error: shell must be one of: bash, zsh, fish");
      process.exit(1);
    }
    process.stdout.write(completionScript(shell));
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
program.addCommand(createConfigCommand());

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
program.addCommand(createBackendCommand());
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
