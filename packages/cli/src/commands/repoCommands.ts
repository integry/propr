/**
 * Repository Management Commands
 *
 * CLI commands for managing monitored repositories using the ProPR backend.
 * Provides the `list-repos`, `add-repo`, `remove-repo`, and `toggle-repo` commands.
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

/**
 * Formats the enabled status for display.
 *
 * @param enabled - Whether the repository is enabled.
 * @returns A formatted status string.
 */
function formatEnabled(enabled: boolean): string {
  return enabled ? "Enabled" : "Disabled";
}

/**
 * Truncates a string to a maximum length.
 *
 * @param str - The string to truncate.
 * @param maxLen - The maximum length.
 * @returns The truncated string with "..." if it was too long.
 */
function truncate(str: string | null | undefined, maxLen: number): string {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + "...";
}

/**
 * Formats the indexing status for display.
 *
 * @param status - The indexing status.
 * @returns A formatted status string.
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
 *
 * @param inputTokens - Number of input tokens.
 * @param outputTokens - Number of output tokens.
 * @returns A formatted token string.
 */
function formatTokens(inputTokens: number, outputTokens: number): string {
  const total = inputTokens + outputTokens;
  if (total === 0) return "-";

  // Format with K suffix for thousands
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
 *
 * @param statuses - The repository indexing statuses to display.
 */
function displayIndexingStatusTable(statuses: RepositoryIndexingStatus[]): void {
  // Calculate column widths
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

  // Print header
  const header = [
    "Repository".padEnd(repoWidth),
    "Branch".padEnd(branchWidth),
    "Status".padEnd(statusWidth),
    "Progress".padEnd(progressWidth),
    "Tokens (In/Out)".padEnd(tokensWidth),
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  // Print each repository status
  for (const status of statuses) {
    // Format progress
    let progressStr = "-";
    if (status.progress) {
      progressStr = `${status.progress.percentComplete.toFixed(1)}%`;
    } else if (status.indexing_status === "completed") {
      progressStr = "100%";
    }

    // Format tokens
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
 *
 * @param repos - The repositories to display.
 */
function displayReposTable(repos: MonitoredRepo[]): void {
  // Calculate column widths
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

  // Print header
  const header = [
    "Repository".padEnd(nameWidth),
    "Alias".padEnd(aliasWidth),
    "Branch".padEnd(branchWidth),
    "Status".padEnd(statusWidth),
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  // Print each repository
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
 * Registers repository management commands on the given program.
 *
 * @param program - The Commander program to add commands to.
 */
export function registerRepoCommands(program: Command): void {
  // List repos command
  program
    .command("list-repos")
    .description("List all repositories being monitored by ProPR")
    .addHelpText("after", `
Example:
  $ propr list-repos
`)
    .action(async () => {
      try {
        console.log("Fetching monitored repositories...");

        const result = await getRepos();

        if (result.repos_to_monitor.length === 0) {
          console.log("");
          console.log("No repositories are currently being monitored.");
          console.log("");
          console.log("To add a repository, use:");
          console.log("  propr add-repo <owner/repo>");
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

  // Add repo command
  program
    .command("add-repo <fullName>")
    .description("Add a repository to the monitored list for ProPR")
    .option("-a, --alias <alias>", "Display alias for the repository")
    .option("-b, --branch <branch>", "Base branch name (default: main/master)")
    .addHelpText("after", `
Argument:
  fullName    Repository in owner/repo format

Examples:
  $ propr add-repo myorg/myrepo
  $ propr add-repo myorg/myrepo -a "My Project" -b develop
`)
    .action(
      async (
        fullName: string,
        options: { alias?: string; branch?: string }
      ) => {
        try {
          // Validate fullName format
          if (!fullName.includes("/")) {
            console.error(
              "Error: Repository name must be in 'owner/repo' format."
            );
            console.log("");
            console.log("Example: propr add-repo integry/gitfix");
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
            console.log(`  1. Remove it first: propr remove-repo ${fullName}`);
            console.log(`  2. Add it again with new options: propr add-repo ${fullName} [options]`);
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

  // Remove repo command
  program
    .command("remove-repo <fullName>")
    .description("Remove a repository from the monitored list")
    .addHelpText("after", `
Argument:
  fullName    Repository in owner/repo format

Example:
  $ propr remove-repo myorg/myrepo
`)
    .action(async (fullName: string) => {
      try {
        // Validate fullName format
        if (!fullName.includes("/")) {
          console.error(
            "Error: Repository name must be in 'owner/repo' format."
          );
          console.log("");
          console.log("Example: propr remove-repo integry/gitfix");
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
          console.log("Use 'propr list-repos' to see currently monitored repositories.");
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

  // Toggle repo command
  program
    .command("toggle-repo <fullName>")
    .description("Enable or disable monitoring for a repository")
    .option("--enable", "Enable monitoring for the repository")
    .option("--disable", "Disable monitoring for the repository")
    .addHelpText("after", `
Argument:
  fullName    Repository in owner/repo format

Note:
  Exactly one of --enable or --disable must be specified.

Examples:
  $ propr toggle-repo myorg/myrepo --enable
  $ propr toggle-repo myorg/myrepo --disable
`)
    .action(
      async (
        fullName: string,
        options: { enable?: boolean; disable?: boolean }
      ) => {
        try {
          // Validate that exactly one of --enable or --disable is provided
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
            console.log(`  propr toggle-repo ${fullName} --enable`);
            console.log(`  propr toggle-repo ${fullName} --disable`);
            process.exit(1);
          }

          // Validate fullName format
          if (!fullName.includes("/")) {
            console.error(
              "Error: Repository name must be in 'owner/repo' format."
            );
            console.log("");
            console.log("Example: propr toggle-repo integry/gitfix --enable");
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
            console.log("Use 'propr list-repos' to see currently monitored repositories.");
            console.log(
              "To add a new repository, use 'propr add-repo <owner/repo>'."
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

  // Index repo command
  program
    .command("index-repo <fullName>")
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
  $ propr index-repo myorg/myrepo                    # Full reindex
  $ propr index-repo myorg/myrepo --incremental     # Incremental index
  $ propr index-repo myorg/myrepo -b develop        # Index specific branch
`)
    .action(
      async (
        fullName: string,
        options: { branch?: string; incremental?: boolean }
      ) => {
        try {
          // Validate fullName format
          if (!fullName.includes("/")) {
            console.error(
              "Error: Repository name must be in 'owner/repo' format."
            );
            console.log("");
            console.log("Example: propr index-repo integry/gitfix");
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
            console.log("Use 'propr repo-status <fullName>' to check indexing progress.");
          } else {
            console.error(`Failed to trigger indexing: ${result.error || "Unknown error"}`);
            process.exit(1);
          }
        } catch (error) {
          const errorMessage = (error as Error).message;
          if (errorMessage.includes("already queued")) {
            console.error(`Error: Indexing for "${fullName}" is already in progress or queued.`);
            console.log("");
            console.log("Use 'propr repo-status' to check the current indexing status.");
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

  // Repo status command
  program
    .command("repo-status [fullName]")
    .description("View indexing status and progress for repositories")
    .addHelpText("after", `
Argument:
  fullName    (Optional) Repository in owner/repo format

Output includes:
  - Indexing status (idle, indexing, completed, failed)
  - Progress percentage
  - Token usage

Examples:
  $ propr repo-status                    # Show all repositories
  $ propr repo-status myorg/myrepo       # Show specific repository
`)
    .action(async (fullName?: string) => {
      try {
        console.log("Fetching indexing status...");

        const result = await getIndexingStatus(fullName);

        if (result.repositories.length === 0) {
          console.log("");
          if (fullName) {
            console.log(`No indexing status found for repository: ${fullName}`);
            console.log("");
            console.log("Make sure the repository is being monitored:");
            console.log("  propr list-repos");
          } else {
            console.log("No repositories are currently being tracked for indexing.");
            console.log("");
            console.log("To add a repository, use:");
            console.log("  propr add-repo <owner/repo>");
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
}
