/**
 * The shared lease that makes one pull request's CI suspension a single-writer
 * operation across every worker process.
 *
 * Generation-checked writes protect the stored state, but they cannot serialize
 * the effects that leave the process: a sweep can read an active suspension,
 * another worker's finalizer can transition it to restoring and rerun the
 * cancelled runs, and the first worker would then cancel validation that was
 * just brought back. Begin, sweep, restore and release therefore all run while
 * holding this lease, which lives in the database every worker already shares.
 *
 * The lease is held by a token, renewed while the operation runs, released only
 * by its holder, and taken over once it expires so a crashed worker cannot
 * block a pull request forever.
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Knex } from 'knex';
import { nowMs, resolveDatabase, type CiSuspensionStoreDeps } from './followupCiSuspensionStore.js';

export const PR_CI_SUSPENSION_LEASES_TABLE = 'pr_ci_suspension_leases';

/** Long enough to outlive a restore that waits for GitHub's asynchronous cancellation, short enough to recover from a crash. */
export const LEASE_TTL_MS = 2 * 60 * 1000;
/** Renewal keeps a long operation's lease alive well before it expires. */
export const LEASE_RENEW_INTERVAL_MS = 30 * 1000;
/** Bounded acquisition: a caller that cannot get the lease gives up instead of piling up on it. */
export const LEASE_ACQUIRE_TIMEOUT_MS = 30 * 1000;
const LEASE_RETRY_INTERVAL_MS = 250;
/** Which worker holds the row, so an operator reading the table sees who to look at. */
const DEFAULT_LEASE_HOLDER = `${hostname()}:${process.pid}`;

/** Thrown when another worker held the lease for this pull request the whole time. */
export class SuspensionLeaseUnavailableError extends Error {
    constructor(readonly leaseKey: string) {
        super(`Another worker is already handling the CI suspension of ${leaseKey}`);
        this.name = 'SuspensionLeaseUnavailableError';
    }
}

/** Thrown when the lease expired and was taken over while its holder was still working. */
export class SuspensionLeaseLostError extends Error {
    constructor(readonly leaseKey: string) {
        super(`Lost the CI suspension lease of ${leaseKey}`);
        this.name = 'SuspensionLeaseLostError';
    }
}

/** The handle an operation holds while it runs; `assertHeld` proves the lease is still this worker's before it acts on GitHub again. */
export interface SuspensionLease {
    token: string;
    assertHeld: () => Promise<void>;
}

export interface SuspensionLeaseDeps extends CiSuspensionStoreDeps {
    /** Identifies the worker in the lease row; diagnostics only, never ownership — the token owns the lease. */
    leaseHolder?: string;
    leaseTtlMs?: number;
    leaseAcquireTimeoutMs?: number;
    leaseRenewIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
}

interface LeaseRow {
    lease_key: string;
    token: string;
    holder: string | null;
    acquired_at: number;
    expires_at: number;
}

function leaseTable(deps: SuspensionLeaseDeps): Knex.QueryBuilder<LeaseRow> {
    return resolveDatabase(deps)<LeaseRow>(PR_CI_SUSPENSION_LEASES_TABLE);
}

async function wait(deps: SuspensionLeaseDeps, ms: number): Promise<void> {
    // Yield to the event loop first: the holder this caller waits for makes
    // progress on timers and I/O, not on microtasks, so even a test that stubs
    // the sleep away must not be able to spin the holder out.
    await new Promise<void>(resolve => { setImmediate(resolve); });
    if (deps.sleep) return deps.sleep(ms);
    await new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); });
}

/** Takes the lease over once it expired; the predicate makes the takeover atomic for concurrent workers. */
async function claimExpired(deps: SuspensionLeaseDeps, leaseKey: string, token: string, ttlMs: number): Promise<boolean> {
    const now = nowMs(deps);
    const claimed = await leaseTable(deps)
        .where('lease_key', leaseKey)
        .andWhere('expires_at', '<=', now)
        .update({ token, holder: deps.leaseHolder ?? DEFAULT_LEASE_HOLDER, acquired_at: now, expires_at: now + ttlMs });
    return claimed > 0;
}

async function tryAcquire(deps: SuspensionLeaseDeps, leaseKey: string, token: string, ttlMs: number): Promise<boolean> {
    const now = nowMs(deps);
    try {
        await leaseTable(deps).insert({
            lease_key: leaseKey, token, holder: deps.leaseHolder ?? DEFAULT_LEASE_HOLDER, acquired_at: now, expires_at: now + ttlMs,
        });
        return true;
    } catch {
        // The row exists, so somebody holds or held the lease.
        return claimExpired(deps, leaseKey, token, ttlMs);
    }
}

/** Extends the lease, but only while this token still owns it. */
export async function renewLease(deps: SuspensionLeaseDeps, leaseKey: string, token: string): Promise<boolean> {
    const ttlMs = deps.leaseTtlMs ?? LEASE_TTL_MS;
    const renewed = await leaseTable(deps)
        .where({ lease_key: leaseKey, token })
        .update({ expires_at: nowMs(deps) + ttlMs });
    return renewed > 0;
}

/** Releases the lease, but only while this token still owns it: a taken-over lease belongs to somebody else. */
export async function releaseLease(deps: SuspensionLeaseDeps, leaseKey: string, token: string): Promise<boolean> {
    const released = await leaseTable(deps).where({ lease_key: leaseKey, token }).delete();
    return released > 0;
}

/**
 * Runs `operation` while this process holds the pull request's lease.
 *
 * Acquisition is bounded: after `leaseAcquireTimeoutMs` without the lease the
 * caller gets {@link SuspensionLeaseUnavailableError} and handles a busy pull
 * request instead of waiting on it. While the operation runs the lease is
 * renewed; `assertHeld` lets long operations prove they still own it before
 * acting on GitHub again.
 */
export async function withSuspensionLease<T>(
    deps: SuspensionLeaseDeps,
    leaseKey: string,
    operation: (lease: SuspensionLease) => Promise<T>,
): Promise<T> {
    const ttlMs = deps.leaseTtlMs ?? LEASE_TTL_MS;
    const token = randomUUID();
    const deadline = nowMs(deps) + (deps.leaseAcquireTimeoutMs ?? LEASE_ACQUIRE_TIMEOUT_MS);
    let acquired = await tryAcquire(deps, leaseKey, token, ttlMs);
    while (!acquired) {
        if (nowMs(deps) >= deadline) throw new SuspensionLeaseUnavailableError(leaseKey);
        await wait(deps, LEASE_RETRY_INTERVAL_MS);
        acquired = await tryAcquire(deps, leaseKey, token, ttlMs);
    }

    const renewIntervalMs = deps.leaseRenewIntervalMs ?? LEASE_RENEW_INTERVAL_MS;
    let lost = false;
    const heartbeat = setInterval(() => {
        void renewLease(deps, leaseKey, token).then(renewed => { if (!renewed) lost = true; }).catch(() => undefined);
    }, renewIntervalMs);
    heartbeat.unref?.();

    try {
        return await operation({
            token,
            assertHeld: async () => {
                if (lost || !await renewLease(deps, leaseKey, token)) {
                    lost = true;
                    throw new SuspensionLeaseLostError(leaseKey);
                }
            },
        });
    } finally {
        clearInterval(heartbeat);
        await releaseLease(deps, leaseKey, token).catch(() => undefined);
    }
}
