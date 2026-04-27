import crypto from 'node:crypto';
import type { SystemTaskJobData } from '../queue/taskQueue.types.js';

/** Maximum age (in ms) for a signed auth token before it is considered expired. */
export const AUTH_TOKEN_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes — allows for queue backlog and worker retries

/** Maximum clock-skew allowance (in ms) for future-dated tokens. */
export const AUTH_TOKEN_MAX_CLOCK_SKEW_MS = 60 * 1000; // 1 minute

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
    const now = Date.now();
    const age = now - data.authTimestamp;
    if (age > AUTH_TOKEN_MAX_AGE_MS) {
        return { valid: false, reason: `auth token expired (age: ${Math.round(age / 1000)}s)` };
    }
    if (data.authTimestamp > now + AUTH_TOKEN_MAX_CLOCK_SKEW_MS) {
        return { valid: false, reason: 'auth token timestamp is in the future' };
    }

    // Validate token format before comparison: must be a 64-char hex string (SHA-256 output)
    if (!data.authToken || !/^[0-9a-f]{64}$/i.test(data.authToken)) {
        return { valid: false, reason: 'malformed auth token (expected 64-char hex string)' };
    }

    const payload = buildAuthPayload(data);
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    const expectedToken = hmac.digest('hex');

    const isValid = crypto.timingSafeEqual(
        Buffer.from(data.authToken, 'hex'),
        Buffer.from(expectedToken, 'hex')
    );
    return isValid ? { valid: true } : { valid: false, reason: 'HMAC mismatch' };
}
