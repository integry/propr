import { createHash } from 'node:crypto';

/** One-way identifier used to fence durable task metadata without storing the lease token. */
export function hashTaskAttemptToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}
