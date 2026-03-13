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
  MonitoredRepo,
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
    .description("List all monitored repositories")
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
    .description("Add a repository to the monitored list")
    .option("-a, --alias <alias>", "Display alias for the repository")
    .option("-b, --branch <branch>", "Base branch name (default: main/master)")
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
}
