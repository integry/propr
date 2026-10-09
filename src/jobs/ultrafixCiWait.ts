/**
 * Ultrafix CI wait
 *
 * Makes a review that is deferred for CI visible on the PR (one comment per
 * deferral, not per poll) and bounds the wait: once blocking checks have held
 * the loop back for longer than the configured timeout, the loop stops with
 * "CI did not settle" instead of staying silently deferred forever. The
 * waiting comment is edited in place with the wait's outcome: the stop
 * comment on a timeout, or the review's own comment once checks settle.
 */

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import {
    DEFAULT_ULTRAFIX_CI_WAIT_TIMEOUT_MS,
    loadUltrafixCiWaitTimeoutMs,
    withUltrafixLabelTransition,
    recoverCiFailureFollowups,
} from '@propr/core';
import {
    clearDeferredContinuationIfCurrent,
    completeLoop,
    isUltrafixAutomaticWorkCurrent,
    type UltrafixCiObservation,
    type UltrafixReadinessResult,
} from './ultrafixOrchestrationService.js';
import type { ContinuationResult, UltrafixContinuationParams } from './ultrafixLoopContinuation.js';
import { postPrComment, updatePrComment } from './ultrafixLoopContinuationHelpers.js';
import { stashUltrafixCiWaitNotice } from './ultrafixCiWaitNotice.js';

const CI_WAIT_KEY_PREFIX = 'ultrafix:ci-wait';
const CI_WAIT_TTL_SECONDS = 7 * 24 * 60 * 60;
export const ULTRAFIX_CI_TIMEOUT_REASON = 'CI did not settle';

export interface UltrafixCiWaitRecord {
    workEpoch: number;
    headSha: string;
    /** ISO timestamp when blocking checks first held this head back. */
    since: string;
    /** ISO timestamp of the deferral comment, once posted. */
    noticePostedAt?: string;
    /** GitHub id of the deferral comment, so its outcome can replace it in place. */
    noticeCommentId?: number;
    blockingFailed: string[];
    blockingPending: string[];
    lastScore?: number | null;
}

export interface UltrafixCiDeferralInput {
    redis: Redis;
    owner: string;
    repo: string;
    pr: number;
    workEpoch: number;
    /**
     * Earliest epoch of the same loop whose wait may carry over to `workEpoch`.
     * A re-arm hands the loop to a freshly reserved epoch; a wait recorded for
     * the same head under an earlier epoch of that loop is the same wait, so
     * its notice and start time carry over instead of starting again.
     */
    carryOverFromEpoch?: number;
    ci: UltrafixCiObservation;
    goal?: number;
    lastScore?: number | null;
    correlatedLogger: Logger;
}

export interface UltrafixCiDeferralResult {
    /** True when the wait exceeded the timeout and this call stopped the loop. */
    stopped: boolean;
    waitedMs: number;
    blockingChecks: string[];
}

export interface UltrafixCiWaitDeps {
    recoverFailures?: typeof recoverCiFailureFollowups;
    now: () => number;
    loadTimeoutMs: () => Promise<number>;
    /** Posts the deferral comment; resolves to its id when known. */
    postComment: (options: { owner: string; repo: string; pullRequestNumber: number; body: string; correlatedLogger: Logger }) => Promise<number | null | void>;
    stopLoop: (input: UltrafixCiTimeoutStopInput) => Promise<boolean>;
}

export interface UltrafixCiTimeoutStopInput {
    redis: Redis;
    owner: string;
    repo: string;
    pr: number;
    workEpoch: number;
    goal?: number;
    lastScore?: number | null;
    waitedMs: number;
    blockingChecks: string[];
    /** The waiting comment to rewrite with the stop comment instead of posting a new one. */
    noticeCommentId?: number;
    correlatedLogger: Logger;
}

export function getUltrafixCiWaitKey(owner: string, repo: string, pr: number): string {
    return `${CI_WAIT_KEY_PREFIX}:${owner}:${repo}:${pr}`;
}

export async function loadUltrafixCiWait(redis: Redis, owner: string, repo: string, pr: number): Promise<UltrafixCiWaitRecord | null> {
    const raw = await redis.get(getUltrafixCiWaitKey(owner, repo, pr));
    if (!raw) return null;
    try {
        return JSON.parse(raw) as UltrafixCiWaitRecord;
    } catch {
        return null;
    }
}

export async function clearUltrafixCiWait(redis: Redis, owner: string, repo: string, pr: number): Promise<void> {
    await redis.del(getUltrafixCiWaitKey(owner, repo, pr));
}

/**
 * Forget a wait whose blocking checks have settled, handing its waiting
 * comment to the review that now runs so that review replaces it in place.
 */
export async function settleUltrafixCiWait(redis: Redis, owner: string, repo: string, pr: number): Promise<void> {
    const record = await loadUltrafixCiWait(redis, owner, repo, pr);
    if (record?.noticeCommentId !== undefined) {
        await stashUltrafixCiWaitNotice(redis, { owner, repo, pr }, { commentId: record.noticeCommentId, headSha: record.headSha });
    }
    await clearUltrafixCiWait(redis, owner, repo, pr);
}

/** Human-readable duration for PR comments, e.g. "2 hours" or "90 minutes". */
export function formatWaitDuration(ms: number): string {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    if (minutes % 60 === 0) {
        const hours = minutes / 60;
        return `${hours} hour${hours === 1 ? '' : 's'}`;
    }
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export function listBlockingChecks(status: { blockingFailed?: string[]; blockingPending?: string[] }): string[] {
    return [...new Set([...(status.blockingFailed ?? []), ...(status.blockingPending ?? [])])];
}

function describeBlockingChecks(record: Pick<UltrafixCiWaitRecord, 'blockingFailed' | 'blockingPending'>): string {
    const lines = [
        ...record.blockingFailed.map(name => `- \`${name}\` — failed`),
        ...record.blockingPending.filter(name => !record.blockingFailed.includes(name)).map(name => `- \`${name}\` — not finished`),
    ];
    return lines.length > 0 ? lines.join('\n') : '- CI status for the current head is not passing yet';
}

export function buildCiDeferralComment(record: UltrafixCiWaitRecord, timeoutMs: number): string {
    return [
        '⏳ **Ultrafix is waiting for CI before the next `/review`.**',
        '',
        `These blocking checks on \`${record.headSha.slice(0, 7)}\` are holding the loop back:`,
        describeBlockingChecks(record),
        '',
        `Checks matching this repository's non-blocking checks never gate Ultrafix. The loop continues automatically once the blocking checks pass; if they have not settled within ${formatWaitDuration(timeoutMs)}, Ultrafix stops.`,
    ].join('\n');
}

export function buildCiTimeoutComment(input: Pick<UltrafixCiTimeoutStopInput, 'goal' | 'lastScore' | 'waitedMs' | 'blockingChecks'>): string {
    const goal = input.goal !== undefined ? `Requested goal: ${input.goal}/10. ` : '';
    const checks = input.blockingChecks.length > 0
        ? ` Blocking checks: ${input.blockingChecks.map(name => `\`${name}\``).join(', ')}.`
        : '';
    return `⚠️ **Ultrafix stopped before reaching its goal.** ${goal}Last score: ${input.lastScore ?? 'unknown'}. `
        + `${ULTRAFIX_CI_TIMEOUT_REASON}: blocking checks were still not passing after ${formatWaitDuration(input.waitedMs)}.${checks} `
        + 'Fix or re-run those checks, then re-arm the loop with `/ultrafix`.';
}

/** Stop the loop for a CI timeout without letting stale automatic work tear down a newer epoch. */
export async function stopUltrafixLoopForCiTimeout(input: UltrafixCiTimeoutStopInput): Promise<boolean> {
    const { redis, owner, repo, pr, workEpoch, correlatedLogger } = input;
    const identity = { owner, repo, pr };
    const stopped = await withUltrafixLabelTransition(redis, identity, async () => {
        if (!await isUltrafixAutomaticWorkCurrent(redis, identity, workEpoch)) return false;
        const completed = await completeLoop(redis, {
            ...identity,
            completionStatus: 'failed',
            completionReason: ULTRAFIX_CI_TIMEOUT_REASON,
            finalScore: input.lastScore ?? null,
            workEpoch,
        });
        if (!completed) return false;
        await clearDeferredContinuationIfCurrent(redis, identity, workEpoch);
        const body = buildCiTimeoutComment({ ...input, goal: input.goal ?? completed.goal });
        // Turn the waiting comment into the stop comment rather than leave it looking like a live wait.
        const replaced = input.noticeCommentId !== undefined
            && await updatePrComment({ owner, repo, pullRequestNumber: pr, commentId: input.noticeCommentId, body, correlatedLogger });
        if (!replaced) {
            await postPrComment({ owner, repo, pullRequestNumber: pr, body, correlatedLogger });
        }
        return true;
    });
    if (stopped) {
        await clearUltrafixCiWait(redis, owner, repo, pr);
        correlatedLogger.info(
            { pullRequestNumber: pr, waitedMs: input.waitedMs, blockingChecks: input.blockingChecks },
            'Ultrafix loop: stopped because CI did not settle',
        );
    }
    return Boolean(stopped);
}

async function loadTimeoutMsSafely(): Promise<number> {
    try {
        return await loadUltrafixCiWaitTimeoutMs();
    } catch {
        return DEFAULT_ULTRAFIX_CI_WAIT_TIMEOUT_MS;
    }
}

const defaultDeps: UltrafixCiWaitDeps = {
    recoverFailures: recoverCiFailureFollowups,
    now: () => Date.now(),
    loadTimeoutMs: loadTimeoutMsSafely,
    postComment: postPrComment,
    stopLoop: stopUltrafixLoopForCiTimeout,
};

/** Whether a wait recorded under `recordedEpoch` belongs to the deferral now running under `workEpoch`. */
function isSameLoopWait(recordedEpoch: number, workEpoch: number, carryOverFromEpoch: number | undefined): boolean {
    if (recordedEpoch === workEpoch) return true;
    return carryOverFromEpoch !== undefined && recordedEpoch >= carryOverFromEpoch && recordedEpoch < workEpoch;
}

/**
 * Record that blocking CI deferred the next Ultrafix review. The first
 * deferral for a head posts one PR comment naming the blocking checks; later
 * polls of the same deferral stay quiet. Once the wait exceeds the timeout,
 * the loop stops with "CI did not settle".
 */
export async function handleUltrafixCiDeferral(
    input: UltrafixCiDeferralInput,
    deps: UltrafixCiWaitDeps = defaultDeps,
): Promise<UltrafixCiDeferralResult> {
    const { redis, owner, repo, pr, workEpoch, ci, correlatedLogger } = input;
    const nowMs = deps.now();
    const existing = await loadUltrafixCiWait(redis, owner, repo, pr);
    const sameDeferral = existing?.headSha === ci.headSha && isSameLoopWait(existing.workEpoch, workEpoch, input.carryOverFromEpoch);
    const record: UltrafixCiWaitRecord = {
        workEpoch,
        headSha: ci.headSha,
        since: sameDeferral ? existing.since : new Date(nowMs).toISOString(),
        ...(sameDeferral && existing.noticePostedAt ? { noticePostedAt: existing.noticePostedAt } : {}),
        ...(sameDeferral && existing.noticeCommentId !== undefined ? { noticeCommentId: existing.noticeCommentId } : {}),
        blockingFailed: ci.status.blockingFailed ?? [],
        blockingPending: ci.status.blockingPending ?? [],
        lastScore: input.lastScore !== undefined ? input.lastScore : (sameDeferral ? existing.lastScore : undefined),
    };
    const blockingChecks = listBlockingChecks(record);
    if (record.blockingFailed.length > 0 && deps.recoverFailures) {
        try {
            await deps.recoverFailures(owner, repo, pr, ci.headSha);
        } catch (error) {
            correlatedLogger.warn({ error: (error as Error).message, pr }, 'Failed to recover missed CI follow-up; will retry on next poll');
        }
    }
    const waitedMs = Math.max(0, nowMs - Date.parse(record.since));
    const timeoutMs = await deps.loadTimeoutMs();

    if (waitedMs >= timeoutMs) {
        const stopped = await deps.stopLoop({
            redis, owner, repo, pr, workEpoch,
            goal: input.goal,
            lastScore: record.lastScore,
            waitedMs,
            blockingChecks,
            ...(record.noticeCommentId !== undefined ? { noticeCommentId: record.noticeCommentId } : {}),
            correlatedLogger,
        });
        return { stopped, waitedMs, blockingChecks };
    }

    if (!record.noticePostedAt) {
        const commentId = await deps.postComment({
            owner,
            repo,
            pullRequestNumber: pr,
            body: buildCiDeferralComment(record, timeoutMs),
            correlatedLogger,
        });
        if (typeof commentId === 'number') record.noticeCommentId = commentId;
        record.noticePostedAt = new Date(nowMs).toISOString();
        correlatedLogger.info(
            { pullRequestNumber: pr, headSha: ci.headSha, blockingChecks },
            'Ultrafix loop: posted CI deferral notice',
        );
    }
    await redis.set(getUltrafixCiWaitKey(owner, repo, pr), JSON.stringify(record), 'EX', CI_WAIT_TTL_SECONDS);
    return { stopped: false, waitedMs, blockingChecks };
}

/** Best-effort wrapper: a notice/timeout failure must never break the deferral itself. */
export async function handleUltrafixCiDeferralSafely(
    input: UltrafixCiDeferralInput,
    deps?: UltrafixCiWaitDeps,
): Promise<UltrafixCiDeferralResult> {
    try {
        return await handleUltrafixCiDeferral(input, deps);
    } catch (error) {
        input.correlatedLogger.warn(
            { pullRequestNumber: input.pr, error: (error as Error).message },
            'Ultrafix loop: failed to record CI deferral notice/timeout',
        );
        return { stopped: false, waitedMs: 0, blockingChecks: listBlockingChecks(input.ci.status) };
    }
}

/**
 * Continuation-side CI deferral: surface it on the PR and enforce the CI wait
 * timeout. `terminal` is set when the timeout stopped the loop; otherwise
 * `extra` carries the blocking checks to report alongside the deferral.
 */
export async function applyUltrafixCiDeferral(
    params: Pick<UltrafixContinuationParams, 'owner' | 'repo' | 'pullRequestNumber' | 'redisClient' | 'correlatedLogger' | 'ultrafixMeta'>,
    readiness: UltrafixReadinessResult,
    loop: { goal: number; maxCycles: number; cycleCount: number; lastScore?: number | null },
    options: Pick<UltrafixCiDeferralInput, 'carryOverFromEpoch'> = {},
): Promise<{ terminal?: ContinuationResult; extra: Pick<ContinuationResult, 'blockingChecks'> }> {
    if (!readiness.ci || !readiness.reasons.includes('checks_not_passing')) return { extra: {} };
    const result = await handleUltrafixCiDeferralSafely({
        redis: params.redisClient,
        owner: params.owner,
        repo: params.repo,
        pr: params.pullRequestNumber,
        workEpoch: params.ultrafixMeta?.workEpoch ?? 0,
        ...options,
        ci: readiness.ci,
        goal: loop.goal,
        lastScore: loop.lastScore,
        correlatedLogger: params.correlatedLogger,
    });
    const extra = result.blockingChecks.length > 0 ? { blockingChecks: result.blockingChecks } : {};
    if (!result.stopped) return { extra };
    return {
        extra,
        terminal: {
            continued: false,
            reason: ULTRAFIX_CI_TIMEOUT_REASON,
            outcome: 'failed',
            ...extra,
            ...(loop.lastScore !== undefined ? { score: loop.lastScore } : {}),
            cycleCount: loop.cycleCount,
            goal: loop.goal,
            maxCycles: loop.maxCycles,
        },
    };
}
