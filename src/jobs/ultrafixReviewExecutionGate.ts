import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { getCheckRunsStatus, getCurrentPRHead } from '@propr/core';
import type { CommentJobData } from '@propr/core';
import {
    saveDeferredContinuation,
    type UltrafixCheckStatus,
    type UltrafixDeferredContinuation,
} from './ultrafixOrchestrationService.js';

interface UltrafixReviewExecutionGateDeps {
    getCurrentPRHead: (owner: string, repo: string, pr: number) => Promise<string | null>;
    getCheckRunsStatus: (owner: string, repo: string, ref: string) => Promise<UltrafixCheckStatus>;
    saveDeferredContinuation: (redis: Redis, deferred: UltrafixDeferredContinuation) => Promise<unknown>;
}

const defaultDeps: UltrafixReviewExecutionGateDeps = {
    getCurrentPRHead,
    getCheckRunsStatus,
    saveDeferredContinuation,
};

/** Re-check exact-head CI when an automatic review job wakes after its enqueue delay. */
export async function isUltrafixReviewExecutionReady(
    job: Job<CommentJobData>,
    params: { redisClient: Redis; correlatedLogger: Logger },
    deps: UltrafixReviewExecutionGateDeps = defaultDeps,
): Promise<boolean> {
    if (!job.data.ultrafixMeta || job.data.commandMode !== 'review') return true;

    const { repoOwner: owner, repoName: repo, pullRequestNumber: pr } = job.data;
    let reason = 'pre_execution_checks_not_passing';
    try {
        const headSha = await deps.getCurrentPRHead(owner, repo, pr);
        if (headSha) {
            const status = await deps.getCheckRunsStatus(owner, repo, headSha);
            if (status.allPassing) return true;
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

    await deps.saveDeferredContinuation(params.redisClient, {
        owner,
        repo,
        pr,
        nextAction: 'review',
        savedAt: new Date().toISOString(),
        reason,
        ultrafixMeta: job.data.ultrafixMeta,
    });
    return false;
}

export async function shouldDeferUltrafixReview(
    job: Job<CommentJobData>,
    redisClient: Redis,
    correlatedLogger: Logger,
): Promise<boolean> {
    return !await isUltrafixReviewExecutionReady(job, { redisClient, correlatedLogger });
}
