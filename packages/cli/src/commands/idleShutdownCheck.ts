import {
  formatIdleShutdownDuration,
  parseIdleShutdownStatus,
  resolveGithubEventIntakeMode,
  resolveIdleShutdownConfig,
  type IdleShutdownStatus,
} from "@propr/shared";
import type { CheckResult } from "./checkCommands.js";

/**
 * `propr check` rows for opt-in idle shutdown (issue #3770): the setting as
 * the stack's environment resolves it (offline-safe) and, when the backend is
 * reachable, the daemon's live status — which also reflects a value saved in
 * the Web UI.
 *
 * The live status is read for every intake mode: the setting can be turned on
 * in the Web UI with the environment left unset, so only the backend knows the
 * effective value. The read is bounded and best effort (shared with the routing
 * diagnostics); when it fails, only the environment rows are shown.
 */

const GROUP = "Configuration" as const;

function describeBlockers(status: IdleShutdownStatus): string {
  if (status.blockers.length === 0) return "idle — nothing keeps the instance awake";
  const shown = status.blockers.slice(0, 3).map(blocker => blocker.detail).join("; ");
  const more = status.blockers.length > 3 ? ` (+${status.blockers.length - 3} more)` : "";
  return `busy — ${shown}${more}`;
}

function liveRows(status: IdleShutdownStatus): CheckResult[] {
  const rows: CheckResult[] = [{
    name: "Idle shutdown (live)",
    status: "ok",
    detail: `${status.enabled ? `on after ${formatIdleShutdownDuration(status.afterMs)}` : "off"} (${status.source}); ${describeBlockers(status)}`
      + (status.enabled && status.shutdownAt ? `; stops at ${status.shutdownAt}` : ""),
    group: GROUP,
  }];
  if (status.nextDueAt) rows.push({ name: "Next scheduled work", status: "ok", detail: status.nextDueAt, group: GROUP });
  if (status.lastShutdown) {
    rows.push({ name: "Last idle shutdown", status: "ok", detail: `${status.lastShutdown.shutdownAt} (${status.lastShutdown.reason})`, group: GROUP });
  }
  if (status.lastWake) {
    rows.push({
      name: "Last wake",
      status: "ok",
      detail: `${status.lastWake.wokeAt} via ${status.lastWake.source}, cold start ${status.lastWake.coldStartMs} ms`,
      group: GROUP,
    });
  }
  return rows;
}

export async function checkIdleShutdown(
  env: Record<string, string | undefined>,
  readStatus?: () => Promise<{ idleShutdown?: unknown } | null>,
): Promise<CheckResult[]> {
  const config = resolveIdleShutdownConfig(env);
  const out: CheckResult[] = [];
  out.push({
    name: "Idle shutdown",
    status: config.warnings.length > 0 ? "warn" : "ok",
    detail: config.source === "environment"
      ? `${config.enabled ? "on" : "off"}, after ${formatIdleShutdownDuration(config.afterMs)} (set in the environment)`
      : "not set in the environment — off unless turned on in Settings → Maintenance → Idle shutdown",
    group: GROUP,
    ...(config.warnings.length > 0 ? { fix: config.warnings.join("; ") } : {}),
  });

  let intakeMode: string | null = null;
  try {
    intakeMode = resolveGithubEventIntakeMode({
      eventIntakeMode: env.GITHUB_EVENT_INTAKE_MODE,
      enableGithubWebhooks: env.ENABLE_GITHUB_WEBHOOKS,
    }).mode;
  } catch {
    intakeMode = null;
  }

  let live: IdleShutdownStatus | null = null;
  try {
    live = parseIdleShutdownStatus((await readStatus?.())?.idleShutdown);
  } catch {
    live = null;
  }
  const enabled = live?.enabled ?? config.enabled;
  if (enabled && intakeMode === "polling") {
    out.push({
      name: "Idle shutdown intake",
      status: "warn",
      detail: "polling intake schedules a poll every interval, so the instance never becomes idle",
      group: GROUP,
      fix: "Use GITHUB_EVENT_INTAKE_MODE=routing_websocket (Connect) so deliveries can wake a stopped instance.",
    });
  }
  if (live) out.push(...liveRows(live));
  return out;
}
