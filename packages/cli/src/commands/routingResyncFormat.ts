import type { RoutingResyncState } from "../api/index.js";

/**
 * Operator-facing rendering of the Routing installation resume-resync state
 * shared by `propr system status` and `propr check`.
 */

export interface RoutingResyncSummary {
  /** Label/value rows for the status table. */
  rows: Array<[string, string]>;
  /** False when reconciliation needs operator attention. */
  healthy: boolean;
  /** One-line explanation when unhealthy or waiting. */
  attention: string | null;
}

export const ROUTING_RESYNC_LABELS = [
  "Resume Resync",
  "Resume Generation",
  "Suspension Gap",
  "Resync Repositories",
  "Resync Attempts",
  "Resync Started",
  "Resync Completed",
  "Resync Last Error",
  "Resync Next Retry",
  "Routed Intake",
] as const;

function formatTimestamp(value: string | null): string {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function attentionFor(resync: RoutingResyncState): string | null {
  switch (resync.state) {
    case "failed":
      return `Routing suspension-gap reconciliation failed after ${resync.attempts} attempts (${resync.lastError ?? "unknown error"}). Routed intake stays held; restart the daemon or reconnect to retry.`;
    case "partial":
      return `Routing suspension-gap reconciliation is partial; retrying at ${formatTimestamp(resync.nextRetryAt)}.`;
    case "pending":
      return "The GitHub installation is suspended by Routing; reconciliation starts once it is unsuspended.";
    case "reconciling":
      return "Reconciling GitHub state after a Routing suspension gap; routed intake is waiting.";
    case "completed":
      return "Suspension-gap reconciliation completed; waiting for Routing to accept it.";
    default:
      return null;
  }
}

export function summarizeRoutingResync(resync: RoutingResyncState): RoutingResyncSummary {
  if (resync.state === "idle") {
    return { rows: [["Resume Resync", "idle (no suspension gap recorded)"]], healthy: true, attention: null };
  }
  const repos = resync.repositories;
  const rows: Array<[string, string]> = [
    ["Resume Resync", `${resync.state}${resync.running ? " (running)" : ""}`],
    ["Resume Generation", `${resync.routingGeneration ?? "-"}/${resync.resumeGeneration ?? "-"}`],
    ["Suspension Gap", `${formatTimestamp(resync.gapStartedAt)} → ${resync.gapEndedAt ? formatTimestamp(resync.gapEndedAt) : "(still suspended)"}`],
    ["Resync Repositories", `${repos.reconciled}/${repos.total} reconciled, ${repos.inaccessible} inaccessible, ${repos.failed} failed, ${repos.pending} pending`],
    ["Resync Attempts", String(resync.attempts)],
    ["Resync Started", formatTimestamp(resync.startedAt)],
    ["Resync Completed", formatTimestamp(resync.completedAt)],
  ];
  if (resync.lastError) rows.push(["Resync Last Error", resync.lastError]);
  if (resync.nextRetryAt) rows.push(["Resync Next Retry", formatTimestamp(resync.nextRetryAt)]);
  rows.push(["Routed Intake", resync.intakeWaiting ? "waiting (held by Routing until resync is accepted)" : "flowing"]);
  return {
    rows,
    healthy: resync.state !== "failed" && resync.state !== "partial",
    attention: attentionFor(resync),
  };
}
