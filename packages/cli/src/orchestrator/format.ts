/**
 * Shared rendering for stack status — used by `propr status` (one-shot) and the
 * `propr start` TUI's non-TTY fallback.
 */

import { proprTunnelEndpoints } from "@propr/shared";
import type { StackStatus, ServiceState, TunnelStatus } from "./types.js";

export function stateGlyph(s: ServiceState): string {
  if (!s.exists) return "·";
  if (s.running) return "●";
  return "○";
}

/** A single padded status row, e.g. "● api          running   Up 3 minutes". */
export function formatServiceRow(s: ServiceState, nameWidth: number): string {
  const glyph = stateGlyph(s);
  const name = s.service.padEnd(nameWidth);
  const state = (s.exists ? s.state : "absent").padEnd(10);
  const detail = s.exists ? s.status : "not created";
  const ports = s.ports ? `  ${s.ports}` : "";
  return `${glyph} ${name} ${state} ${detail}${ports}`;
}

/** Full status table as a string. */
export function renderStatusTable(status: StackStatus): string {
  const nameWidth = Math.max(...status.services.map((s) => s.service.length), 8);
  const lines: string[] = [];
  lines.push(`Stack: ${status.stack}   network: ${status.network}   ${status.running ? "running" : "stopped"}`);
  lines.push("─".repeat(60));
  for (const s of status.services) {
    lines.push(formatServiceRow(s, nameWidth));
  }
  return lines.join("\n");
}

/**
 * A short "where the hosted UI reaches this stack" summary for startup output.
 * Lists the concrete routed endpoints rather than the base URL, and notes the
 * root 404, so nothing implies the root URL is an API/health target. Returns an
 * empty array when there is no public URL to advertise.
 */
export function renderTunnelEndpointSummary(publicApiUrl: string | null | undefined): string[] {
  if (!publicApiUrl) return [];
  const { apiStatus, socketIo } = proprTunnelEndpoints(publicApiUrl);
  return [
    "Tunnel is up — the hosted UI reaches this stack at:",
    `  API:       ${apiStatus}`,
    `  Socket.IO: ${socketIo}`,
    "  Root URL intentionally returns 404.",
  ];
}

/** A yes/no/unknown glyph+label for a tri-state tunnel field. */
function tunnelFlag(value: boolean | null): string {
  if (value === null) return "· unknown";
  return value ? "● yes" : "○ no";
}

/** Tunnel diagnostics section as a string (see TunnelStatus). */
export function renderTunnelSection(t: TunnelStatus): string {
  const lines: string[] = [];
  lines.push("Tunnel");
  lines.push("─".repeat(60));
  lines.push(`  enabled       ${tunnelFlag(t.enabled)}`);
  lines.push(`  configured    ${tunnelFlag(t.configured)}`);
  lines.push(`  running       ${tunnelFlag(t.running)}`);
  if (t.publicApiUrl) {
    // Show the concrete endpoints propr-routing forwards, not the base URL as if
    // it were a health target — the root path intentionally 404s through the
    // tunnel. `reachable` reflects the /api/status probe.
    const { apiStatus, socketIo } = proprTunnelEndpoints(t.publicApiUrl);
    lines.push(`  API           ${apiStatus}`);
    lines.push(`  Socket.IO     ${socketIo}`);
  } else {
    lines.push(`  public URL    —`);
  }
  lines.push(`  reachable     ${tunnelFlag(t.reachable)}  (probes /api/status)`);
  return lines.join("\n");
}
