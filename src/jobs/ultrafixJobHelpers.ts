/**
 * Ultrafix Job Helpers
 *
 * Ultrafix-specific helper functions extracted from processPullRequestCommentJob
 * to keep the main job file within lint line limits.
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { getCurrentPRHead, areAllChecksPassing } from '@propr/core';
import type { CommentJobData } from '@propr/core';
import type { WorkerStateManager } from '@propr/core';
import { continueUltrafixLoop, buildUltrafixHistoryMeta, buildContinuationMeta, patchUltrafixContinuationMeta } from './ultrafixLoopContinuation.js';
import { loadState as loadUltrafixState, saveDeferredContinuation, type UltrafixAction } from './ultrafixOrchestrationService.js';

/** Re-check CI readiness for ultrafix jobs before executing. Returns true if ready. */
export async function checkUltrafixReadiness(
    job: Job<CommentJobData>,
    params: { repoOwner: string; repoName: string; pullRequestNumber: number; correlatedLogger: Logger; redisClient: Redis }
): Promise<boolean> {
    if (!job.data.ultrafixMeta) return true;
    const { repoOwner, repoName, pullRequestNumber, correlatedLogger, redisClient } = params;
    try {
        const headSha = await getCurrentPRHead(repoOwner, repoName, pullRequestNumber);
        if (!headSha) { correlatedLogger.warn({ pullRequestNumber }, 'Ultrafix pre-check: could not get PR head SHA'); return true; }
        const checksPassing = await areAllChecksPassing(repoOwner, repoName, headSha);
        if (checksPassing) { correlatedLogger.info({ pullRequestNumber }, 'Ultrafix pre-check: CI checks passing, proceeding'); return true; }
        correlatedLogger.info({ pullRequestNumber }, 'Ultrafix pre-check: CI checks not passing, deferring');
        await saveDeferredContinuation(redisClient, { owner: repoOwner, repo: repoName, pr: pullRequestNumber, nextAction: job.data.commandMode as 'review' | 'fix', savedAt: new Date().toISOString(), reason: 'pre_execution_ci_check_failed' });
        return false;
    } catch (err) {
        correlatedLogger.warn({ pullRequestNumber, error: (err as Error).message }, 'Ultrafix pre-check: error checking CI, proceeding anyway');
        return true;
    }
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
