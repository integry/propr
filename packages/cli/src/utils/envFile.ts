/**
 * Minimal .env upsert helper.
 *
 * Sets each KEY to a value in a Docker --env-file-compatible dotenv file: replaces the first
 * uncommented `KEY=` assignment if present, otherwise appends it. Other lines
 * (comments, blank lines, commented examples) are preserved.
 *
 * Docker does not strip quotes in --env-file values, so values are written
 * literally and must fit on one line.
 */

import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function upsertEnvVars(envPath: string, vars: Record<string, string>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (/[\r\n]/.test(value)) {
      throw new Error(`${key} cannot contain newlines; Docker --env-file only supports one KEY=VALUE assignment per line.`);
    }
    if (/^\s|\s$/.test(value)) {
      throw new Error(`${key} cannot contain leading or trailing whitespace in ${envPath}; Docker --env-file does not strip quotes.`);
    }
    if (/\s#/.test(value)) {
      // The orchestrator's env-file reader strips a trailing " #comment" from
      // unquoted values, so such a value would not survive a read-back round trip.
      throw new Error(`${key} cannot contain whitespace followed by '#' in ${envPath}; it would be read back as a truncated value (inline-comment syntax).`);
    }
  }

  const raw = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  const lines = raw.split(/\r?\n/);

  // Drop trailing blank lines so appends stay tidy; we re-add one newline at the end.
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  for (const [key, value] of Object.entries(vars)) {
    const pattern = new RegExp(`^\\s*(export\\s+)?${escapeRegExp(key)}\\s*=`);
    const index = lines.findIndex((line) => pattern.test(line));
    const preserveExport = index >= 0 && /^\s*export\s+/.test(lines[index]);
    const assignment = `${preserveExport ? "export " : ""}${key}=${value}`;
    if (index >= 0) {
      lines[index] = assignment;
    } else {
      lines.push(assignment);
    }
  }

  const isNew = !existsSync(envPath);
  let tightenedFrom: number | null = null;
  if (!isNew) {
    try {
      const before = statSync(envPath).mode & 0o777;
      if (before !== 0o600) {
        chmodSync(envPath, 0o600);
        tightenedFrom = before;
      }
    } catch {
      // Best-effort — may fail on Windows or non-owned files.
    }
  }

  writeFileSync(envPath, `${lines.join("\n")}\n`, { encoding: "utf-8", mode: isNew ? 0o600 : undefined });
  if (tightenedFrom !== null) {
    console.warn(`Note: tightened ${envPath} permissions from ${tightenedFrom.toString(8)} to 600 (secrets file).`);
  }
}

/**
 * Remove the given keys from a .env file entirely.
 *
 * Deletes every uncommented `KEY=` assignment for each key — so a key that was
 * accidentally assigned more than once is fully cleared, not just thinned to its
 * last duplicate; every other line — comments, blanks, and unrelated keys — is
 * preserved verbatim. A missing file, an empty key list, and keys that aren't
 * present are all no-ops.
 *
 * This exists because {@link upsertEnvVars} can only *set* a value: writing a
 * blank (e.g. `GITHUB_USER_WHITELIST=`) still leaves the key in the file, where
 * it reads back as an empty value rather than as "unset". Setup flows that must
 * genuinely clear a stale key (clearing the user whitelist, dropping a key when
 * switching auth/intake modes) use this so the value does not silently return on
 * the next read or restart.
 */
export function clearEnvKeys(envPath: string, keys: string[]): void {
  if (keys.length === 0 || !existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf-8").split(/\r?\n/);
  const patterns = keys.map((key) => new RegExp(`^\\s*(export\\s+)?${escapeRegExp(key)}\\s*=`));
  const kept = lines.filter((line) => !patterns.some((pattern) => pattern.test(line)));

  // Nothing matched → leave the file (and its mode) untouched.
  if (kept.length === lines.length) return;

  // Tighten permissions like upsertEnvVars does — this is still the secrets file.
  let tightenedFrom: number | null = null;
  try {
    const before = statSync(envPath).mode & 0o777;
    if (before !== 0o600) {
      chmodSync(envPath, 0o600);
      tightenedFrom = before;
    }
  } catch {
    // Best-effort — may fail on Windows or non-owned files.
  }

  // Drop trailing blank lines, then re-add exactly one terminating newline.
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  writeFileSync(envPath, `${kept.join("\n")}\n`, "utf-8");
  if (tightenedFrom !== null) {
    console.warn(`Note: tightened ${envPath} permissions from ${tightenedFrom.toString(8)} to 600 (secrets file).`);
  }
}
