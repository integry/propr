/**
 * Minimal .env upsert helper.
 *
 * Sets each KEY to a value in a dotenv-style file: replaces the first
 * uncommented `KEY=` assignment if present, otherwise appends it. Other lines
 * (comments, blank lines, commented examples) are preserved.
 */

import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

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
    const needsQuoting = /[\s#"'\\$`\n]/.test(value);
    let safe: string;
    if (!needsQuoting) {
      safe = value;
    } else if (!value.includes("'")) {
      // Single quotes: literal in both dotenv and docker --env-file (no
      // escape processing), so the value round-trips identically.
      safe = `'${value}'`;
    } else {
      // Fallback: double quotes with escaping. docker --env-file strips
      // outer quotes but does NOT process backslash escapes, so values
      // containing $, `, or \ will read differently via --env-file vs
      // dotenv. This path is rare (value contains both ' and special chars).
      safe = `"${value.replace(/[\\"$`\n]/g, (ch) => ch === "\n" ? "\\n" : `\\${ch}`)}"`;
    }
    const assignment = `${key}=${safe}`;
    if (index >= 0) {
      lines[index] = assignment;
    } else {
      lines.push(assignment);
    }
  }

  const isNew = !existsSync(envPath);
  writeFileSync(envPath, `${lines.join("\n")}\n`, { encoding: "utf-8", mode: isNew ? 0o600 : undefined });
  if (!isNew) {
    try {
      const before = statSync(envPath).mode & 0o777;
      if (before !== 0o600) {
        chmodSync(envPath, 0o600);
        console.error(`Note: tightened ${envPath} permissions from ${before.toString(8)} to 600 (secrets file).`);
      }
    } catch {
      // Best-effort — may fail on Windows or non-owned files.
    }
  }
}
