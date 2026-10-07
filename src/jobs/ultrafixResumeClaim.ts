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
    clearRearmRetryIfClaimHeld,
    getActionCounts,
    getUltrafixStateKey,
    loadDeferredContinuation,
    loadRearmRetry,
    loadRearmRetryRaw,
    loadState,
    saveRearmRetryUnlessClaimTaken,
} from './ultrafixOrchestrationService.js';
import type { UltrafixAction, UltrafixLoopState, UltrafixRearmRetry } from './ultrafixOrchestrationService.js';
import type { ContinuationResult } from './ultrafixLoopContinuation.js';
import type { ExpectedRearmRetry, RearmRetryClearOutcome, RearmRetrySaveOutcome } from './ultrafixDeferredContinuationStore.js';

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
     *
     * It is also conditional on the stored obligation still being the one
     * this holder last read or wrote (`raw` overrides that): a handed-off step
     * that failed for good before the handoff was acknowledged has replaced
     * it, and that newer evidence must survive the settlement.
     */
    clearRetry(expected?: { workEpoch?: number; raw?: ExpectedRearmRetry }): Promise<RearmRetryClearOutcome>;
    /**
     * Record the PR's retry obligation unless another trigger holds the claim
     * now; that holder owns the obligation. A claim lost to a renewal fault or
     * plain expiry has no new holder, so the obligation is still recorded.
     */
    saveRetry(retry: UltrafixRearmRetry): Promise<boolean>;
    /** Like `saveRetry`, but replaces only the obligation stored as `expectedRaw` (`null`: none). */
    replaceRetry(retry: UltrafixRearmRetry, expectedRaw: string | null): Promise<RearmRetrySaveOutcome>;
}

export const RESUME_CLAIM_LOST_REASON = 'resume_claim_lost';

/**
 * Recoveries allowed after step jobs fail for good with no completed step in
 * between. Each recovery schedules a fresh job under a new epoch (a fresh
 * attempt budget) without advancing the action counts the cycle breaker
 * reads, so a persistent failure would otherwise be retried indefinitely.
 */
export const MAX_FAILED_STEP_RECOVERIES = 2;

/** Step jobs that failed for good since the loop last completed a step. */
export function getConsecutiveFailedSteps(state: UltrafixLoopState): number {
    const streak = state.failedStepStreak;
    if (!streak) return 0;
    const { reviewCount, fixCount } = getActionCounts(state);
    // A completed step since the streak was recorded is progress: it resets it.
    return streak.completedSteps === reviewCount + fixCount ? streak.count : 0;
}

/** The state after one more step job failed for good. */
export function recordFailedStepInState(state: UltrafixLoopState): UltrafixLoopState {
    const { reviewCount, fixCount } = getActionCounts(state);
    return {
        ...state,
        failedStepStreak: { completedSteps: reviewCount + fixCount, count: getConsecutiveFailedSteps(state) + 1 },
    };
}

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

    // Same budget as the ordinary continuation (`determineNextAction`): after a
    // fix only the review count is capped, so the final permitted fix still
    // gets its verifying review; after a review, an exhausted fix budget ends
    // the loop because the next step would have been a fix.
    const { reviewCount, fixCount } = getActionCounts(state);
    const fixBudgetSpent = state.lastAction !== 'fix' && fixCount >= state.maxCycles;
    if (reviewCount >= state.maxCycles || fixBudgetSpent) {
        return {
            action: 'complete',
            completionStatus: 'failed',
            reason: `Max cycles reached: ${reviewCount} review and ${fixCount} fix steps completed (limit ${state.maxCycles})`,
        };
    }

    const failedSteps = getConsecutiveFailedSteps(state);
    if (failedSteps > MAX_FAILED_STEP_RECOVERIES) {
        return {
            action: 'complete',
            completionStatus: 'failed',
            reason: `Ultrafix steps failed ${failedSteps} times in a row without completing (recovery limit ${MAX_FAILED_STEP_RECOVERIES})`,
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
 *
 * With `honourRetryBackoff`, a loop named only by an obligation whose
 * `notBefore` has not passed is not a candidate yet, as for the sweep; this
 * keeps a periodic poller from re-running a loop held by its own in-flight
 * step on every cycle.
 */
export async function hasUltrafixResumeCandidate(
    redis: Redis,
    prId: UltrafixPrId,
    options: { honourRetryBackoff?: boolean } = {},
): Promise<boolean> {
    const { owner, repo, pr } = prId;
    if (await loadDeferredContinuation(redis, owner, repo, pr)) return true;
    const state = await loadState(redis, owner, repo, pr);
    if (!state || evaluateStrandedLoopRearm(state).action === 'skip') return false;
    const stateEpoch = typeof state.workEpoch === 'number' ? state.workEpoch : 0;
    if (stateEpoch !== await getUltrafixAutomaticWorkEpoch(redis, owner, repo, pr)) return true;
    const retry = await loadRearmRetry(redis, owner, repo, pr);
    if (!retry) return false;
    return !options.honourRetryBackoff || !retry.notBefore || Date.parse(retry.notBefore) <= Date.now();
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
    // The obligation as this holder last read or wrote it (read once the
    // claim is held). Anything else found when settling was recorded by
    // someone else meanwhile.
    let knownRetry: string | null = null;
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
        async clearRetry(expected = {}) {
            const outcome = await clearRearmRetryIfClaimHeld(
                redisClient, prId, { key: claimKey, token },
                { ...expected, raw: expected.raw === undefined ? knownRetry : expected.raw },
            );
            if (outcome === 'cleared') knownRetry = null;
            return outcome;
        },
        async saveRetry(retry) {
            const saved = await saveRearmRetryUnlessClaimTaken(redisClient, retry, { key: claimKey, token });
            if (saved === 'saved') knownRetry = JSON.stringify(retry);
            return saved === 'saved';
        },
        async replaceRetry(retry, expectedRaw) {
            const saved = await saveRearmRetryUnlessClaimTaken(redisClient, retry, { key: claimKey, token }, expectedRaw);
            if (saved === 'saved') knownRetry = JSON.stringify(retry);
            return saved;
        },
    };
    // Keep the claim alive across slow awaits (GitHub, queue scans) between confirmations.
    const renewal = setInterval(() => { void claim.confirm(); }, RESUME_CLAIM_RENEW_INTERVAL_MS);
    renewal.unref?.();
    try {
        knownRetry = await loadRearmRetryRaw(redisClient, prId.owner, prId.repo, prId.pr);
        return await operation(claim);
    } finally {
        clearInterval(renewal);
        await releaseResumeClaim(redisClient, prId, token).catch((err: Error) => {
            correlatedLogger.warn({ pr: prId.pr, error: err.message }, 'Ultrafix resume: failed to release resume claim');
        });
    }
}

/**
 * A retry obligation can outlive its loop (e.g. the loop finished or was
 * stopped meanwhile). A negative candidate check made without the claim may be
 * stale: another trigger may since have recorded an obligation for a loop that
 * is stranded again. So the obligation is dropped only under the claim, after
 * re-checking, and only if it is still exactly the one read under it.
 */
async function dropObsoleteRetry(prId: UltrafixPrId, redisClient: Redis, token: string): Promise<void> {
    const { owner, repo, pr } = prId;
    const raw = await loadRearmRetryRaw(redisClient, owner, repo, pr);
    if (!raw || await hasUltrafixResumeCandidate(redisClient, prId)) return;
    const claimKey = getUltrafixResumeClaimKey(owner, repo, pr);
    await clearRearmRetryIfClaimHeld(redisClient, prId, { key: claimKey, token }, { raw });
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
        const candidate = await hasUltrafixResumeCandidate(redisClient, prId);
        // Nothing to resume and no obligation that could be obsolete: no claim needed.
        if (!candidate && await loadRearmRetryRaw(redisClient, owner, repo, pr) === null) {
            return result ?? { continued: false, reason: 'no_deferred_continuation' };
        }
        const token = await acquireOrRequestRecheck(redisClient, prId);
        // The current holder will honour the recorded re-check request.
        if (!token) return result ?? { continued: false, reason: 'resume_in_progress' };
        let passResult: ContinuationResult;
        if (candidate) {
            passResult = await runWithHeldClaim(prId, token, { redisClient, correlatedLogger }, operation);
        } else {
            try {
                await dropObsoleteRetry(prId, redisClient, token);
            } finally {
                await releaseResumeClaim(redisClient, prId, token).catch((err: Error) => {
                    correlatedLogger.warn({ pr, error: err.message }, 'Ultrafix resume: failed to release resume claim');
                });
            }
            passResult = { continued: false, reason: 'no_deferred_continuation' };
        }
        // A pass that scheduled the next step is what this trigger achieved.
        if (!result?.continued) result = passResult;
        if (!await redisClient.getdel(getUltrafixResumeRecheckKey(owner, repo, pr))) return result;
        correlatedLogger.info({ pr, pass, reason: passResult.reason }, 'Ultrafix resume: trigger arrived meanwhile, re-evaluating');
    }
    // Still contended after the bounded passes: leave the request for the next holder.
    await redisClient.set(getUltrafixResumeRecheckKey(owner, repo, pr), '1', 'PX', RESUME_RECHECK_TTL_MS);
    return result!;
}
