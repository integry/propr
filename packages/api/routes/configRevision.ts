import { createHash } from 'node:crypto';
import { ConfigRouteError } from './configHelpers.js';

/** Hash the complete snapshot, including fields not exposed by MCP. */
export function configRevision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function effectiveGithubUserWhitelist(settings: Record<string, unknown>): string[] {
  const value = Array.isArray(settings.github_user_whitelist)
    ? settings.github_user_whitelist
    : (process.env.GITHUB_USER_WHITELIST || '').split(',');
  return value.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim()).filter(Boolean);
}

/** Must be called while holding the same lock as persistence. */
export function assertConfigRevision(expected: unknown, current: unknown): void {
  if (expected !== undefined && expected !== configRevision(current)) {
    throw new ConfigRouteError(409, { error: 'Configuration changed. Read it again and retry with a new operation key.', code: 'STALE_REVISION' });
  }
}
