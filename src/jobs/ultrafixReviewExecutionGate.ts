import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { getCheckRunsStatusForRepo, getCurrentPRHead } from '@propr/core';
import type { CommentJobData } from '@propr/core';
import {
    saveDeferredContinuation,
    type UltrafixCheckStatus,
    type UltrafixCiObservation,
    type UltrafixDeferredContinuation,
} from './ultrafixOrchestrationService.js';
import type { UltrafixCiDeferralInput, UltrafixCiDeferralResult } from './ultrafixCiWait.js';
import { deferredUltrafixReviewRecap } from './notificationRecap.js';

interface UltrafixReviewExecutionGateDeps {
    getCurrentPRHead: (owner: string, repo: string, pr: number) => Promise<string | null>;
    getCheckRunsStatus: (owner: string, repo: string, ref: string) => Promise<UltrafixCheckStatus>;
    saveDeferredContinuation: (redis: Redis, deferred: UltrafixDeferredContinuation) => Promise<unknown>;
    /** Posts the one-per-deferral CI notice and enforces the CI wait timeout. */
    handleCiDeferral?: (input: UltrafixCiDeferralInput) => Promise<UltrafixCiDeferralResult>;
    /** Forgets a finished CI wait once the review may run. */
    clearCiWait?: (redis: Redis, owner: string, repo: string, pr: number) => Promise<void>;
}

// Loaded lazily so the gate stays importable without the loop-continuation graph.
const defaultDeps: UltrafixReviewExecutionGateDeps = {
    getCurrentPRHead,
    // Repository-aware: checks matching nonBlockingChecks never hold the review.
    getCheckRunsStatus: (owner, repo, ref) => getCheckRunsStatusForRepo(owner, repo, ref),
    saveDeferredContinuation,
    handleCiDeferral: async input => (await import('./ultrafixCiWait.js')).handleUltrafixCiDeferralSafely(input),
    clearCiWait: async (...args) => (await import('./ultrafixCiWait.js')).clearUltrafixCiWait(...args),
};

export interface UltrafixReviewDeferral {
    reason: string;
    blockingChecks?: string[];
    stopped?: boolean;
}

/**
 * Re-check exact-head CI when an automatic review job wakes after its enqueue
 * delay. Returns null when the review may run, otherwise why it was deferred.
 */
export async function evaluateUltrafixReviewExecution(
    job: Job<CommentJobData>,
    params: { redisClient: Redis; correlatedLogger: Logger },
    deps: UltrafixReviewExecutionGateDeps = defaultDeps,
): Promise<UltrafixReviewDeferral | null> {
    if (!job.data.ultrafixMeta || job.data.commandMode !== 'review') return null;

    const { repoOwner: owner, repoName: repo, pullRequestNumber: pr } = job.data;
    let reason = 'pre_execution_checks_not_passing';
    let ci: UltrafixCiObservation | undefined;
    try {
        const headSha = await deps.getCurrentPRHead(owner, repo, pr);
        if (headSha) {
            const status = await deps.getCheckRunsStatus(owner, repo, headSha);
            if (status.allPassing) {
                await deps.clearCiWait?.(params.redisClient, owner, repo, pr)
                    .catch(error => params.correlatedLogger.warn({ pullRequestNumber: pr, error: (error as Error).message }, 'Failed to clear Ultrafix CI wait record'));
                return null;
            }
            ci = { headSha, status };
            params.correlatedLogger.info(
                { pullRequestNumber: pr, headSha, ...status },
                'Ultrafix automatic review woke before exact-head checks passed',
            );
        } else {
            reason = 'pre_execution_head_unavailable';
        }
    } catch (error) {
        reason = 'pre_execution_check_status_unavailable';
        params.correlatedLogger.warn(
            { pullRequestNumber: pr, error: (error as Error).message },
            'Ultrafix automatic review could not verify exact-head checks',
        );
    }

    const saved = await deps.saveDeferredContinuation(params.redisClient, {
        owner,
        repo,
        pr,
        nextAction: 'review',
        savedAt: new Date().toISOString(),
        reason,
        ...(job.data.userId ? { userId: job.data.userId } : {}),
        ultrafixMeta: job.data.ultrafixMeta,
    });
    if (!ci || saved === false || !deps.handleCiDeferral) return { reason };

    try {
        const result = await deps.handleCiDeferral({
            redis: params.redisClient,
            owner,
            repo,
            pr,
            workEpoch: job.data.ultrafixMeta.workEpoch ?? 0,
            ci,
            goal: job.data.ultrafixMeta.goal,
            correlatedLogger: params.correlatedLogger,
        });
        return { reason, blockingChecks: result.blockingChecks, ...(result.stopped ? { stopped: true } : {}) };
    } catch (error) {
        // The deferral itself is saved; a notice/timeout failure must not fail the job.
        params.correlatedLogger.warn({ pullRequestNumber: pr, error: (error as Error).message }, 'Ultrafix CI deferral notice failed');
        return { reason };
    }
}

export async function isUltrafixReviewExecutionReady(
    job: Job<CommentJobData>,
    params: { redisClient: Redis; correlatedLogger: Logger },
    deps: UltrafixReviewExecutionGateDeps = defaultDeps,
): Promise<boolean> {
    return await evaluateUltrafixReviewExecution(job, params, deps) === null;
}

/** Returns the deferral when an automatic review must wait, or null when it may run. */
export async function shouldDeferUltrafixReview(
    job: Job<CommentJobData>,
    redisClient: Redis,
    correlatedLogger: Logger,
): Promise<UltrafixReviewDeferral | null> {
    return evaluateUltrafixReviewExecution(job, { redisClient, correlatedLogger });
}

/** Task-history update for a deferred automatic review, naming the blocking checks for operation receipts. */
export function ultrafixReviewDeferralUpdate(deferral: UltrafixReviewDeferral): { reason: string; historyMetadata: Record<string, unknown> } {
    const checks = deferral.blockingChecks?.length ? { ultrafixBlockingChecks: deferral.blockingChecks } : {};
    const base = { deferred: true, recoveryReason: 'ultrafix_waiting_for_exact_head_checks', ...deferredUltrafixReviewRecap, ...checks };
    if (deferral.stopped) {
        return {
            reason: 'Ultrafix stopped: CI did not settle',
            historyMetadata: { ...base, ultrafixOutcome: 'failed', ultrafixStopReason: 'CI did not settle' },
        };
    }
    const waitingFor = deferral.blockingChecks?.length ? `: waiting for ${deferral.blockingChecks.join(', ')}` : '';
    return {
        reason: `Ultrafix review deferred until exact-head checks pass${waitingFor}`,
        historyMetadata: { ...base, ultrafixDeferred: true, ultrafixNextAction: 'review', ultrafixDeferralReason: deferral.reason },
    };
}
