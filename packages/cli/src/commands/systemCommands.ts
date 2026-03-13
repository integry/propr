/**
 * System Status Commands
 *
 * CLI commands for checking system health and queue statistics.
 * Provides the `system-status` and `queue-stats` commands.
 */

import { Command } from "commander";
import {
  getSystemStatus,
  getQueueStats,
  SystemStatus,
  QueueStats,
} from "../api/index.js";

/**
 * Formats a status value with color-like indicators for terminal display.
 *
 * @param status - The status string to format.
 * @returns A formatted status string with indicator.
 */
function formatStatusIndicator(status: string): string {
  const normalizedStatus = status.toLowerCase();

  if (
    normalizedStatus === "healthy" ||
    normalizedStatus === "connected" ||
    normalizedStatus === "running"
  ) {
    return `[OK] ${status}`;
  }

  if (
    normalizedStatus === "disconnected" ||
    normalizedStatus === "stopped" ||
    normalizedStatus === "unknown"
  ) {
    return `[!!] ${status}`;
  }

  return `[--] ${status}`;
}

/**
 * Displays the system status in a formatted table.
 *
 * @param status - The system status to display.
 */
function displaySystemStatus(status: SystemStatus): void {
  console.log("");
  console.log("=".repeat(50));
  console.log("System Status");
  console.log("=".repeat(50));
  console.log("");

  // Calculate label width for alignment
  const labels = [
    "API",
    "Redis",
    "Daemon",
    "Worker",
    "Workers Active",
    "GitHub Auth",
    "Claude Auth",
    "Timestamp",
  ];
  const maxLabelWidth = Math.max(...labels.map((l) => l.length));

  console.log(
    `${"API".padEnd(maxLabelWidth)}  ${formatStatusIndicator(status.api)}`
  );
  console.log(
    `${"Redis".padEnd(maxLabelWidth)}  ${formatStatusIndicator(status.redis)}`
  );
  console.log(
    `${"Daemon".padEnd(maxLabelWidth)}  ${formatStatusIndicator(status.daemon)}`
  );
  console.log(
    `${"Worker".padEnd(maxLabelWidth)}  ${formatStatusIndicator(status.worker)}`
  );

  if (status.workerCount !== undefined) {
    console.log(
      `${"Workers Active".padEnd(maxLabelWidth)}  ${status.workerCount}`
    );
  }

  console.log(
    `${"GitHub Auth".padEnd(maxLabelWidth)}  ${formatStatusIndicator(status.githubAuth)}`
  );
  console.log(
    `${"Claude Auth".padEnd(maxLabelWidth)}  ${formatStatusIndicator(status.claudeAuth)}`
  );
  console.log("");
  console.log(
    `${"Timestamp".padEnd(maxLabelWidth)}  ${new Date(status.timestamp).toLocaleString()}`
  );
  console.log("");
  console.log("=".repeat(50));

  // Summary
  const allHealthy =
    status.api === "healthy" &&
    status.redis === "connected" &&
    status.daemon === "running" &&
    status.worker === "running" &&
    status.githubAuth === "connected";

  console.log("");
  if (allHealthy) {
    console.log("All systems operational.");
  } else {
    console.log("Some components require attention.");

    if (status.redis !== "connected") {
      console.log("  - Redis is not connected. Check Redis server.");
    }
    if (status.daemon !== "running") {
      console.log("  - Daemon is not running. Start the daemon service.");
    }
    if (status.worker !== "running") {
      console.log("  - No workers active. Check worker processes.");
    }
    if (status.githubAuth !== "connected") {
      console.log("  - GitHub auth not configured. Check GH_APP_ID, GH_PRIVATE_KEY_PATH, and GH_INSTALLATION_ID.");
    }
    if (status.claudeAuth !== "connected") {
      console.log("  - Claude auth status unknown or no recent activity.");
    }
  }
}

/**
 * Displays the queue statistics in a formatted table.
 *
 * @param stats - The queue statistics to display.
 */
function displayQueueStats(stats: QueueStats): void {
  console.log("");
  console.log("=".repeat(50));
  console.log("Queue Statistics");
  console.log("=".repeat(50));
  console.log("");

  // Calculate label width for alignment
  const labels = ["Waiting", "Active", "Completed", "Failed", "Delayed", "Total"];
  const maxLabelWidth = Math.max(...labels.map((l) => l.length));

  // Format numbers with thousands separator for large values
  const formatNumber = (n: number): string => n.toLocaleString();

  console.log(
    `${"Waiting".padEnd(maxLabelWidth)}  ${formatNumber(stats.waiting)}`
  );
  console.log(
    `${"Active".padEnd(maxLabelWidth)}  ${formatNumber(stats.active)}`
  );
  console.log(
    `${"Completed".padEnd(maxLabelWidth)}  ${formatNumber(stats.completed)}`
  );
  console.log(
    `${"Failed".padEnd(maxLabelWidth)}  ${formatNumber(stats.failed)}`
  );
  console.log(
    `${"Delayed".padEnd(maxLabelWidth)}  ${formatNumber(stats.delayed)}`
  );
  console.log("-".repeat(30));
  console.log(
    `${"Total".padEnd(maxLabelWidth)}  ${formatNumber(stats.total)}`
  );

  console.log("");
  console.log("=".repeat(50));

  // Summary
  console.log("");
  if (stats.active > 0) {
    console.log(`Currently processing ${stats.active} job(s).`);
  }
  if (stats.waiting > 0) {
    console.log(`${stats.waiting} job(s) waiting in queue.`);
  }
  if (stats.failed > 0) {
    const failRate =
      stats.total > 0
        ? ((stats.failed / stats.total) * 100).toFixed(1)
        : "0.0";
    console.log(`${stats.failed} job(s) failed (${failRate}% failure rate).`);
  }
  if (stats.total === 0) {
    console.log("Queue is empty.");
  }
}

/**
 * Registers system status commands on the given program.
 *
 * @param program - The Commander program to add commands to.
 */
export function registerSystemCommands(program: Command): void {
  // System status command
  program
    .command("system-status")
    .description("Display the health status of all ProPR backend components")
    .option("--json", "Output raw JSON response")
    .addHelpText("after", `
Components Checked:
  - API health
  - Redis connection
  - Daemon status
  - Worker status
  - GitHub authentication
  - Claude authentication

Examples:
  $ propr system-status           # Human-readable output
  $ propr system-status --json    # JSON output for scripting
`)
    .action(async (options: { json?: boolean }) => {
      try {
        console.log("Checking system status...");

        const status = await getSystemStatus();

        if (options.json) {
          console.log(JSON.stringify(status, null, 2));
        } else {
          displaySystemStatus(status);
        }
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (
          errorMessage.includes("401") ||
          errorMessage.includes("unauthorized")
        ) {
          console.error("Error: Unauthorized. Please run 'propr login' first.");
        } else if (
          errorMessage.includes("ECONNREFUSED") ||
          errorMessage.includes("network")
        ) {
          console.error(
            "Error: Cannot connect to ProPR backend. Is the server running?"
          );
        } else {
          console.error(`Error checking system status: ${errorMessage}`);
        }
        process.exit(1);
      }
    });

  // Queue stats command
  program
    .command("queue-stats")
    .description("Display job queue statistics and counts")
    .option("--json", "Output raw JSON response")
    .addHelpText("after", `
Statistics Shown:
  - Waiting jobs
  - Active jobs
  - Completed jobs
  - Failed jobs
  - Delayed jobs
  - Failure rate

Examples:
  $ propr queue-stats           # Human-readable output
  $ propr queue-stats --json    # JSON output for scripting
`)
    .action(async (options: { json?: boolean }) => {
      try {
        console.log("Fetching queue statistics...");

        const stats = await getQueueStats();

        if (options.json) {
          console.log(JSON.stringify(stats, null, 2));
        } else {
          displayQueueStats(stats);
        }
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (
          errorMessage.includes("401") ||
          errorMessage.includes("unauthorized")
        ) {
          console.error("Error: Unauthorized. Please run 'propr login' first.");
        } else if (
          errorMessage.includes("ECONNREFUSED") ||
          errorMessage.includes("network")
        ) {
          console.error(
            "Error: Cannot connect to ProPR backend. Is the server running?"
          );
        } else {
          console.error(`Error fetching queue statistics: ${errorMessage}`);
        }
        process.exit(1);
      }
    });
}
