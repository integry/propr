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
export async function recordAction(redis: Redis, owner: string, repo: string, pr: number, action: UltrafixAction): Promise<UltrafixLoopState | null> {
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
