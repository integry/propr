import { createHash } from 'node:crypto';
import { ConfigRouteError } from './configHelpers.js';

/** Hash the complete snapshot, including fields not exposed by MCP. */
export function configRevision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Must be called while holding the same lock as persistence. */
export function assertConfigRevision(expected: unknown, current: unknown): void {
  if (expected !== undefined && expected !== configRevision(current)) {
    throw new ConfigRouteError(409, { error: 'Configuration changed. Read it again and retry with a new operation key.', code: 'STALE_REVISION' });
  }
}
