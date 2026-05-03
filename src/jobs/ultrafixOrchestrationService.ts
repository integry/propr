/**
 * Ultrafix Orchestration Service
 *
 * Manages persisted loop state for ultrafix cycles per PR in Redis.
 * Independent from webhook/controller code — reusable by comment intake,
 * job completion, and check-run hooks.
 */

import type { Redis } from 'ioredis';

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
    /** Last action taken */
    lastAction: UltrafixAction | null;
    /** ISO timestamp of last action */
    lastActionTimestamp: string | null;
    /** Whether the loop is currently active */
    active: boolean;
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
}

export interface UltrafixReadinessResult {
    ready: boolean;
    reasons: string[];
}

export interface UltrafixDeferredContinuation {
    owner: string;
    repo: string;
    pr: number;
    nextAction: UltrafixAction;
    savedAt: string;
    reason: string;
    /** UltrafixMeta to pass to the next job when resuming */
    ultrafixMeta?: import('@propr/core').UltrafixCommandMeta;
}

// --- Constants ---

const KEY_PREFIX = 'ultrafix:state';
const DEFERRED_KEY_PREFIX = 'ultrafix:deferred';
const DEFAULT_GOAL = 7;
const DEFAULT_MAX_CYCLES = 5;
const DEFAULT_PAUSE_SECONDS = 60;

// --- Key helper ---

export function getUltrafixStateKey(owner: string, repo: string, pr: number): string {
    return `${KEY_PREFIX}:${owner}:${repo}:${pr}`;
}

export function getUltrafixDeferredKey(owner: string, repo: string, pr: number): string {
    return `${DEFERRED_KEY_PREFIX}:${owner}:${repo}:${pr}`;
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
        lastAction: null,
        lastActionTimestamp: null,
        active: true,
    };
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
 * Determine whether the loop should continue and what action to take next.
 */
export function determineNextAction(state: UltrafixLoopState, currentScore: number | null): NextActionDecision {
    if (!state.active) {
        return { action: null, reason: 'Loop is inactive' };
    }

    // Check if goal is met
    if (currentScore !== null && currentScore >= state.goal) {
        return { action: null, reason: `Goal met: score ${currentScore} >= ${state.goal}` };
    }

    // Check if max cycles reached
    if (state.cycleCount >= state.maxCycles) {
        return { action: null, reason: `Max cycles reached: ${state.cycleCount} >= ${state.maxCycles}` };
    }

    // Determine next action based on last action
    if (state.lastAction === null) {
        return { action: 'review', reason: 'No previous action, starting with review' };
    }

    if (state.lastAction === 'review') {
        return { action: 'fix', reason: 'Last action was review, next is fix' };
    }

    // lastAction === 'fix'
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
    await saveState(redis, state);
    return { state, initialAction };
}

/**
 * Record that an action was completed and advance the cycle count if appropriate.
 */
export async function recordAction(redis: Redis, params: { owner: string; repo: string; pr: number; action: UltrafixAction }): Promise<UltrafixLoopState | null> {
    const { owner, repo, pr, action } = params;
    const state = await loadState(redis, owner, repo, pr);
    if (!state) return null;

    state.lastAction = action;
    state.lastActionTimestamp = new Date().toISOString();

    // Increment cycle count after a fix (one cycle = review + fix)
    if (action === 'fix') {
        state.cycleCount += 1;
    }

    await saveState(redis, state);
    return state;
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

// --- Readiness helpers (side-effect free, testable independently) ---

/**
 * Check whether the configured cooldown has elapsed since the last action.
 */
export function isCooldownElapsed(state: UltrafixLoopState, nowMs?: number): boolean {
    if (!state.lastActionTimestamp) return true;
    const elapsed = (nowMs ?? Date.now()) - new Date(state.lastActionTimestamp).getTime();
    return elapsed >= state.pauseSeconds * 1000;
}

/**
 * Check whether there are follow-up jobs (waiting, active, or delayed)
 * for the same PR in the issue queue.
 *
 * Only considers jobs with `ultrafixMeta` (i.e. ultrafix implementation
 * follow-up work), not arbitrary PR jobs. This avoids false positives from
 * unrelated issue-queue work on the same PR.
 *
 * `getQueueJobs` is injected so this function stays side-effect free in tests.
 */
export async function hasFollowUpJobsForPR(
    owner: string,
    repo: string,
    pr: number,
    getQueueJobs: () => Promise<Array<{ data: { repoOwner?: string; repoName?: string; pullRequestNumber?: number; ultrafixMeta?: unknown } }>>,
): Promise<boolean> {
    const jobs = await getQueueJobs();
    return jobs.some(j =>
        j.data.repoOwner === owner &&
        j.data.repoName === repo &&
        j.data.pullRequestNumber === pr &&
        j.data.ultrafixMeta != null,
    );
}

/**
 * Check whether there are pending batched PR comments in Redis
 * that haven't been consumed yet.
 */
export async function hasPendingBatchedComments(
    redis: Redis,
    pendingCommentsKey: string,
): Promise<boolean> {
    const len = await redis.llen(pendingCommentsKey);
    return len > 0;
}

/**
 * Aggregate readiness check. Returns { ready, reasons } where reasons
 * lists every blocking condition that is currently true.
 *
 * Note: cooldown is NOT checked here — it is enforced via the enqueue delay
 * in `enqueueNextStep()`. Including it as a readiness gate would cause
 * double-application of the pause (once as a defer, then again as a delay).
 *
 * Side-effect free: callers supply the external check results.
 */
export function checkReadiness(opts: {
    allChecksPassing: boolean;
    hasFollowUpJobs: boolean;
    hasPendingComments: boolean;
}): UltrafixReadinessResult {
    const reasons: string[] = [];

    if (!opts.allChecksPassing) {
        reasons.push('checks_not_passing');
    }
    if (opts.hasFollowUpJobs) {
        reasons.push('follow_up_jobs_active');
    }
    if (opts.hasPendingComments) {
        reasons.push('pending_comments_exist');
    }

    return { ready: reasons.length === 0, reasons };
}

// --- Deferred continuation persistence ---

export async function saveDeferredContinuation(
    redis: Redis,
    deferred: UltrafixDeferredContinuation,
): Promise<void> {
    const key = getUltrafixDeferredKey(deferred.owner, deferred.repo, deferred.pr);
    await redis.set(key, JSON.stringify(deferred));
}

export async function loadDeferredContinuation(
    redis: Redis,
    owner: string,
    repo: string,
    pr: number,
): Promise<UltrafixDeferredContinuation | null> {
    const key = getUltrafixDeferredKey(owner, repo, pr);
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as UltrafixDeferredContinuation;
}

export async function claimDeferredContinuation(
    redis: Redis,
    owner: string,
    repo: string,
    pr: number,
): Promise<UltrafixDeferredContinuation | null> {
    const key = getUltrafixDeferredKey(owner, repo, pr);
    const raw = await redis.getdel(key);
    if (!raw) return null;
    return JSON.parse(raw) as UltrafixDeferredContinuation;
}

export async function clearDeferredContinuation(
    redis: Redis,
    owner: string,
    repo: string,
    pr: number,
): Promise<void> {
    const key = getUltrafixDeferredKey(owner, repo, pr);
    await redis.del(key);
}

/**
 * List all deferred continuation keys currently in Redis.
 * Uses SCAN to avoid blocking on large keyspaces.
 */
export async function listDeferredContinuationKeys(redis: Redis): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
        const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', `${DEFERRED_KEY_PREFIX}:*`, 'COUNT', '100');
        cursor = nextCursor;
        keys.push(...batch);
    } while (cursor !== '0');
    return keys;
}

/**
 * Parse owner/repo/pr from a deferred continuation Redis key.
 */
export function parseDeferredKey(key: string): { owner: string; repo: string; pr: number } | null {
    const prefix = `${DEFERRED_KEY_PREFIX}:`;
    if (!key.startsWith(prefix)) return null;
    const parts = key.slice(prefix.length).split(':');
    if (parts.length < 3) return null;
    const pr = parseInt(parts[parts.length - 1], 10);
    if (isNaN(pr)) return null;
    // GitHub owner/repo cannot contain colons, so simple split is sufficient
    return { owner: parts[0], repo: parts[1], pr };
}
