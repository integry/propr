/**
 * System Status Commands
 *
 * CLI commands for checking system health and queue statistics.
 * Provides `status` and `queue` as top-level commands.
 */

import { Command } from "commander";
import {
  getSystemStatus,
  getQueueStats,
  SystemStatus,
  QueueStats,
} from "../api/index.js";
import { printOutput } from "../utils/index.js";

/**
 * Formats a status value with color-like indicators for terminal display.
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
 */
function displaySystemStatus(status: SystemStatus): void {
  console.log("");
  console.log("=".repeat(50));
  console.log("System Status");
  console.log("=".repeat(50));
  console.log("");

  const labels = [
    "API",
    "Redis",
    "Daemon",
    "Worker",
    "Workers Active",
    "GitHub Auth",
    "GitHub Auth Mode",
    "GitHub Event Intake",
    "Claude Auth",
    "Routing URL",
    "Routing WebSocket",
    "Last Delivery ID",
    "Last ACK",
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
  if (status.githubAuthMode) {
    console.log(
      `${"GitHub Auth Mode".padEnd(maxLabelWidth)}  ${status.githubAuthMode}`
    );
  }
  if (status.githubEventIntake) {
    console.log(
      `${"GitHub Event Intake".padEnd(maxLabelWidth)}  ${status.githubEventIntake}`
    );
  }
  console.log(
    `${"Claude Auth".padEnd(maxLabelWidth)}  ${formatStatusIndicator(status.claudeAuth)}`
  );

  // Routing WebSocket diagnostics for default (routing_websocket) deployments.
  if (status.routing) {
    const routing = status.routing;
    console.log("");
    console.log(
      `${"Routing URL".padEnd(maxLabelWidth)}  ${routing.routingUrl || "(not set)"}`
    );
    console.log(
      `${"Routing WebSocket".padEnd(maxLabelWidth)}  ${formatStatusIndicator(routing.connected ? "connected" : "disconnected")}`
    );
    console.log(
      `${"Last Delivery ID".padEnd(maxLabelWidth)}  ${routing.lastDeliveryId ?? "(none yet)"}`
    );
    console.log(
      `${"Last ACK".padEnd(maxLabelWidth)}  ${routing.lastAckAt ? new Date(routing.lastAckAt).toLocaleString() : "(none yet)"}`
    );
  }
  console.log("");
  console.log(
    `${"Timestamp".padEnd(maxLabelWidth)}  ${new Date(status.timestamp).toLocaleString()}`
  );
  console.log("");
  console.log("=".repeat(50));

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
 */
function displayQueueStats(stats: QueueStats): void {
  console.log("");
  console.log("=".repeat(50));
  console.log("Queue Statistics");
  console.log("=".repeat(50));
  console.log("");

  const labels = ["Waiting", "Active", "Completed", "Failed", "Delayed", "Total"];
  const maxLabelWidth = Math.max(...labels.map((l) => l.length));

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
 * Creates the `remote-status` command.
 *
 * Reports the health of a remote ProPR backend (API/Redis/daemon/worker) over
 * HTTP. The top-level `propr status` now reports the local Docker stack, so this
 * backend health view is exposed as `remote-status`.
 */
export function createRemoteStatusCommand(): Command {
  return new Command("remote-status")
    .description("Display the health status of a remote ProPR backend (API, Redis, daemon, worker)")
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
  $ propr remote-status           # Human-readable output
  $ propr remote-status --json    # JSON output for scripting
`)
    .action(async (options: { json?: boolean }) => {
      try {
        const status = await getSystemStatus();

        if (printOutput(status, options.json ?? false)) {
          return;
        }

        console.log("Checking system status...");
        displaySystemStatus(status);
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
}

/**
 * Creates the `queue` command.
 */
export function createQueueCommand(): Command {
  return new Command("queue")
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
  $ propr queue           # Human-readable output
  $ propr queue --json    # JSON output for scripting
`)
    .action(async (options: { json?: boolean }) => {
      try {
        const stats = await getQueueStats();

        if (printOutput(stats, options.json ?? false)) {
          return;
        }

        console.log("Fetching queue statistics...");
        displayQueueStats(stats);
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
