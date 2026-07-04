/**
 * Project Slug Parsing
 *
 * Single source of truth for the owner/repo slug rules shared by the CLI
 * (project flags and config values) and the API (repository assertions), so
 * the two sides cannot drift.
 */

function isValidSlugSegment(segment: string): boolean {
  return (
    segment !== "." &&
    segment !== ".." &&
    /^[A-Za-z0-9_.-]+$/.test(segment)
  );
}

/**
 * Parses a project value into owner/repo parts.
 *
 * Returns the parts when the trimmed value is in owner/repo form without path
 * traversal or empty segments, or null when the value is invalid.
 */
export function parseProjectSlug(value: string): { owner: string; repo: string } | null {
  const parts = value.trim().split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  return isValidSlugSegment(owner) && isValidSlugSegment(repo) ? { owner, repo } : null;
}
