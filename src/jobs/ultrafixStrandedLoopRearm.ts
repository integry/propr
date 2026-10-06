/**
 * Ultrafix Stranded Loop Re-arming
 *
 * Re-arms an active Ultrafix loop whose deferred continuation was cleared or
 * superseded, so a green check run cannot leave the loop stranded.
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { generateCorrelationId, withUltrafixLabelTransition } from '@propr/core';
import {
    clearDeferredContinuationIfCurrent,
    clearUltrafixStateIfUnchanged,
    getUltrafixAutomaticWorkEpoch,
    replaceUltrafixStateIfUnchanged,
} from './ultrafixAutomaticWorkEpoch.js';
import { getActionCounts, getUltrafixStateKey, loadDeferredContinuation, loadState } from './ultrafixOrchestrationService.js';
import type { UltrafixAction, UltrafixLoopState } from './ultrafixOrchestrationService.js';
import {
    enqueueNextStep,
    evaluateReadiness,
    finishUltrafixLoop,
    hasUltrafixLabel,
} from './ultrafixLoopContinuationHelpers.js';
import type { CheckRunDeps, ContinuationResult, UltrafixContinuationParams } from './ultrafixLoopContinuation.js';

type UltrafixPrId = { owner: string; repo: string; pr: number };

const RESUME_CLAIM_KEY_PREFIX = 'ultrafix:resume-claim';
const RELEASE_RESUME_CLAIM_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

/** How long one resume trigger may hold the per-PR resume claim. */
const RESUME_CLAIM_TTL_MS = 60_000;

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
 */
export async function withResumeClaim(
    prId: UltrafixPrId,
    redisClient: Redis,
    correlatedLogger: Logger,
    operation: () => Promise<ContinuationResult>,
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
    try {
        return await operation();
    } finally {
        await releaseResumeClaim(redisClient, prId, token).catch((err: Error) => {
            correlatedLogger.warn({ pr: prId.pr, error: err.message }, 'Ultrafix resume: failed to release resume claim');
        });
    }
}

/** Bound on re-evaluations when the loop state changes underneath a re-arm. */
const MAX_REARM_ATTEMPTS = 3;

const STATE_CHANGED = Symbol('state_changed');

/**
 * Re-arm an active loop whose deferred continuation was cleared or superseded.
 * The caller must hold the resume claim (see `withResumeClaim`).
 *
 * Every circuit breaker still applies: the loop must be active and labelled,
 * within its cycle budget, and short of its goal. A review is only scheduled
 * when the PR is idle (no Ultrafix job in flight, no pending batched comments)
 * and its head checks are green. If the loop state changes while this is being
 * decided, the decision is discarded and recomputed from the new state.
 */
export async function rearmStrandedUltrafixLoop(
    prId: UltrafixPrId,
    redisClient: Redis,
    correlatedLogger: Logger,
    checkRunDeps: CheckRunDeps,
): Promise<ContinuationResult> {
    for (let attempt = 1; attempt <= MAX_REARM_ATTEMPTS; attempt++) {
        const result = await rearmFromSnapshot(prId, redisClient, correlatedLogger, checkRunDeps);
        if (result !== STATE_CHANGED) return result;
        correlatedLogger.info({ pr: prId.pr, attempt }, 'Ultrafix re-arm: loop state changed, re-evaluating');
    }
    return { continued: false, reason: 'ultrafix_superseded' };
}

async function rearmFromSnapshot(
    prId: UltrafixPrId,
    redisClient: Redis,
    correlatedLogger: Logger,
    checkRunDeps: CheckRunDeps,
): Promise<ContinuationResult | typeof STATE_CHANGED> {
    const { owner, repo, pr } = prId;
    // Every write below is conditional on this exact snapshot.
    const snapshot = await loadStateSnapshot(redisClient, owner, repo, pr);
    const decision = evaluateStrandedLoopRearm(snapshot?.state ?? null);
    if (!snapshot || decision.action === 'skip') return { continued: false, reason: 'no_active_loop' };
    const { state } = snapshot;

    const currentEpoch = await getUltrafixAutomaticWorkEpoch(redisClient, owner, repo, pr);
    const identity = { owner, repo, pr };
    // Startup reserves its epoch and commits its state under the label
    // transition lease, so taking ownership under it never lands in between.
    const takeOwnership = () => withUltrafixLabelTransition(
        redisClient,
        identity,
        () => syncStateWorkEpoch(redisClient, snapshot, currentEpoch),
    );

    if (!await hasUltrafixLabel(owner, repo, pr, correlatedLogger)) {
        correlatedLogger.info({ pr }, 'Ultrafix re-arm: label removed, clearing stranded loop');
        const cleared = await withUltrafixLabelTransition(
            redisClient,
            identity,
            () => clearUltrafixStateIfUnchanged(redisClient, identity, { workEpoch: currentEpoch, rawState: snapshot.raw }),
        );
        if (!cleared) return STATE_CHANGED;
        await clearDeferredContinuationIfCurrent(redisClient, identity, currentEpoch);
        return {
            continued: false, reason: 'label_removed', outcome: 'stopped',
            cycleCount: state.cycleCount, goal: state.goal, maxCycles: state.maxCycles,
        };
    }

    const params: UltrafixContinuationParams = {
        owner,
        repo,
        pullRequestNumber: pr,
        completedAction: state.lastAction ?? 'review',
        ultrafixMeta: {
            mode: 'ultrafix',
            goal: state.goal,
            maxCycles: state.maxCycles,
            pauseSeconds: state.pauseSeconds,
            reviewModel: state.reviewModel || undefined,
            instructions: '',
            workEpoch: currentEpoch,
        },
        redisClient,
        correlatedLogger,
        correlationId: generateCorrelationId(),
    };

    if (decision.action === 'complete') {
        // Take ownership first so terminal bookkeeping passes the epoch fence.
        const owned = await takeOwnership();
        if (!owned) return STATE_CHANGED;
        correlatedLogger.info(
            { pr, completionStatus: decision.completionStatus, reason: decision.reason },
            'Ultrafix re-arm: circuit breaker tripped, finishing loop',
        );
        const succeeded = decision.completionStatus === 'succeeded';
        return finishUltrafixLoop({
            params: { ...params, completedAction: succeeded ? 'review' : params.completedAction },
            state: owned,
            latestScore: owned.finalScore,
            reviewStatus: succeeded ? 'valid_clean' : 'invalid',
            isPartial: false,
            decisionReason: decision.reason,
        });
    }

    const readiness = await evaluateReadiness(params, 'review', checkRunDeps);
    correlatedLogger.info(
        { pr, ready: readiness.ready, reasons: readiness.reasons },
        'Ultrafix re-arm: readiness check for stranded loop',
    );
    if (!readiness.ready) {
        return { continued: false, reason: `rearm_not_ready: ${readiness.reasons.join(', ')}` };
    }

    const owned = await takeOwnership();
    if (!owned) return STATE_CHANGED;

    const enqueued = await enqueueNextStep(
        params,
        'review',
        (owned.pauseSeconds || 60) * 1000,
        getNextStepNumber(owned, 'review'),
    );
    if (!enqueued) return { continued: false, reason: 'rearm_duplicate' };

    correlatedLogger.info(
        { pr, workEpoch: currentEpoch, previousWorkEpoch: state.workEpoch },
        'Ultrafix re-arm: enqueued review for stranded loop',
    );
    return {
        continued: true,
        reason: 'stranded_loop_rearmed',
        nextAction: 'review',
        cycleCount: owned.cycleCount,
    };
}
