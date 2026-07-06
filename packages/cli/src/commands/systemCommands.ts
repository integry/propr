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
  const routingIntakeActive = status.githubEventIntake === "routing_websocket";
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
  } else if (routingIntakeActive) {
    // routing_websocket is the active intake mode but the daemon published no
    // routing state — the default event path is not diagnosable (publisher down
    // or daemon not running). Surface it explicitly rather than rendering nothing.
    console.log("");
    console.log(
      `${"Routing WebSocket".padEnd(maxLabelWidth)}  ${formatStatusIndicator("unknown")} (no routing state published)`
    );
  }
  console.log("");
  console.log(
    `${"Timestamp".padEnd(maxLabelWidth)}  ${new Date(status.timestamp).toLocaleString()}`
  );
  console.log("");
  console.log("=".repeat(50));

  // Routing health counts against overall health whenever routing_websocket is the
  // active intake path: a published-but-disconnected state is unhealthy, and so is
  // a *missing* state (the daemon publisher is not running), since both mean the
  // default event path is not delivering. When routing is not the active mode, an
  // absent routing record is expected and does not affect health.
  const routingStateMissing = routingIntakeActive && !status.routing;
  const routingHealthy = status.routing
    ? status.routing.connected === true
    : !routingIntakeActive;

  const allHealthy =
    status.api === "healthy" &&
    status.redis === "connected" &&
    status.daemon === "running" &&
    status.worker === "running" &&
    status.githubAuth === "connected" &&
    routingHealthy;

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
      // githubAuth is derived from the resolved auth mode, so a relay deployment
      // only lands here when nothing valid is configured — mention both paths.
      console.log(
        `  - GitHub auth not configured (mode: ${status.githubAuthMode ?? "unknown"}). Set GH_APP_ID, GH_PRIVATE_KEY_PATH, and GH_INSTALLATION_ID for app auth, or PROPR_GH_RELAY_URL and PROPR_GH_RELAY_TOKEN for relay auth.`
      );
    }
    if (status.claudeAuth !== "connected") {
      console.log("  - Claude auth status unknown or no recent activity.");
    }
    if (routingStateMissing) {
      console.log("  - Routing WebSocket state unavailable. routing_websocket is the active intake mode but the daemon published no routing state; ensure the daemon is running and check its logs.");
    } else if (!routingHealthy) {
      console.log("  - Routing WebSocket disconnected. The daemon is not connected to the routing relay; check PROPR_ROUTING_URL / PROPR_GH_RELAY_TOKEN and the daemon logs.");
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
 *
 * @param invocation - How the command is invoked in help examples, so the same
 *                     implementation reads correctly under `propr backend status`.
 */
export function createRemoteStatusCommand(invocation = "propr remote-status"): Command {
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
  $ ${invocation}           # Human-readable output
  $ ${invocation} --json    # JSON output for scripting
`)
    .action(async (options: { json?: boolean }) => {
      try {
        const status = await getSystemStatus();

        if (printOutput(status, options.json ?? false)) {
          return;
        }

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
 *
 * @param invocation - How the command is invoked in help examples, so the same
 *                     implementation reads correctly under `propr backend queue`.
 */
export function createQueueCommand(invocation = "propr queue"): Command {
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
  $ ${invocation}           # Human-readable output
  $ ${invocation} --json    # JSON output for scripting
`)
    .action(async (options: { json?: boolean }) => {
      try {
        const stats = await getQueueStats();

        if (printOutput(stats, options.json ?? false)) {
          return;
        }

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

/**
 * Creates the `backend` command group, exposing the remote backend health and
 * queue views as `propr backend status|queue` alongside the top-level
 * `remote-status` and `queue` commands.
 */
export function createBackendCommand(): Command {
  const backend = new Command("backend")
    .description("Inspect remote ProPR backend status and queues");
  backend.addCommand(createRemoteStatusCommand("propr backend status").name("status"));
  backend.addCommand(createQueueCommand("propr backend queue").name("queue"));
  return backend;
}
