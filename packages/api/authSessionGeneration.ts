import { createHash } from 'node:crypto';
import type { Request } from 'express';

/** Stable, non-reversible identity for one authenticated Express session ID. */
export function createSessionAuthGeneration(sessionId: string): string {
  sessionId = sessionId.trim();
  if (!sessionId) throw new Error('Authenticated request is missing its session generation');
  return `session-sha256:${createHash('sha256').update(sessionId).digest('hex')}`;
}

export function getSessionAuthGeneration(req: Request): string {
  return createSessionAuthGeneration(
    typeof req.sessionID === 'string' ? req.sessionID : ''
  );
}
