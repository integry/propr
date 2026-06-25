/**
 * Shared rendering for stack status — used by `propr status` (one-shot) and the
 * `propr start` TUI's non-TTY fallback.
 */

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
  lines.push(`  public URL    ${t.publicApiUrl ?? "—"}`);
  lines.push(`  reachable     ${tunnelFlag(t.reachable)}`);
  return lines.join("\n");
}
