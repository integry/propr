/**
 * Ultrafix Disk Pressure Wait
 *
 * A worker refuses a step at admission when the disk that holds its working
 * copies is nearly full (`WorktreeDiskPressureError`). Nothing ran and nothing
 * changed, and the host frees space by itself (an hourly cleanup), so for
 * Ultrafix this is a wait, not a failed step: the same step is retried on a
 * backoff schedule, the refusal does not count toward the failed-step
 * breaker, and the loop stops only once space has not returned within about
 * an hour. State transitions and notice texts; the atomic Redis writes and
 * GitHub comments live with their callers.
 *
 * A loop stopped this way ends between reviews, so the loop state also keeps
 * its latest review score for the stop notice.
 */

import type { Redis } from 'ioredis';
import { replaceUltrafixStateIfUnchanged, saveUltrafixStateIfCurrent } from './ultrafixAutomaticWorkEpoch.js';
import { getActionCounts, getUltrafixStateKey, loadState } from './ultrafixOrchestrationService.js';
import type { UltrafixAction, UltrafixLoopState } from './ultrafixOrchestrationService.js';

/** Loop-state fields that keep the stop notice of a loop ending between reviews truthful. */
export interface UltrafixLoopWaitFields {
    /** Score of the loop's latest scored review. */
    lastScore?: number | null;
    /** Admission refusals of the loop's next step for disk pressure. */
    diskPressureWait?: UltrafixDiskPressureWait;
}

export interface UltrafixDiskPressureWait {
    /** Completed steps when the refusals began; a step completed since ends the wait. */
    completedSteps: number;
    /** The refused step, retried as is. */
    action: UltrafixAction;
    refusals: number;
    /** ISO time of the first refusal. */
    since: string;
    /** ISO time before which the loop is not re-armed. */
    retryAt: string;
    /** Space did not return within the retry schedule: the loop stops. */
    exhausted?: boolean;
    /** The waiting notice was published on the pull request; until then each refusal tries again. */
    noticePosted?: boolean;
}

const MINUTE_MS = 60_000;

/** Wait before each retry of a refused step: 2, 5, 10, 20 and 20 minutes, 57 minutes in total. */
export const ULTRAFIX_DISK_PRESSURE_RETRY_DELAYS_MS: readonly number[] = [2, 5, 10, 20, 20].map(minutes => minutes * MINUTE_MS);

/** Completion reason of a loop stopped because space did not return in time. */
export const ULTRAFIX_DISK_PRESSURE_REASON = 'The worker had no free disk space';

/** Retry obligation reason while a refused step waits for its next attempt. */
export const DISK_PRESSURE_RETRY_REASON = 'disk_pressure_wait';

/** Re-arm outcome while the loop waits for disk space. */
export const DISK_PRESSURE_WAIT_REASON = 'disk_pressure_wait';

function completedStepsOf(state: UltrafixLoopState): number {
    const { reviewCount, fixCount } = getActionCounts(state);
    return reviewCount + fixCount;
}

/** The loop's current wait for disk space; a step completed since it began ends it. */
export function getDiskPressureWait(state: UltrafixLoopState): UltrafixDiskPressureWait | null {
    const wait = state.diskPressureWait;
    return wait && wait.completedSteps === completedStepsOf(state) ? wait : null;
}

/** The state after one more refusal of `action` for disk pressure at `now`. */
export function recordDiskPressureRefusalInState(
    state: UltrafixLoopState,
    action: UltrafixAction,
    now = Date.now(),
): UltrafixLoopState {
    const previous = getDiskPressureWait(state);
    const refusals = (previous?.refusals ?? 0) + 1;
    const delayMs = ULTRAFIX_DISK_PRESSURE_RETRY_DELAYS_MS[refusals - 1];
    const wait: UltrafixDiskPressureWait = {
        completedSteps: completedStepsOf(state),
        action,
        refusals,
        since: previous?.since ?? new Date(now).toISOString(),
        retryAt: new Date(now + (delayMs ?? 0)).toISOString(),
        ...(delayMs === undefined ? { exhausted: true } : {}),
        ...(previous?.noticePosted ? { noticePosted: true } : {}),
    };
    return { ...state, diskPressureWait: wait };
}

/** Whether the waiting notice still has to be published for this wait. */
export function needsDiskPressureWaitNotice(wait: UltrafixDiskPressureWait): boolean {
    return !wait.noticePosted && !wait.exhausted;
}

/** Bound on re-reads when the loop state changes underneath the notice marker. */
const MAX_NOTICE_MARK_ATTEMPTS = 3;

/**
 * Record that the waiting notice of `wait` was published, so later refusals of
 * the same wait stay quiet. Written only while the step's epoch is current and
 * the loop is still in that same wait (same refused step, same start, no step
 * completed since), against the exact state it read. Returns whether the
 * marker is stored.
 */
export async function markDiskPressureNoticePosted(
    redis: Redis,
    identity: { owner: string; repo: string; pr: number },
    workEpoch: number,
    wait: UltrafixDiskPressureWait,
): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_NOTICE_MARK_ATTEMPTS; attempt++) {
        const raw = await redis.get(getUltrafixStateKey(identity.owner, identity.repo, identity.pr));
        if (!raw) return false;
        const state = JSON.parse(raw) as UltrafixLoopState;
        if (!state.active || (state.workEpoch ?? 0) !== workEpoch) return false;
        const current = getDiskPressureWait(state);
        if (!current || current.since !== wait.since || current.action !== wait.action
            || current.completedSteps !== wait.completedSteps) return false;
        if (current.noticePosted) return true;
        const next: UltrafixLoopState = { ...state, diskPressureWait: { ...current, noticePosted: true } };
        if (await replaceUltrafixStateIfUnchanged(redis, identity, { workEpoch, rawState: raw }, JSON.stringify(next))) return true;
    }
    return false;
}

/** How long the re-arm must still hold the loop for disk space (0: retry or stop now). */
export function diskPressureRetryDelayMs(state: UltrafixLoopState, now = Date.now()): number {
    const wait = getDiskPressureWait(state);
    if (!wait || wait.exhausted) return 0;
    return Math.max(0, Date.parse(wait.retryAt) - now);
}

function commandName(action: UltrafixAction): string {
    return action === 'review' ? '`/review`' : '`/fix`';
}

function formatMinutes(ms: number): string {
    const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** The single notice posted when a step is first refused for disk pressure. */
export function buildDiskPressureWaitNotice(action: UltrafixAction): string {
    const schedule = ULTRAFIX_DISK_PRESSURE_RETRY_DELAYS_MS.map(ms => ms / MINUTE_MS).join(', ');
    const total = ULTRAFIX_DISK_PRESSURE_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    return [
        '⏳ **Ultrafix is waiting for free disk space on the worker.**',
        '',
        `The ProPR worker could not start the next ${commandName(action)} because the disk that holds its working copies is nearly full. `
            + 'Nothing was changed on this pull request.',
        '',
        `Ultrafix retries the same step automatically (after ${schedule} minutes). `
            + `If space has not been freed within about ${formatMinutes(total)}, the loop stops and says so here.`,
    ].join('\n');
}

/** Plain-words stop explanation for a loop that waited for disk space in vain. */
export function explainDiskPressureStop(state: UltrafixLoopState, now = Date.now()): string {
    const wait = getDiskPressureWait(state) ?? state.diskPressureWait;
    const action = wait?.action ?? 'review';
    const waited = wait ? ` for ${formatMinutes(now - Date.parse(wait.since))}` : '';
    const refusals = wait ? `, refused ${wait.refusals} times` : '';
    return `${ULTRAFIX_DISK_PRESSURE_REASON} for its working copies: the next ${commandName(action)} could not start${waited}${refusals}. `
        + `The loop stopped at cycle ${state.cycleCount} of ${state.maxCycles}; nothing was changed on this pull request by the refused step. `
        + 'Free space on the worker host, then restart the loop with `/ultrafix`.';
}

/**
 * Keep a review's score on the loop state, so a stop notice posted before the
 * next review (e.g. after waiting for disk space) names the real last score.
 * Re-reads the state so the finding lifecycle the review just recorded is kept;
 * the write is fenced by the step's epoch.
 */
export async function recordLatestReviewScore(
    redis: Redis,
    identity: { owner: string; repo: string; pr: number },
    workEpoch: number,
    score: number | null,
): Promise<void> {
    if (score === null) return;
    const current = await loadState(redis, identity.owner, identity.repo, identity.pr);
    if (!current?.active || (current.workEpoch ?? 0) !== workEpoch || current.lastScore === score) return;
    await saveUltrafixStateIfCurrent(redis, identity, workEpoch, JSON.stringify({ ...current, lastScore: score }));
}
