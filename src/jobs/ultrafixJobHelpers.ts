/**
 * Ultrafix Job Helpers
 *
 * Ultrafix-specific helper functions extracted from processPullRequestCommentJob
 * to keep the main job file within lint line limits.
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { issueQueue, type CommentJobData, type UnprocessedComment } from '@propr/core';
import type { WorkerStateManager } from '@propr/core';
import { continueUltrafixLoop } from './ultrafixLoopContinuation.js';
import { buildUltrafixHistoryMeta, buildContinuationMeta, patchUltrafixContinuationMeta } from './ultrafixContinuationMeta.js';
import {
    isUltrafixAutomaticWorkCurrent,
    loadState as loadUltrafixState,
    type UltrafixAction,
} from './ultrafixOrchestrationService.js';
import { restorePendingComments } from './prPendingComments.js';

/** Reject delayed or retried automatic jobs superseded by a manual command. */
export async function isUltrafixJobCurrent(
    job: Job<CommentJobData>,
    params: { repoOwner: string; repoName: string; pullRequestNumber: number; redisClient: Redis },
): Promise<boolean> {
    if (!job.data.ultrafixMeta) return true;
    return isUltrafixAutomaticWorkCurrent(
        params.redisClient,
        { owner: params.repoOwner, repo: params.repoName, pr: params.pullRequestNumber },
        job.data.ultrafixMeta.workEpoch,
    );
}

/** Preserve comments destructively claimed by an automatic job that is now stale. */
export async function restorePendingCommentsIfUltrafixJobSuperseded(
    job: Job<CommentJobData>,
    params: { repoOwner: string; repoName: string; pullRequestNumber: number; redisClient: Redis },
    pickedUpComments: UnprocessedComment[],
    originalUltrafixMeta: CommentJobData['ultrafixMeta'] = job.data.ultrafixMeta,
): Promise<boolean> {
    if (!originalUltrafixMeta) return false;
    const originCurrent = await isUltrafixAutomaticWorkCurrent(
        params.redisClient,
        { owner: params.repoOwner, repo: params.repoName, pr: params.pullRequestNumber },
        originalUltrafixMeta.workEpoch,
    );
    if (originCurrent) return false;

    const resolvedManualTakeover = !job.data.ultrafixMeta
        && (job.data.commandMode === 'fix' || job.data.commandMode === 'review');
    if (resolvedManualTakeover && !await hasOtherCurrentManualOwner(job, params)) return false;

    await restorePendingComments(pickedUpComments, params);
    if (pickedUpComments.length > 0) {
        await issueQueue.add('processPullRequestComment', {
            pullRequestNumber: params.pullRequestNumber,
            comments: [],
            repoOwner: params.repoOwner,
            repoName: params.repoName,
            branchName: job.data.branchName,
            llm: job.data.llm,
            correlationId: job.data.correlationId,
            reasoningLevel: job.data.reasoningLevel,
        }, { delay: 3000 });
    }
    return true;
}

async function hasOtherCurrentManualOwner(
    staleJob: Job<CommentJobData>,
    params: { repoOwner: string; repoName: string; pullRequestNumber: number },
): Promise<boolean> {
    const jobs = (await Promise.all([
        issueQueue.getActive(),
        issueQueue.getWaiting(),
        issueQueue.getDelayed(),
    ])).flat();
    return jobs.some(candidate => {
        if (candidate.name !== 'processPullRequestComment' || !('pullRequestNumber' in candidate.data)) return false;
        const data = candidate.data as CommentJobData;
        return candidate.id !== staleJob.id
            && data.repoOwner === params.repoOwner
            && data.repoName === params.repoName
            && data.pullRequestNumber === params.pullRequestNumber
            && !data.ultrafixMeta
            && (data.commandMode === 'fix' || data.commandMode === 'review');
    });
}

export async function handleUltrafixContinuation(
    action: UltrafixAction,
    params: { job: Job<CommentJobData>; stateManager: WorkerStateManager; taskId: string; redisClient: Redis; repoOwner: string; repoName: string; pullRequestNumber: number; correlatedLogger: Logger; correlationId: string }
): Promise<void> {
    if (!params.job.data.ultrafixMeta) return;
    const { job, stateManager, taskId, redisClient, repoOwner, repoName, pullRequestNumber, correlatedLogger, correlationId } = params;
    try {
        const continuationResult = await continueUltrafixLoop({
            owner: repoOwner, repo: repoName, pullRequestNumber, completedAction: action,
            ultrafixMeta: job.data.ultrafixMeta!, redisClient, correlatedLogger, correlationId,
            currentJobId: job.id,
        });
        correlatedLogger.info({ pullRequestNumber, ...continuationResult }, `Ultrafix loop continuation after ${action}`);
        await patchUltrafixContinuationMeta(stateManager, taskId, buildContinuationMeta(continuationResult), correlatedLogger);
    } catch (contErr) {
        correlatedLogger.error({ error: (contErr as Error).message, pullRequestNumber }, `Ultrafix loop continuation failed after ${action}`);
    }
}

export async function resolveUltrafixHistoryMeta(
    job: Job<CommentJobData>,
    issueRef: { repoOwner: string; repoName: string; pullRequestNumber: number },
    redisClient: Redis,
): Promise<Record<string, unknown> | undefined> {
    if (!job.data.ultrafixMeta) return undefined;
    return buildUltrafixHistoryMeta(job.data.ultrafixMeta, await loadUltrafixState(redisClient, issueRef.repoOwner, issueRef.repoName, issueRef.pullRequestNumber));
}
