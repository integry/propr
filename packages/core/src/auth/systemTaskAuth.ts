import crypto from 'node:crypto';
import type { SystemTaskJobData } from '../queue/taskQueue.types.js';

/** Maximum age (in ms) for a signed auth token before it is considered expired. */
export const AUTH_TOKEN_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes — allows for queue backlog and worker retries

/**
 * Build the canonical HMAC signing payload.
 * Includes all security-relevant fields so that tampering with any of them
 * (e.g. swapping commitHash or targetCommentId) invalidates the token.
 */
export function buildAuthPayload(data: Pick<SystemTaskJobData, 'type' | 'owner' | 'repoName' | 'prNumber' | 'requestingUser' | 'commitHash' | 'targetCommentId' | 'prBranch' | 'authTimestamp'>): string {
    return `${data.type}:${data.owner}:${data.repoName}:${data.prNumber}:${data.requestingUser}:${data.commitHash}:${data.targetCommentId}:${data.prBranch}:${data.authTimestamp}`;
}

/**
 * Generate an HMAC-SHA256 auth token for a system task request.
 */
export function generateAuthToken(data: Pick<SystemTaskJobData, 'type' | 'owner' | 'repoName' | 'prNumber' | 'requestingUser' | 'commitHash' | 'targetCommentId' | 'prBranch' | 'authTimestamp'>, secret: string): string {
    const payload = buildAuthPayload(data);
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    return hmac.digest('hex');
}

/**
 * Verify the HMAC auth token for a system task request.
 * The token is an HMAC-SHA256 signature over all security-relevant fields
 * using the provided secret.
 * Also validates that the token has not expired (replay resistance).
 */
export function verifyAuthToken(data: SystemTaskJobData, secret: string | undefined): { valid: boolean; reason?: string } {
    if (!secret) {
        return { valid: false, reason: 'SYSTEM_TASK_SECRET is not configured on worker' };
    }

    if (!data.authTimestamp || typeof data.authTimestamp !== 'number') {
        return { valid: false, reason: 'missing authTimestamp' };
    }
    const age = Date.now() - data.authTimestamp;
    if (age > AUTH_TOKEN_MAX_AGE_MS) {
        return { valid: false, reason: `auth token expired (age: ${Math.round(age / 1000)}s)` };
    }

    const payload = buildAuthPayload(data);
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    const expectedToken = hmac.digest('hex');

    try {
        const isValid = crypto.timingSafeEqual(
            Buffer.from(data.authToken, 'hex'),
            Buffer.from(expectedToken, 'hex')
        );
        return isValid ? { valid: true } : { valid: false, reason: 'HMAC mismatch' };
    } catch {
        return { valid: false, reason: 'HMAC comparison failed (malformed token)' };
    }
}
