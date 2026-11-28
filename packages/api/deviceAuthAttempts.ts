/**
 * Device sign-in attempt state in the browser session (#3867), and the fences
 * that keep a request which awaited GitHub from acting on an attempt or start
 * that was cancelled or replaced meanwhile.
 */
import type { Request } from 'express';
import type { AuthSession } from './authSession.js';

/** How long a replaced or cancelled start stays revoked while its code request may still be in flight. */
const START_REVOCATION_MS = 5 * 60_000;

export interface DeviceLoginAttempt {
    attempt: string;
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresAt: number;
    intervalSeconds: number;
    nextPollAt: number;
}

export type DeviceAuthSession = AuthSession & {
    deviceLogin?: DeviceLoginAttempt;
    deviceLoginStarts?: number[];
    /** The latest start, while GitHub is asked for its code; becomes the attempt id. */
    deviceLoginStart?: string;
};

export function saveSession(req: Request): Promise<void> {
    return new Promise((resolve, reject) => req.session.save(error => (error ? reject(error) : resolve())));
}

function reloadSession(req: Request): Promise<void> {
    return new Promise((resolve, reject) => req.session.reload(error => (error ? reject(error) : resolve())));
}

/**
 * Attempts cancelled or replaced in this process, until their code expires.
 * The stored session is the cross-request record, but a request that loaded
 * it before a cancel could still write it back; this set makes the revocation
 * stick for every request this process serves.
 */
const revokedAttempts = new Map<string, number>();

function revokeAttempt(attempt: DeviceLoginAttempt | undefined, now: number): void {
    for (const [id, expiresAt] of revokedAttempts) if (expiresAt <= now) revokedAttempts.delete(id);
    // Kept a little past expiry too: a poll in flight at expiry still checks it.
    if (attempt) revokedAttempts.set(attempt.attempt, Math.max(attempt.expiresAt, now) + 60_000);
}

/** Revoke the session's attempt and any start still waiting on GitHub, and drop both. */
export function revokeSessionAttempts(session: DeviceAuthSession, now: number): void {
    revokeAttempt(session.deviceLogin, now);
    if (session.deviceLoginStart) revokedAttempts.set(session.deviceLoginStart, now + START_REVOCATION_MS);
    delete session.deviceLogin;
    delete session.deviceLoginStart;
}

/**
 * Re-read the session after the code request and report whether this start
 * is still the latest one. As with `currentAttempt`, the caller writes
 * synchronously after this resolves. A superseded start leaves the reloaded
 * session untouched, so nothing of it is saved, even by express-session.
 */
export async function ownsStart(req: Request, startId: string): Promise<boolean> {
    if (revokedAttempts.has(startId)) return false;
    try {
        await reloadSession(req);
    } catch {
        return false;
    }
    if (revokedAttempts.has(startId)) return false;
    const session = req.session as DeviceAuthSession;
    return session.deviceLoginStart === startId && !session.deviceLogin;
}

/**
 * Re-read the session after an await and return the attempt only if it is
 * still the active, unrevoked one. Callers must write or sign in synchronously
 * after this resolves, so no other await separates the check from the effect.
 */
export async function currentAttempt(req: Request, attemptId: string): Promise<DeviceLoginAttempt | undefined> {
    if (revokedAttempts.has(attemptId)) return undefined;
    try {
        await reloadSession(req);
    } catch {
        // The session is gone (logged out, destroyed or the store lost it).
        return undefined;
    }
    if (revokedAttempts.has(attemptId)) return undefined;
    const stored = (req.session as DeviceAuthSession).deviceLogin;
    return stored?.attempt === attemptId ? stored : undefined;
}

/** Drop the attempt from the session if it is still the active one; never restore a replaced one. */
export async function endAttempt(req: Request, attemptId: string): Promise<void> {
    if (!(await currentAttempt(req, attemptId))) return;
    delete (req.session as DeviceAuthSession).deviceLogin;
    await saveSession(req).catch(() => undefined);
}
