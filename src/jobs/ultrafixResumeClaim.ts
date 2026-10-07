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
import { getUltrafixAutomaticWorkEpoch, reserveEpochAndReplaceStateIfUnchanged } from './ultrafixAutomaticWorkEpoch.js';
import {
    clearRearmRetry,
    clearRearmRetryIfClaimHeld,
    getActionCounts,
    getUltrafixStateKey,
    loadDeferredContinuation,
    loadRearmRetry,
    loadState,
    saveRearmRetryUnlessClaimTaken,
} from './ultrafixOrchestrationService.js';
import type { UltrafixAction, UltrafixLoopState, UltrafixRearmRetry } from './ultrafixOrchestrationService.js';
import type { ContinuationResult } from './ultrafixLoopContinuation.js';
import type { RearmRetryClearOutcome } from './ultrafixDeferredContinuationStore.js';

export type UltrafixPrId = { owner: string; repo: string; pr: number };

const RESUME_CLAIM_KEY_PREFIX = 'ultrafix:resume-claim';
const RESUME_RECHECK_KEY_PREFIX = 'ultrafix:resume-recheck';
const RELEASE_RESUME_CLAIM_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
const RENEW_RESUME_CLAIM_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end";

/** How long one resume trigger may hold the per-PR resume claim without renewing it. */
const RESUME_CLAIM_TTL_MS = 60_000;
/** Background renewal cadence; several renewals fit in one TTL. */
const RESUME_CLAIM_RENEW_INTERVAL_MS = RESUME_CLAIM_TTL_MS / 3;
/** A re-check request outlives any holder that could still honour it. */
const RESUME_RECHECK_TTL_MS = RESUME_CLAIM_TTL_MS * 2;
/** Bound on back-to-back passes one trigger runs for re-check requests. */
const MAX_RESUME_PASSES = 3;

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
    /**
     * Release the PR's retry obligation, atomically conditional on this claim
     * still being held in Redis. Evidence gathered by a holder whose claim
     * expired (e.g. a late enqueue acknowledgment) cannot release an
     * obligation a successor may have recorded since. With `workEpoch` it is
     * also conditional on that automatic-work epoch still being current.
     */
    clearRetry(workEpoch?: number): Promise<RearmRetryClearOutcome>;
    /**
     * Record the PR's retry obligation unless another trigger holds the claim
     * now; that holder owns the obligation. A claim lost to a renewal fault or
     * plain expiry has no new holder, so the obligation is still recorded.
     */
    saveRetry(retry: UltrafixRearmRetry): Promise<boolean>;
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

    // Defensive: `finalScore` is only written when a loop completes, and a loop
    // whose review reaches the goal completes at once, so an active loop does
    // not normally carry it. The check keeps a state that does (e.g. written by
    // an older release or by hand) from cycling past its own goal.
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
 * Hand a stranded loop to a freshly reserved automatic-work epoch, so a later
 * manual command or follow-up fences the re-armed step like any other
 * automatic step. The reservation is conditional on `currentEpoch` still being
 * current and on the state still being the snapshot the decision was made
 * from, so neither a racing takeover nor a newer or updated loop can be
 * overwritten by this one, and a rejected attempt reserves nothing.
 */
export async function reserveStateWorkEpoch(
    redis: Redis,
    snapshot: UltrafixStateSnapshot,
    currentEpoch: number,
): Promise<UltrafixLoopState | null> {
    const { state } = snapshot;
    const workEpoch = await reserveEpochAndReplaceStateIfUnchanged(
        redis,
        { owner: state.owner, repo: state.repo, pr: state.pr },
        { workEpoch: currentEpoch, rawState: snapshot.raw },
        reserved => JSON.stringify({ ...state, workEpoch: reserved }),
    );
    return workEpoch === null ? null : { ...state, workEpoch };
}

/**
 * Cheap Redis gate shared by every resume trigger: is there anything for this
 * PR to resume? That is a deferred record, or an active loop that is stranded:
 * its epoch was superseded, or a retry obligation names it. Most CI events are
 * for PRs with none of these.
 *
 * An active loop still owned by the current epoch is not a candidate: its own
 * step (startup's initial job, a queued step, or that step's continuation)
 * drives it. The resume paths that hand such a loop off (a re-arm taking
 * ownership, a deferred record being claimed) record a retry obligation first,
 * which keeps it a candidate. So a healthy mid-cycle loop costs no GitHub calls
 * per poll, and a trigger cannot fence a startup whose initial job is not
 * queued yet.
 */
export async function hasUltrafixResumeCandidate(redis: Redis, prId: UltrafixPrId): Promise<boolean> {
    const { owner, repo, pr } = prId;
    if (await loadDeferredContinuation(redis, owner, repo, pr)) return true;
    const state = await loadState(redis, owner, repo, pr);
    if (!state || evaluateStrandedLoopRearm(state).action === 'skip') return false;
    const stateEpoch = typeof state.workEpoch === 'number' ? state.workEpoch : 0;
    if (stateEpoch !== await getUltrafixAutomaticWorkEpoch(redis, owner, repo, pr)) return true;
    return await loadRearmRetry(redis, owner, repo, pr) !== null;
}

export function getUltrafixResumeRecheckKey(owner: string, repo: string, pr: number): string {
    return `${RESUME_RECHECK_KEY_PREFIX}:${owner}:${repo}:${pr}`;
}

/**
 * Take the resume claim, or leave a re-check request for its holder. The
 * holder consumes the request after releasing the claim, so a trigger that
 * arrives while another is mid-evaluation (and may have read CI before it
 * turned green) is re-run instead of dropped. Re-trying the claim after
 * recording the request closes the gap where the holder released in between.
 */
async function acquireOrRequestRecheck(redis: Redis, prId: UltrafixPrId): Promise<string | null> {
    const recheckKey = getUltrafixResumeRecheckKey(prId.owner, prId.repo, prId.pr);
    const token = randomUUID();
    if (!await acquireResumeClaim(redis, prId, token, RESUME_CLAIM_TTL_MS)) {
        await redis.set(recheckKey, '1', 'PX', RESUME_RECHECK_TTL_MS);
        if (!await acquireResumeClaim(redis, prId, token, RESUME_CLAIM_TTL_MS)) return null;
    }
    // This pass starts after every request recorded so far, so it answers them.
    await redis.del(recheckKey);
    return token;
}

async function runWithHeldClaim(
    prId: UltrafixPrId,
    token: string,
    ctx: { redisClient: Redis; correlatedLogger: Logger },
    operation: (claim: ResumeClaim) => Promise<ContinuationResult>,
): Promise<ContinuationResult> {
    const { redisClient, correlatedLogger } = ctx;
    let lost = false;
    const claimKey = getUltrafixResumeClaimKey(prId.owner, prId.repo, prId.pr);
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
        clearRetry(workEpoch) {
            return clearRearmRetryIfClaimHeld(redisClient, prId, { key: claimKey, token }, workEpoch);
        },
        saveRetry(retry) {
            return saveRearmRetryUnlessClaimTaken(redisClient, retry, { key: claimKey, token });
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

/**
 * Run `operation` while holding the per-PR resume claim. Every resume trigger
 * (deferred record or stranded-loop fallback) evaluates readiness and enqueues
 * under this one claim, so concurrent triggers cannot schedule conflicting steps.
 * The claim is renewed while the operation runs; the operation must call
 * `claim.confirm()` before each mutation and stop when it returns false.
 *
 * A trigger that finds the claim held is not dropped: it records a re-check
 * request, and the holder runs `operation` again (bounded) once it releases.
 */
export async function withResumeClaim(
    prId: UltrafixPrId,
    redisClient: Redis,
    correlatedLogger: Logger,
    operation: (claim: ResumeClaim) => Promise<ContinuationResult>,
): Promise<ContinuationResult> {
    const { owner, repo, pr } = prId;
    let result: ContinuationResult | null = null;
    for (let pass = 1; pass <= MAX_RESUME_PASSES; pass++) {
        if (!await hasUltrafixResumeCandidate(redisClient, prId)) {
            // Nothing left to resume: a retry obligation for this PR is moot.
            await clearRearmRetry(redisClient, owner, repo, pr);
            return result ?? { continued: false, reason: 'no_deferred_continuation' };
        }
        const token = await acquireOrRequestRecheck(redisClient, prId);
        // The current holder will honour the recorded re-check request.
        if (!token) return result ?? { continued: false, reason: 'resume_in_progress' };
        const passResult = await runWithHeldClaim(prId, token, { redisClient, correlatedLogger }, operation);
        // A pass that scheduled the next step is what this trigger achieved.
        if (!result?.continued) result = passResult;
        if (!await redisClient.getdel(getUltrafixResumeRecheckKey(owner, repo, pr))) return result;
        correlatedLogger.info({ pr, pass, reason: passResult.reason }, 'Ultrafix resume: trigger arrived meanwhile, re-evaluating');
    }
    // Still contended after the bounded passes: leave the request for the next holder.
    await redisClient.set(getUltrafixResumeRecheckKey(owner, repo, pr), '1', 'PX', RESUME_RECHECK_TTL_MS);
    return result!;
}
