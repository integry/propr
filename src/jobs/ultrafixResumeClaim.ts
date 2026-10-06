/**
 * Ultrafix Resume Claim
 *
 * Redis-only primitives shared by every Ultrafix resume trigger: the per-PR
 * resume claim, the stranded-loop circuit breakers, and epoch-fenced state sync.
 * Kept free of runtime dependencies on @propr/core and the queue helpers.
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { replaceUltrafixStateIfUnchanged } from './ultrafixAutomaticWorkEpoch.js';
import { getActionCounts, getUltrafixStateKey, loadDeferredContinuation, loadState } from './ultrafixOrchestrationService.js';
import type { UltrafixAction, UltrafixLoopState } from './ultrafixOrchestrationService.js';
import type { ContinuationResult } from './ultrafixLoopContinuation.js';

export type UltrafixPrId = { owner: string; repo: string; pr: number };

const RESUME_CLAIM_KEY_PREFIX = 'ultrafix:resume-claim';
const RELEASE_RESUME_CLAIM_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
const RENEW_RESUME_CLAIM_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end";

/** How long one resume trigger may hold the per-PR resume claim without renewing it. */
const RESUME_CLAIM_TTL_MS = 60_000;
/** Background renewal cadence; several renewals fit in one TTL. */
const RESUME_CLAIM_RENEW_INTERVAL_MS = RESUME_CLAIM_TTL_MS / 3;

/** Ordinal of the next step for `action` (completed steps of that action + 1). */
export function getNextStepNumber(state: UltrafixLoopState, action: UltrafixAction): number {
    const { reviewCount, fixCount } = getActionCounts(state);
    return (action === 'review' ? reviewCount : fixCount) + 1;
}

export function getUltrafixResumeClaimKey(owner: string, repo: string, pr: number): string {
    return `${RESUME_CLAIM_KEY_PREFIX}:${owner}:${repo}:${pr}`;
}

/**
 * Take the per-PR resume claim so concurrent check_run/status triggers cannot
 * resume or re-arm the same loop twice. The TTL bounds the claim if its holder crashes.
 */
export async function acquireResumeClaim(
    redis: Redis,
    prId: UltrafixPrId,
    token: string,
    ttlMs: number,
): Promise<boolean> {
    const result = await redis.set(getUltrafixResumeClaimKey(prId.owner, prId.repo, prId.pr), token, 'PX', ttlMs, 'NX');
    return result === 'OK';
}

/** Release the resume claim only when it is still held by `token`. */
export async function releaseResumeClaim(redis: Redis, prId: UltrafixPrId, token: string): Promise<boolean> {
    const released = await redis.eval(
        RELEASE_RESUME_CLAIM_SCRIPT,
        1,
        getUltrafixResumeClaimKey(prId.owner, prId.repo, prId.pr),
        token,
    );
    return Number(released) === 1;
}

/** Extend the resume claim only when it is still held by `token`. */
export async function renewResumeClaim(
    redis: Redis,
    prId: UltrafixPrId,
    token: string,
    ttlMs: number,
): Promise<boolean> {
    const renewed = await redis.eval(
        RENEW_RESUME_CLAIM_SCRIPT,
        1,
        getUltrafixResumeClaimKey(prId.owner, prId.repo, prId.pr),
        token,
        String(ttlMs),
    );
    return Number(renewed) === 1;
}

/**
 * Ownership of a held resume claim. `confirm()` renews the claim and reports
 * whether it is still owned; it must be awaited immediately before every
 * mutation or enqueue, so a trigger whose claim expired mid-operation (and may
 * have been taken by another trigger) stops instead of acting on stale state.
 */
export interface ResumeClaim {
    confirm(): Promise<boolean>;
}

export const RESUME_CLAIM_LOST_REASON = 'resume_claim_lost';

export type StrandedLoopRearmDecision =
    | { action: 'skip'; reason: 'no_active_loop' }
    | { action: 'complete'; completionStatus: 'succeeded' | 'failed'; reason: string }
    | { action: 'rearm' };

/**
 * Apply the Ultrafix circuit breakers to a loop that lost its deferred
 * continuation. Side-effect free; label presence and readiness are checked by
 * the caller because they require GitHub and queue access.
 */
export function evaluateStrandedLoopRearm(state: UltrafixLoopState | null): StrandedLoopRearmDecision {
    if (!state || !state.active) return { action: 'skip', reason: 'no_active_loop' };

    if (state.finalScore !== null && state.finalScore !== undefined && state.finalScore >= state.goal) {
        return {
            action: 'complete',
            completionStatus: 'succeeded',
            reason: `Score ${state.finalScore}/10 already reaches goal ${state.goal}/10`,
        };
    }

    const { reviewCount, fixCount } = getActionCounts(state);
    if (reviewCount >= state.maxCycles || fixCount >= state.maxCycles) {
        return {
            action: 'complete',
            completionStatus: 'failed',
            reason: `Max cycles reached: ${reviewCount} review and ${fixCount} fix steps completed (limit ${state.maxCycles})`,
        };
    }

    return { action: 'rearm' };
}

/** A loop state together with the exact serialized value it was parsed from. */
export interface UltrafixStateSnapshot {
    raw: string;
    state: UltrafixLoopState;
}

export async function loadStateSnapshot(
    redis: Redis,
    owner: string,
    repo: string,
    pr: number,
): Promise<UltrafixStateSnapshot | null> {
    const raw = await redis.get(getUltrafixStateKey(owner, repo, pr));
    return raw ? { raw, state: JSON.parse(raw) as UltrafixLoopState } : null;
}

/**
 * Hand a stranded loop to the current automatic-work epoch. The write is
 * conditional on that epoch and on the state still being the snapshot the
 * decision was made from, so neither a racing takeover nor a newer or updated
 * loop can be overwritten by this one.
 */
export async function syncStateWorkEpoch(
    redis: Redis,
    snapshot: UltrafixStateSnapshot,
    workEpoch: number,
): Promise<UltrafixLoopState | null> {
    const { state } = snapshot;
    const synced = { ...state, workEpoch };
    const saved = await replaceUltrafixStateIfUnchanged(
        redis,
        { owner: state.owner, repo: state.repo, pr: state.pr },
        { workEpoch, rawState: snapshot.raw },
        JSON.stringify(synced),
    );
    return saved ? synced : null;
}

/**
 * Run `operation` while holding the per-PR resume claim. Every resume trigger
 * (deferred record or stranded-loop fallback) evaluates readiness and enqueues
 * under this one claim, so concurrent triggers cannot schedule conflicting steps.
 * The claim is renewed while the operation runs; the operation must call
 * `claim.confirm()` before each mutation and stop when it returns false.
 */
export async function withResumeClaim(
    prId: UltrafixPrId,
    redisClient: Redis,
    correlatedLogger: Logger,
    operation: (claim: ResumeClaim) => Promise<ContinuationResult>,
): Promise<ContinuationResult> {
    const { owner, repo, pr } = prId;
    // Cheap Redis gate first: most check_run events are for PRs without a loop.
    if (!await loadDeferredContinuation(redisClient, owner, repo, pr)
        && evaluateStrandedLoopRearm(await loadState(redisClient, owner, repo, pr)).action === 'skip') {
        return { continued: false, reason: 'no_deferred_continuation' };
    }

    const token = randomUUID();
    if (!await acquireResumeClaim(redisClient, prId, token, RESUME_CLAIM_TTL_MS)) {
        return { continued: false, reason: 'resume_in_progress' };
    }
    let lost = false;
    const claim: ResumeClaim = {
        async confirm() {
            if (lost) return false;
            try {
                if (!await renewResumeClaim(redisClient, prId, token, RESUME_CLAIM_TTL_MS)) lost = true;
            } catch (err) {
                // Fail closed: without a confirmed renewal another trigger may own the loop.
                lost = true;
                correlatedLogger.warn({ pr: prId.pr, error: (err as Error).message }, 'Ultrafix resume: failed to renew resume claim');
            }
            if (lost) correlatedLogger.warn({ pr: prId.pr }, 'Ultrafix resume: resume claim lost, aborting');
            return !lost;
        },
    };
    // Keep the claim alive across slow awaits (GitHub, queue scans) between confirmations.
    const renewal = setInterval(() => { void claim.confirm(); }, RESUME_CLAIM_RENEW_INTERVAL_MS);
    renewal.unref?.();
    try {
        return await operation(claim);
    } finally {
        clearInterval(renewal);
        await releaseResumeClaim(redisClient, prId, token).catch((err: Error) => {
            correlatedLogger.warn({ pr: prId.pr, error: err.message }, 'Ultrafix resume: failed to release resume claim');
        });
    }
}
