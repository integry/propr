/**
 * Ultrafix Stranded Loop Re-arming
 *
 * Re-arms an active Ultrafix loop whose deferred continuation was cleared or
 * superseded, so a green check run cannot leave the loop stranded.
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { generateCorrelationId } from '@propr/core';
import {
    clearDeferredContinuationIfCurrent,
    clearUltrafixStateIfCurrent,
    getUltrafixAutomaticWorkEpoch,
    saveUltrafixStateIfCurrent,
} from './ultrafixAutomaticWorkEpoch.js';
import { getActionCounts, loadState } from './ultrafixOrchestrationService.js';
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

/** How long one resume trigger may hold the per-PR re-arm claim. */
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
 * re-arm the same loop twice. The TTL bounds the claim if its holder crashes.
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

/**
 * Hand a stranded loop to the current automatic-work epoch. The write is
 * conditional on that epoch, so a takeover racing this call still wins.
 */
export async function syncStateWorkEpoch(
    redis: Redis,
    state: UltrafixLoopState,
    workEpoch: number,
): Promise<UltrafixLoopState | null> {
    const synced = { ...state, workEpoch };
    const saved = await saveUltrafixStateIfCurrent(
        redis,
        { owner: state.owner, repo: state.repo, pr: state.pr },
        workEpoch,
        JSON.stringify(synced),
    );
    return saved ? synced : null;
}

/**
 * Re-arm an active loop whose deferred continuation was cleared or superseded.
 *
 * Every circuit breaker still applies: the loop must be active and labelled,
 * within its cycle budget, and short of its goal. A review is only scheduled
 * when the PR is idle (no Ultrafix job in flight, no pending batched comments)
 * and its head checks are green. A per-PR claim serializes concurrent triggers.
 */
export async function rearmStrandedUltrafixLoop(
    prId: UltrafixPrId,
    redisClient: Redis,
    correlatedLogger: Logger,
    checkRunDeps: CheckRunDeps,
): Promise<ContinuationResult> {
    const { owner, repo, pr } = prId;
    // Cheap Redis gate first: most check_run events are for PRs without a loop.
    if (evaluateStrandedLoopRearm(await loadState(redisClient, owner, repo, pr)).action === 'skip') {
        return { continued: false, reason: 'no_deferred_continuation' };
    }

    const token = randomUUID();
    if (!await acquireResumeClaim(redisClient, prId, token, RESUME_CLAIM_TTL_MS)) {
        return { continued: false, reason: 'rearm_in_progress' };
    }
    try {
        return await rearmClaimedLoop(prId, redisClient, correlatedLogger, checkRunDeps);
    } finally {
        await releaseResumeClaim(redisClient, prId, token).catch((err: Error) => {
            correlatedLogger.warn({ pr, error: err.message }, 'Ultrafix re-arm: failed to release resume claim');
        });
    }
}

async function rearmClaimedLoop(
    prId: UltrafixPrId,
    redisClient: Redis,
    correlatedLogger: Logger,
    checkRunDeps: CheckRunDeps,
): Promise<ContinuationResult> {
    const { owner, repo, pr } = prId;
    // Reload under the claim; another trigger may have changed it meanwhile.
    const state = await loadState(redisClient, owner, repo, pr);
    const decision = evaluateStrandedLoopRearm(state);
    if (!state || decision.action === 'skip') return { continued: false, reason: 'no_active_loop' };

    const currentEpoch = await getUltrafixAutomaticWorkEpoch(redisClient, owner, repo, pr);
    const identity = { owner, repo, pr };

    if (!await hasUltrafixLabel(owner, repo, pr, correlatedLogger)) {
        correlatedLogger.info({ pr }, 'Ultrafix re-arm: label removed, clearing stranded loop');
        if (!await clearUltrafixStateIfCurrent(redisClient, identity, currentEpoch)) {
            return { continued: false, reason: 'ultrafix_superseded' };
        }
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
        const owned = await syncStateWorkEpoch(redisClient, state, currentEpoch);
        if (!owned) return { continued: false, reason: 'ultrafix_superseded' };
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

    const owned = await syncStateWorkEpoch(redisClient, state, currentEpoch);
    if (!owned) return { continued: false, reason: 'ultrafix_superseded' };

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
