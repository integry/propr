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

import { readPrivateFile, writePrivateFileAtomic } from "./privateFilesystem.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function upsertEnvVars(envPath: string, vars: Record<string, string>, signal?: AbortSignal): void {
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

  const previous = readPrivateFile(envPath);
  const raw = previous?.toString("utf-8") ?? "";
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

  writePrivateFileAtomic(envPath, `${lines.join("\n")}\n`, { signal });
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
export function clearEnvKeys(envPath: string, keys: string[], signal?: AbortSignal): void {
  if (keys.length === 0) return;

  const previous = readPrivateFile(envPath);
  if (!previous) return;
  const lines = previous.toString("utf-8").split(/\r?\n/);
  const patterns = keys.map((key) => new RegExp(`^\\s*(export\\s+)?${escapeRegExp(key)}\\s*=`));
  const kept = lines.filter((line) => !patterns.some((pattern) => pattern.test(line)));

  // Nothing matched → leave the file (and its mode) untouched.
  if (kept.length === lines.length) return;

  // Drop trailing blank lines, then re-add exactly one terminating newline.
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  writePrivateFileAtomic(envPath, `${kept.join("\n")}\n`, { signal });
}
