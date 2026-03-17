/**
 * Repository Management Commands
 *
 * CLI commands for managing monitored repositories using the ProPR backend.
 * Provides the `repo` command group with `list`, `add`, `remove`, `toggle`, `index`, and `status` subcommands.
 */

import { Command } from "commander";
import {
  getRepos,
  addRepo,
  removeRepo,
  updateRepo,
  triggerIndexing,
  getIndexingStatus,
  MonitoredRepo,
  RepositoryIndexingStatus,
} from "../api/index.js";
import { printOutput } from "../utils/index.js";

/**
 * Formats the enabled status for display.
 */
function formatEnabled(enabled: boolean): string {
  return enabled ? "Enabled" : "Disabled";
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
 * Formats the indexing status for display.
 */
function formatIndexingStatus(status: string): string {
  switch (status) {
    case "indexing":
      return "Indexing";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "idle":
    default:
      return "Idle";
  }
}

/**
 * Formats token usage for display.
 */
function formatTokens(inputTokens: number, outputTokens: number): string {
  const total = inputTokens + outputTokens;
  if (total === 0) return "-";

  const formatNum = (n: number): string => {
    if (n >= 1000) {
      return `${(n / 1000).toFixed(1)}K`;
    }
    return n.toString();
  };

  return `${formatNum(inputTokens)}/${formatNum(outputTokens)}`;
}

/**
 * Displays a table of repository indexing statuses with clean formatting.
 */
function displayIndexingStatusTable(statuses: RepositoryIndexingStatus[]): void {
  const repoWidth = Math.max(
    "Repository".length,
    ...statuses.map((s) => truncate(s.full_name, 40).length)
  );
  const branchWidth = Math.max(
    "Branch".length,
    ...statuses.map((s) => truncate(s.branch, 15).length || 1)
  );
  const statusWidth = Math.max(
    "Status".length,
    ...statuses.map((s) => formatIndexingStatus(s.indexing_status).length)
  );
  const progressWidth = Math.max(
    "Progress".length,
    10
  );
  const tokensWidth = Math.max(
    "Tokens (In/Out)".length,
    ...statuses.map((s) => {
      if (s.progress) {
        return formatTokens(s.progress.inputTokens, s.progress.outputTokens).length;
      }
      return 1;
    })
  );

  const header = [
    "Repository".padEnd(repoWidth),
    "Branch".padEnd(branchWidth),
    "Status".padEnd(statusWidth),
    "Progress".padEnd(progressWidth),
    "Tokens (In/Out)".padEnd(tokensWidth),
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  for (const status of statuses) {
    let progressStr = "-";
    if (status.progress) {
      progressStr = `${status.progress.percentComplete.toFixed(1)}%`;
    } else if (status.indexing_status === "completed") {
      progressStr = "100%";
    }

    const tokensStr = status.progress
      ? formatTokens(status.progress.inputTokens, status.progress.outputTokens)
      : "-";

    const row = [
      truncate(status.full_name, 40).padEnd(repoWidth),
      (truncate(status.branch, 15) || "-").padEnd(branchWidth),
      formatIndexingStatus(status.indexing_status).padEnd(statusWidth),
      progressStr.padEnd(progressWidth),
      tokensStr.padEnd(tokensWidth),
    ].join("  ");

    console.log(row);
  }
}

/**
 * Displays a table of repositories with clean formatting.
 */
function displayReposTable(repos: MonitoredRepo[]): void {
  const nameWidth = Math.max(
    "Repository".length,
    ...repos.map((r) => truncate(r.name, 40).length)
  );
  const aliasWidth = Math.max(
    "Alias".length,
    ...repos.map((r) => truncate(r.alias, 20).length || 1)
  );
  const branchWidth = Math.max(
    "Branch".length,
    ...repos.map((r) => truncate(r.baseBranch, 20).length || 1)
  );
  const statusWidth = Math.max(
    "Status".length,
    ...repos.map((r) => formatEnabled(r.enabled).length)
  );

  const header = [
    "Repository".padEnd(nameWidth),
    "Alias".padEnd(aliasWidth),
    "Branch".padEnd(branchWidth),
    "Status".padEnd(statusWidth),
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  for (const repo of repos) {
    const row = [
      truncate(repo.name, 40).padEnd(nameWidth),
      (truncate(repo.alias, 20) || "-").padEnd(aliasWidth),
      (truncate(repo.baseBranch, 20) || "-").padEnd(branchWidth),
      formatEnabled(repo.enabled).padEnd(statusWidth),
    ].join("  ");

    console.log(row);
  }
}

/**
 * Creates the `repo` command group.
 */
export function createRepoCommand(): Command {
  const repo = new Command("repo")
    .description("Manage monitored repositories")
    .addHelpText("after", `
Examples:
  $ propr repo list                              # List repositories
  $ propr repo add myorg/myrepo                  # Add a repository
  $ propr repo remove myorg/myrepo               # Remove a repository
  $ propr repo toggle myorg/myrepo --enable      # Enable monitoring
  $ propr repo index myorg/myrepo                # Trigger indexing
  $ propr repo status                            # View indexing status
`);

  // repo list
  repo
    .command("list")
    .description("List all repositories being monitored by ProPR")
    .option("-j, --json", "Output as JSON for programmatic use")
    .addHelpText("after", `
Examples:
  $ propr repo list
  $ propr repo list --json
`)
    .action(async (options: { json?: boolean }) => {
      try {
        const result = await getRepos();

        if (printOutput(result, options.json ?? false)) {
          return;
        }

        console.log("Fetching monitored repositories...");

        if (result.repos_to_monitor.length === 0) {
          console.log("");
          console.log("No repositories are currently being monitored.");
          console.log("");
          console.log("To add a repository, use:");
          console.log("  propr repo add <owner/repo>");
          return;
        }

        console.log("");
        displayReposTable(result.repos_to_monitor);

        console.log("");
        console.log(`Total: ${result.repos_to_monitor.length} repository(ies)`);
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (
          errorMessage.includes("401") ||
          errorMessage.includes("unauthorized")
        ) {
          console.error(
            "Error: Unauthorized. Please run 'propr login' first."
          );
        } else if (
          errorMessage.includes("403") ||
          errorMessage.includes("forbidden")
        ) {
          console.error(
            "Error: Access denied. You do not have permission to view repositories."
          );
        } else {
          console.error(`Error listing repositories: ${errorMessage}`);
        }
        process.exit(1);
      }
    });

  // repo add
  repo
    .command("add <fullName>")
    .description("Add a repository to the monitored list for ProPR")
    .option("-a, --alias <alias>", "Display alias for the repository")
    .option("-b, --branch <branch>", "Base branch name (default: main/master)")
    .addHelpText("after", `
Argument:
  fullName    Repository in owner/repo format

Examples:
  $ propr repo add myorg/myrepo
  $ propr repo add myorg/myrepo -a "My Project" -b develop
`)
    .action(
      async (
        fullName: string,
        options: { alias?: string; branch?: string }
      ) => {
        try {
          if (!fullName.includes("/")) {
            console.error(
              "Error: Repository name must be in 'owner/repo' format."
            );
            console.log("");
            console.log("Example: propr repo add integry/gitfix");
            process.exit(1);
          }

          const parts = fullName.split("/");
          if (parts.length !== 2 || !parts[0] || !parts[1]) {
            console.error(
              "Error: Invalid repository format. Expected 'owner/repo'."
            );
            process.exit(1);
          }

          console.log(`Adding repository: ${fullName}...`);

          const result = await addRepo(fullName, {
            alias: options.alias,
            baseBranch: options.branch,
            enabled: true,
          });

          if (result.success) {
            console.log("");
            console.log(`Successfully added repository: ${fullName}`);
            if (options.alias) {
              console.log(`  Alias: ${options.alias}`);
            }
            if (options.branch) {
              console.log(`  Base branch: ${options.branch}`);
            }
            console.log("");
            console.log(
              `Total monitored repositories: ${result.repos_to_monitor.length}`
            );
          } else {
            console.error("Failed to add repository.");
            process.exit(1);
          }
        } catch (error) {
          const errorMessage = (error as Error).message;
          if (errorMessage.includes("already being monitored")) {
            console.error(`Error: Repository "${fullName}" is already being monitored.`);
            console.log("");
            console.log("To update the repository settings, you can:");
            console.log(`  1. Remove it first: propr repo remove ${fullName}`);
            console.log(`  2. Add it again with new options: propr repo add ${fullName} [options]`);
          } else if (
            errorMessage.includes("401") ||
            errorMessage.includes("unauthorized")
          ) {
            console.error(
              "Error: Unauthorized. Please run 'propr login' first."
            );
          } else if (
            errorMessage.includes("403") ||
            errorMessage.includes("forbidden")
          ) {
            console.error(
              "Error: Access denied. You do not have permission to add repositories."
            );
          } else {
            console.error(`Error adding repository: ${errorMessage}`);
          }
          process.exit(1);
        }
      }
    );

  // repo remove
  repo
    .command("remove <fullName>")
    .description("Remove a repository from the monitored list")
    .addHelpText("after", `
Argument:
  fullName    Repository in owner/repo format

Example:
  $ propr repo remove myorg/myrepo
`)
    .action(async (fullName: string) => {
      try {
        if (!fullName.includes("/")) {
          console.error(
            "Error: Repository name must be in 'owner/repo' format."
          );
          console.log("");
          console.log("Example: propr repo remove integry/gitfix");
          process.exit(1);
        }

        console.log(`Removing repository: ${fullName}...`);

        const result = await removeRepo(fullName);

        if (result.success) {
          console.log("");
          console.log(`Successfully removed repository: ${fullName}`);
          console.log("");
          console.log(
            `Remaining monitored repositories: ${result.repos_to_monitor.length}`
          );
        } else {
          console.error("Failed to remove repository.");
          process.exit(1);
        }
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (errorMessage.includes("not being monitored")) {
          console.error(`Error: Repository "${fullName}" is not being monitored.`);
          console.log("");
          console.log("Use 'propr repo list' to see currently monitored repositories.");
        } else if (
          errorMessage.includes("401") ||
          errorMessage.includes("unauthorized")
        ) {
          console.error("Error: Unauthorized. Please run 'propr login' first.");
        } else if (
          errorMessage.includes("403") ||
          errorMessage.includes("forbidden")
        ) {
          console.error(
            "Error: Access denied. You do not have permission to remove repositories."
          );
        } else {
          console.error(`Error removing repository: ${errorMessage}`);
        }
        process.exit(1);
      }
    });

  // repo toggle
  repo
    .command("toggle <fullName>")
    .description("Enable or disable monitoring for a repository")
    .option("--enable", "Enable monitoring for the repository")
    .option("--disable", "Disable monitoring for the repository")
    .addHelpText("after", `
Argument:
  fullName    Repository in owner/repo format

Note:
  Exactly one of --enable or --disable must be specified.

Examples:
  $ propr repo toggle myorg/myrepo --enable
  $ propr repo toggle myorg/myrepo --disable
`)
    .action(
      async (
        fullName: string,
        options: { enable?: boolean; disable?: boolean }
      ) => {
        try {
          if (options.enable && options.disable) {
            console.error(
              "Error: Cannot specify both --enable and --disable."
            );
            process.exit(1);
          }

          if (!options.enable && !options.disable) {
            console.error(
              "Error: Must specify either --enable or --disable."
            );
            console.log("");
            console.log("Usage:");
            console.log(`  propr repo toggle ${fullName} --enable`);
            console.log(`  propr repo toggle ${fullName} --disable`);
            process.exit(1);
          }

          if (!fullName.includes("/")) {
            console.error(
              "Error: Repository name must be in 'owner/repo' format."
            );
            console.log("");
            console.log("Example: propr repo toggle integry/gitfix --enable");
            process.exit(1);
          }

          const enableState = options.enable ? true : false;
          const actionWord = enableState ? "Enabling" : "Disabling";

          console.log(`${actionWord} monitoring for repository: ${fullName}...`);

          const result = await updateRepo(fullName, { enabled: enableState });

          if (result.success) {
            const statusWord = enableState ? "enabled" : "disabled";
            console.log("");
            console.log(
              `Successfully ${statusWord} monitoring for repository: ${fullName}`
            );
          } else {
            console.error("Failed to update repository.");
            process.exit(1);
          }
        } catch (error) {
          const errorMessage = (error as Error).message;
          if (errorMessage.includes("not being monitored")) {
            console.error(`Error: Repository "${fullName}" is not being monitored.`);
            console.log("");
            console.log("Use 'propr repo list' to see currently monitored repositories.");
            console.log(
              "To add a new repository, use 'propr repo add <owner/repo>'."
            );
          } else if (
            errorMessage.includes("401") ||
            errorMessage.includes("unauthorized")
          ) {
            console.error("Error: Unauthorized. Please run 'propr login' first.");
          } else if (
            errorMessage.includes("403") ||
            errorMessage.includes("forbidden")
          ) {
            console.error(
              "Error: Access denied. You do not have permission to update repositories."
            );
          } else {
            console.error(`Error updating repository: ${errorMessage}`);
          }
          process.exit(1);
        }
      }
    );

  // repo index
  repo
    .command("index <fullName>")
    .description("Trigger codebase indexing for a repository")
    .option("-b, --branch <branch>", "Specify the base branch to index")
    .option("--incremental", "Perform incremental indexing instead of full reindex")
    .addHelpText("after", `
Argument:
  fullName    Repository in owner/repo format

Indexing Modes:
  Full (default)    Re-index the entire repository
  Incremental       Only index changes since last index

Examples:
  $ propr repo index myorg/myrepo                    # Full reindex
  $ propr repo index myorg/myrepo --incremental     # Incremental index
  $ propr repo index myorg/myrepo -b develop        # Index specific branch
`)
    .action(
      async (
        fullName: string,
        options: { branch?: string; incremental?: boolean }
      ) => {
        try {
          if (!fullName.includes("/")) {
            console.error(
              "Error: Repository name must be in 'owner/repo' format."
            );
            console.log("");
            console.log("Example: propr repo index integry/gitfix");
            process.exit(1);
          }

          const parts = fullName.split("/");
          if (parts.length !== 2 || !parts[0] || !parts[1]) {
            console.error(
              "Error: Invalid repository format. Expected 'owner/repo'."
            );
            process.exit(1);
          }

          const indexType = options.incremental ? "incremental" : "full";
          console.log(`Triggering ${indexType} indexing for repository: ${fullName}...`);

          const result = await triggerIndexing(fullName, {
            fullReindex: !options.incremental,
            baseBranch: options.branch,
          });

          if (result.success) {
            console.log("");
            console.log(`Successfully triggered indexing for repository: ${fullName}`);
            if (result.jobId) {
              console.log(`  Job ID: ${result.jobId}`);
            }
            if (result.correlationId) {
              console.log(`  Correlation ID: ${result.correlationId}`);
            }
            if (options.branch) {
              console.log(`  Branch: ${options.branch}`);
            }
            console.log(`  Mode: ${indexType} reindex`);
            console.log("");
            console.log("Use 'propr repo status <fullName>' to check indexing progress.");
          } else {
            console.error(`Failed to trigger indexing: ${result.error || "Unknown error"}`);
            process.exit(1);
          }
        } catch (error) {
          const errorMessage = (error as Error).message;
          if (errorMessage.includes("already queued")) {
            console.error(`Error: Indexing for "${fullName}" is already in progress or queued.`);
            console.log("");
            console.log("Use 'propr repo status' to check the current indexing status.");
          } else if (
            errorMessage.includes("401") ||
            errorMessage.includes("unauthorized")
          ) {
            console.error("Error: Unauthorized. Please run 'propr login' first.");
          } else if (
            errorMessage.includes("403") ||
            errorMessage.includes("forbidden")
          ) {
            console.error(
              "Error: Access denied. You do not have permission to trigger indexing."
            );
          } else {
            console.error(`Error triggering indexing: ${errorMessage}`);
          }
          process.exit(1);
        }
      }
    );

  // repo status
  repo
    .command("status [fullName]")
    .description("View indexing status and progress for repositories")
    .option("-j, --json", "Output as JSON for programmatic use")
    .addHelpText("after", `
Argument:
  fullName    (Optional) Repository in owner/repo format

Examples:
  $ propr repo status                    # Show all repositories
  $ propr repo status myorg/myrepo       # Show specific repository
  $ propr repo status --json             # JSON output
`)
    .action(async (fullName: string | undefined, options: { json?: boolean }) => {
      try {
        const result = await getIndexingStatus(fullName);

        if (printOutput(result, options.json ?? false)) {
          return;
        }

        console.log("Fetching indexing status...");

        if (result.repositories.length === 0) {
          console.log("");
          if (fullName) {
            console.log(`No indexing status found for repository: ${fullName}`);
            console.log("");
            console.log("Make sure the repository is being monitored:");
            console.log("  propr repo list");
          } else {
            console.log("No repositories are currently being tracked for indexing.");
            console.log("");
            console.log("To add a repository, use:");
            console.log("  propr repo add <owner/repo>");
          }
          return;
        }

        console.log("");
        displayIndexingStatusTable(result.repositories);

        console.log("");
        console.log(`Total: ${result.repositories.length} repository(ies)`);
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (
          errorMessage.includes("401") ||
          errorMessage.includes("unauthorized")
        ) {
          console.error("Error: Unauthorized. Please run 'propr login' first.");
        } else if (
          errorMessage.includes("403") ||
          errorMessage.includes("forbidden")
        ) {
          console.error(
            "Error: Access denied. You do not have permission to view indexing status."
          );
        } else {
          console.error(`Error fetching indexing status: ${errorMessage}`);
        }
        process.exit(1);
      }
    });

  return repo;
}
