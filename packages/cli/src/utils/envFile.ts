/**
 * Minimal .env upsert helper.
 *
 * Sets each KEY to a value in a dotenv-style file: replaces the first
 * uncommented `KEY=` assignment if present, otherwise appends it. Other lines
 * (comments, blank lines, commented examples) are preserved.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function upsertEnvVars(envPath: string, vars: Record<string, string>): void {
  const raw = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  const lines = raw.split(/\r?\n/);

  // Drop trailing blank lines so appends stay tidy; we re-add one newline at the end.
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  for (const [key, value] of Object.entries(vars)) {
    const pattern = new RegExp(`^\\s*(export\\s+)?${escapeRegExp(key)}\\s*=`);
    const index = lines.findIndex((line) => pattern.test(line));
    const safe = /[\s#"'\\$`\n]/.test(value)
      ? `"${value.replace(/[\\"$`]/g, "\\$&")}"`
      : value;
    const assignment = `${key}=${safe}`;
    if (index >= 0) {
      lines[index] = assignment;
    } else {
      lines.push(assignment);
    }
  }

  writeFileSync(envPath, `${lines.join("\n")}\n`, "utf-8");
}
