/**
 * Shared, dependency-free constants and helpers for the GitHub App manifest
 * generator. Kept separate from `githubAppCommands.ts` so modules that only need
 * the output filenames (e.g. the setup engine) can import them without pulling
 * in commander — preserving the engine's lazy command loading — and without
 * duplicating the literals and risking drift.
 */

/** Output filenames written by `propr github-app manifest`. */
export const MANIFEST_FILENAME = "github-app-manifest.json";
export const ENV_FILENAME = "github-app.env";

/**
 * True when `value` is an absolute http(s) URL. A pure, non-throwing check
 * suitable for prompt-time validation (the generator applies the same rule via
 * its throwing validator).
 */
export function isValidPublicUrl(value: string): boolean {
  const raw = value.trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
