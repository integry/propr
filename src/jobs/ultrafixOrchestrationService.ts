/**
 * Ultrafix Orchestration Service
 *
 * Manages persisted loop state for ultrafix cycles per PR in Redis.
 * Independent from webhook/controller code — reusable by comment intake,
 * job completion, and check-run hooks.
 */

import type { Redis } from 'ioredis';
import type { UltrafixEscalationState } from './ultrafixEscalationPolicy.js';
import type { ReviewOutputStatus } from './reviewCommentGatherer.js';
import { saveUltrafixStateIfCurrent } from './ultrafixAutomaticWorkEpoch.js';
export {
    clearDeferredContinuationIfCurrent,
    clearUltrafixStateIfCurrent,
    getUltrafixAutomaticWorkEpoch,
    getUltrafixAutomaticWorkEpochKey,
    getUltrafixDeferredKey,
    hasUltrafixAutomaticWork,
    invalidateUltrafixAutomaticWork,
    invalidateUltrafixAutomaticWorkForComment,
    isUltrafixAutomaticWorkCurrent,
    saveUltrafixStateIfCurrent,
} from './ultrafixAutomaticWorkEpoch.js';
export {
    claimDeferredContinuation,
    claimDeferredContinuationIfUnchanged,
    clearDeferredContinuation,
    clearRearmRetryIfClaimHeld,
    getUltrafixRearmRetryKey,
    listDeferredContinuationKeys,
    listRearmRetryKeys,
    loadDeferredContinuation,
    loadDeferredContinuationSnapshot,
    loadRearmRetry,
    loadRearmRetryRaw,
    parseDeferredKey,
    parseRearmRetryKey,
    saveDeferredContinuation,
    saveRearmRetry,
    saveRearmRetryIfAbsent,
    saveRearmRetryUnlessClaimTaken,
} from './ultrafixDeferredContinuationStore.js';
export type { UltrafixClaimedStep, UltrafixDeferredContinuation, UltrafixRearmRetry } from './ultrafixDeferredContinuationStore.js';
export {
    areChecksReadyForUltrafix,
    checkReadiness,
    hasFollowUpJobsForPR,
    hasPendingBatchedComments,
    isCooldownElapsed,
} from './ultrafixReadinessPolicy.js';

// --- Interfaces ---

export type UltrafixAction = 'review' | 'fix';

export interface UltrafixLoopState {
    /** Repository owner */
    owner: string;
    /** Repository name */
    repo: string;
    /** Pull request number */
    pr: number;
    /** Target review score (1–10) */
    goal: number;
    /** Maximum allowed cycles before stopping */
    maxCycles: number;
    /** Seconds to pause between actions */
    pauseSeconds: number;
    /** Model to use for reviews (empty string = default) */
    reviewModel: string;
    /** Current cycle number (starts at 0, incremented after each fix) */
    cycleCount: number;
    /** Number of completed review steps in this loop */
    reviewCount: number;
    /** Number of completed fix steps in this loop */
    fixCount: number;
    /** Last action taken */
    lastAction: UltrafixAction | null;
    /** ISO timestamp of last action */
    lastActionTimestamp: string | null;
    /** Whether the loop is currently active */
    active: boolean;
    /** Automatic-work epoch that owns this loop state. */
    workEpoch: number;
    /** GitHub comment ID of the `/ultrafix` command that started this loop. */
    sourceCommentId?: number;
    /** Lines written beneath `/ultrafix`; applied to every review and fix cycle. */
    instructions?: string;
    /** GitHub user who started the loop, for attribution of its later steps. */
    userId?: string;
    /** Terminal result once the loop has stopped. */
    completionStatus: 'succeeded' | 'failed' | null;
    /** Why the loop stopped. */
    completionReason: string | null;
    /** Final review score observed when the loop stopped. */
    finalScore: number | null;
    /** ISO timestamp when the loop reached a terminal state. */
    completedAt: string | null;
    /** Original PR/issue objective captured once and reused unchanged. */
    originalScope?: string;
    /** Whether originalScope has been captured, including when it was empty. */
    originalScopeCaptured?: boolean;
    /** Per-review actionable finding lifecycle, keyed by comment ID and F# ID. */
    findingLifecycle?: Record<string, UltrafixFindingLifecycle>;
    escalation?: UltrafixEscalationState;
    escalationBestScore?: number;
}

export interface UltrafixFindingLifecycle {
    id: string;
    sourceCommentId: number;
    title: string;
    status: 'open' | 'selected' | 'addressed' | 'resolved';
    firstSeenCycle: number;
    lastSeenCycle: number;
}

export interface NextActionDecision {
    /** The next action to take, or null if the loop should stop */
    action: UltrafixAction | null;
    /** Reason for the decision */
    reason: string;
}

export interface StartLoopOptions {
    owner: string;
    repo: string;
    pr: number;
    goal?: number;
    maxCycles?: number;
    pauseSeconds?: number;
    reviewModel?: string;
    workEpoch?: number;
    /** GitHub comment ID of the `/ultrafix` command starting this loop. */
    sourceCommentId?: number;
    /** Lines written beneath `/ultrafix`, kept so a recovered loop still applies them. */
    instructions?: string;
    /** GitHub user who started the loop. */
    userId?: string;
}

export interface UltrafixReadinessResult {
    ready: boolean;
    reasons: string[];
    /** Exact-head CI observation when blocking checks held the next step back. */
    ci?: UltrafixCiObservation;
}

export interface UltrafixCheckStatus {
    count: number;
    allPassing: boolean;
    anyPending: boolean;
    anyFailed: boolean;
    /** Blocking checks that failed / are still queued or running; nonBlockingChecks are never listed. */
    blockingFailed?: string[];
    blockingPending?: string[];
}

export type UltrafixCiObservation = { headSha: string; status: UltrafixCheckStatus };

// --- Constants ---

const KEY_PREFIX = 'ultrafix:state';
const DEFAULT_GOAL = 7;
const DEFAULT_MAX_CYCLES = 5;
const DEFAULT_PAUSE_SECONDS = 60;

// --- Key helper ---

export function getUltrafixStateKey(owner: string, repo: string, pr: number): string {
    return `${KEY_PREFIX}:${owner}:${repo}:${pr}`;
}

// --- State defaults ---

export function createDefaultState(options: StartLoopOptions): UltrafixLoopState {
    return {
        owner: options.owner,
        repo: options.repo,
        pr: options.pr,
        goal: options.goal ?? DEFAULT_GOAL,
        maxCycles: options.maxCycles ?? DEFAULT_MAX_CYCLES,
        pauseSeconds: options.pauseSeconds ?? DEFAULT_PAUSE_SECONDS,
        reviewModel: options.reviewModel ?? '',
        cycleCount: 0,
        reviewCount: 0,
        fixCount: 0,
        lastAction: null,
        lastActionTimestamp: null,
        active: true,
        workEpoch: options.workEpoch ?? 0, ...(options.sourceCommentId !== undefined ? { sourceCommentId: options.sourceCommentId } : {}),
        ...(options.instructions ? { instructions: options.instructions } : {}),
        ...(options.userId ? { userId: options.userId } : {}),
        completionStatus: null,
        completionReason: null,
        finalScore: null,
        completedAt: null,
        originalScopeCaptured: false,
        findingLifecycle: {},
    };
}

export function getActionCounts(state: UltrafixLoopState): { reviewCount: number; fixCount: number } {
    if (typeof state.reviewCount === 'number' && typeof state.fixCount === 'number') {
        return { reviewCount: state.reviewCount, fixCount: state.fixCount };
    }

    // Backward compatibility for state created before explicit per-action counts.
    if (state.lastAction === 'review') {
        return { reviewCount: state.cycleCount + 1, fixCount: state.cycleCount };
    }

    if (state.lastAction === 'fix') {
        return { reviewCount: state.cycleCount, fixCount: state.cycleCount };
    }

    return { reviewCount: 0, fixCount: 0 };
}

// --- Decision logic ---

/**
 * Determine the initial action for an ultrafix loop.
 * If there are unprocessed reviews pending, the first action should be "fix".
 * Otherwise, start with "review".
 */
export function determineInitialAction(hasPendingReviews: boolean): UltrafixAction {
    return hasPendingReviews ? 'fix' : 'review';
}

/**
 * A review only reaches the requested Ultrafix goal when it is both clean and
 * has complete diff coverage and an explicit score at or above the configured
 * target.
 */
export function hasReviewReachedGoal(
    reviewStatus: ReviewOutputStatus,
    currentScore: number | null,
    goal: number,
    isPartial: boolean = false,
): boolean {
    return !isPartial && reviewStatus === 'valid_clean' && currentScore !== null && currentScore >= goal;
}

/**
 * Determine whether the loop should continue and what action to take next.
 */
export function determineNextAction(
    state: UltrafixLoopState,
    currentScore: number | null,
    reviewStatus: ReviewOutputStatus = 'invalid',
    isPartial: boolean = false,
): NextActionDecision {
    const { reviewCount, fixCount } = getActionCounts(state);

    if (!state.active) {
        return { action: null, reason: 'Loop is inactive' };
    }

    // Determine next action based on last action
    if (state.lastAction === null) {
        return { action: 'review', reason: 'No previous action, starting with review' };
    }

    if (state.lastAction === 'review') {
        if (reviewStatus === 'valid_clean') {
            if (isPartial) {
                return {
                    action: null,
                    reason: 'Review reports no actionable findings but had partial diff coverage; stopping for manual review',
                };
            }
            if (hasReviewReachedGoal(reviewStatus, currentScore, state.goal, isPartial)) {
                return {
                    action: null,
                    reason: `Valid review reports no actionable findings and score ${currentScore}/10 reaches goal ${state.goal}/10`,
                };
            }
            const scoreDetail = currentScore === null
                ? 'no score was reported'
                : `score ${currentScore}/10 is below goal ${state.goal}/10`;
            return {
                action: null,
                reason: `Valid review reports no actionable findings, but ${scoreDetail}; stopping for manual review`,
            };
        }
        if (reviewStatus === 'invalid') {
            if (reviewCount >= state.maxCycles) {
                return { action: null, reason: `Invalid review output and max review attempts reached (${state.maxCycles})` };
            }
            return { action: 'review', reason: 'Review output is invalid, retrying review' };
        }
        if (fixCount >= state.maxCycles) {
            return { action: null, reason: `Max cycles reached: ${fixCount} ${fixCount === 1 ? 'fix step has' : 'fix steps have'} completed (limit ${state.maxCycles})` };
        }
        return { action: 'fix', reason: 'Actionable review findings remain, next is fix' };
    }

    // lastAction === 'fix'
    if (reviewCount >= state.maxCycles) {
        return { action: null, reason: `Max cycles reached: ${reviewCount} ${reviewCount === 1 ? 'review step has' : 'review steps have'} completed (limit ${state.maxCycles})` };
    }
    return { action: 'review', reason: 'Last action was fix, next is review' };
}

// --- Redis persistence ---

export async function saveState(redis: Redis, state: UltrafixLoopState): Promise<void> {
    const key = getUltrafixStateKey(state.owner, state.repo, state.pr);
    await redis.set(key, JSON.stringify(state));
}

export async function loadState(redis: Redis, owner: string, repo: string, pr: number): Promise<UltrafixLoopState | null> {
    const key = getUltrafixStateKey(owner, repo, pr);
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as UltrafixLoopState;
}

export async function clearState(redis: Redis, owner: string, repo: string, pr: number): Promise<void> {
    const key = getUltrafixStateKey(owner, repo, pr);
    await redis.del(key);
}

async function loadOwnedState(
    redis: Redis,
    identity: { owner: string; repo: string; pr: number },
    workEpoch?: number,
): Promise<UltrafixLoopState | null> {
    const state = await loadState(redis, identity.owner, identity.repo, identity.pr);
    if (!state) return null;
    // State persisted before epoch fencing belongs to the original epoch.
    state.workEpoch = typeof state.workEpoch === 'number' ? state.workEpoch : 0;
    if (workEpoch !== undefined && state.workEpoch !== workEpoch) return null;
    return state;
}

async function saveOwnedState(redis: Redis, state: UltrafixLoopState, workEpoch?: number): Promise<boolean> {
    if (workEpoch === undefined) {
        await saveState(redis, state);
        return true;
    }
    if (state.workEpoch !== workEpoch) return false;
    return saveUltrafixStateIfCurrent(
        redis,
        { owner: state.owner, repo: state.repo, pr: state.pr },
        workEpoch,
        JSON.stringify(state),
    );
}

// --- High-level helpers ---

/**
 * Start a new ultrafix loop. Writes initial state to Redis.
 * Returns the created state.
 */
export async function startLoop(redis: Redis, options: StartLoopOptions, hasPendingReviews: boolean): Promise<{ state: UltrafixLoopState; initialAction: UltrafixAction }> {
    const state = createDefaultState(options);
    const initialAction = determineInitialAction(hasPendingReviews);
    state.lastAction = initialAction;
    state.lastActionTimestamp = new Date().toISOString();
    const saved = await saveOwnedState(redis, state, options.workEpoch);
    if (!saved) throw new Error('Ultrafix startup was superseded before state commit');
    return { state, initialAction };
}

/**
 * Record that an action was completed and advance the cycle count if appropriate.
 */
export async function recordAction(redis: Redis, params: { owner: string; repo: string; pr: number; action: UltrafixAction; workEpoch?: number }): Promise<UltrafixLoopState | null> {
    const { owner, repo, pr, action, workEpoch } = params;
    const state = await loadOwnedState(redis, { owner, repo, pr }, workEpoch);
    if (!state) return null;

    const { reviewCount, fixCount } = getActionCounts(state);
    state.lastAction = action;
    state.lastActionTimestamp = new Date().toISOString();

    state.reviewCount = reviewCount + (action === 'review' ? 1 : 0);
    state.fixCount = fixCount + (action === 'fix' ? 1 : 0);
    state.cycleCount = Math.min(state.reviewCount, state.fixCount);

    if (action === 'fix' && state.findingLifecycle) {
        for (const finding of Object.values(state.findingLifecycle)) {
            if (finding.status === 'selected') finding.status = 'addressed';
        }
    }

    return await saveOwnedState(redis, state, workEpoch) ? state : null;
}

/** Capture the original objective once; later cycles always receive this value. */
export async function retainOriginalScope(
    redis: Redis,
    params: { owner: string; repo: string; pr: number; scope: string; workEpoch?: number },
): Promise<string> {
    const state = await loadOwnedState(redis, params, params.workEpoch);
    if (!state) return params.scope;

    if (state.originalScopeCaptured === true) return state.originalScope ?? '';
    // Preserve populated legacy state; an empty legacy placeholder was not captured.
    state.originalScope ||= params.scope;
    const saved = await saveOwnedState(redis, { ...state, originalScopeCaptured: true }, params.workEpoch);
    if (!saved) return params.scope;
    return state.originalScope ?? '';
}

/** Record the blockers emitted by a review and resolve addressed predecessors. */
export async function recordReviewFindings(
    redis: Redis,
    params: {
        owner: string;
        repo: string;
        pr: number;
        findings: Array<{ id: string; sourceCommentId: number; title: string }>;
        workEpoch?: number;
    },
): Promise<UltrafixLoopState | null> {
    const state = await loadOwnedState(redis, params, params.workEpoch);
    if (!state) return null;
    const lifecycle = state.findingLifecycle ?? {};
    for (const finding of Object.values(lifecycle)) {
        if (finding.status === 'addressed') finding.status = 'resolved';
    }
    for (const finding of params.findings) {
        const key = `${finding.sourceCommentId}:${finding.id.toUpperCase()}`;
        lifecycle[key] = lifecycle[key] ?? {
            id: finding.id.toUpperCase(),
            sourceCommentId: finding.sourceCommentId,
            title: finding.title,
            status: 'open',
            firstSeenCycle: state.cycleCount,
            lastSeenCycle: state.cycleCount,
        };
        lifecycle[key].title = finding.title;
        lifecycle[key].status = 'open';
        lifecycle[key].lastSeenCycle = state.cycleCount;
    }
    state.findingLifecycle = lifecycle;
    return await saveOwnedState(redis, state, params.workEpoch) ? state : null;
}

/** Mark exactly the finding records selected for the next automatic fix. */
export async function markFindingsSelected(
    redis: Redis,
    params: { owner: string; repo: string; pr: number; findings: Array<{ id: string; sourceCommentId: number; title: string }>; workEpoch?: number },
): Promise<UltrafixLoopState | null> {
    const state = await loadOwnedState(redis, params, params.workEpoch);
    if (!state) return null;
    const lifecycle = state.findingLifecycle ?? {};
    for (const selected of params.findings) {
        const key = `${selected.sourceCommentId}:${selected.id.toUpperCase()}`;
        lifecycle[key] = lifecycle[key] ?? {
            id: selected.id.toUpperCase(),
            sourceCommentId: selected.sourceCommentId,
            title: selected.title,
            status: 'open',
            firstSeenCycle: state.cycleCount,
            lastSeenCycle: state.cycleCount,
        };
        lifecycle[key].status = 'selected';
        lifecycle[key].lastSeenCycle = state.cycleCount;
    }
    state.findingLifecycle = lifecycle;
    return await saveOwnedState(redis, state, params.workEpoch) ? state : null;
}

/**
 * Stop a loop by marking it inactive.
 */
export async function stopLoop(redis: Redis, owner: string, repo: string, pr: number): Promise<UltrafixLoopState | null> {
    const state = await loadState(redis, owner, repo, pr);
    if (!state) return null;

    state.active = false;
    await saveState(redis, state);
    return state;
}

export async function completeLoop(
    redis: Redis,
    params: {
        owner: string;
        repo: string;
        pr: number;
        completionStatus: 'succeeded' | 'failed';
        completionReason: string;
        finalScore: number | null;
        workEpoch?: number;
    },
): Promise<UltrafixLoopState | null> {
    const state = await loadOwnedState(redis, params, params.workEpoch);
    if (!state) return null;

    state.active = false;
    state.completionStatus = params.completionStatus;
    state.completionReason = params.completionReason;
    state.finalScore = params.finalScore;
    state.completedAt = new Date().toISOString();

    return await saveOwnedState(redis, state, params.workEpoch) ? state : null;
}
