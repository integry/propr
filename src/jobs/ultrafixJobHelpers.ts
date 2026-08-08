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
import type { CommentJobData, JobResult } from '@propr/core';
import type { WorkerStateManager } from '@propr/core';
import { continueUltrafixLoop } from './ultrafixLoopContinuation.js';
import { buildUltrafixHistoryMeta, buildContinuationMeta, patchUltrafixContinuationMeta } from './ultrafixContinuationMeta.js';
import { isUltrafixGenerationCurrent, loadState as loadUltrafixState, saveDeferredContinuation, type UltrafixAction } from './ultrafixOrchestrationService.js';
import { requiresPassingChecks } from './ultrafixReadinessPolicy.js';

/** Reject delayed or retried work from a loop superseded by a manual command. */
export async function checkUltrafixGeneration(
    job: Job<CommentJobData>,
    params: { repoOwner: string; repoName: string; pullRequestNumber: number; correlatedLogger: Logger; redisClient: Redis },
): Promise<boolean> {
    if (!job.data.ultrafixMeta) return true;
    const { repoOwner, repoName, pullRequestNumber, correlatedLogger, redisClient } = params;
    const generation = job.data.ultrafixMeta.generation;
    const current = await isUltrafixGenerationCurrent(
        redisClient, { owner: repoOwner, repo: repoName, pr: pullRequestNumber }, generation,
    );
    if (!current) {
        correlatedLogger.info(
            { pullRequestNumber, generation },
            'Ultrafix job belongs to a superseded generation, cancelling before execution',
        );
    }
    return current;
}

export async function guardUltrafixJobExecution(
    job: Job<CommentJobData>,
    params: { repoOwner: string; repoName: string; pullRequestNumber: number; correlatedLogger: Logger; redisClient: Redis },
): Promise<JobResult | null> {
    if (!await checkUltrafixGeneration(job, params)) {
        return { status: 'cancelled', reason: 'ultrafix_superseded' };
    }
    if (!await checkUltrafixReadiness(job, params)) {
        if (!await checkUltrafixGeneration(job, params)) {
            return { status: 'cancelled', reason: 'ultrafix_superseded' };
        }
        return { status: 'deferred', reason: 'ultrafix_not_ready' };
    }
    return null;
}

async function deferUltrafixJob(
    job: Job<CommentJobData>,
    params: { repoOwner: string; repoName: string; pullRequestNumber: number; redisClient: Redis },
    nextAction: UltrafixAction,
    reason: string,
): Promise<boolean> {
    return saveDeferredContinuation(params.redisClient, {
        owner: params.repoOwner,
        repo: params.repoName,
        pr: params.pullRequestNumber,
        nextAction,
        savedAt: new Date().toISOString(),
        reason,
        ultrafixMeta: job.data.ultrafixMeta,
        generation: job.data.ultrafixMeta?.generation,
    });
}

/** Re-check CI readiness for ultrafix jobs before executing. Returns true if ready. */
export async function checkUltrafixReadiness(
    job: Job<CommentJobData>,
    params: { repoOwner: string; repoName: string; pullRequestNumber: number; correlatedLogger: Logger; redisClient: Redis }
): Promise<boolean> {
    if (!job.data.ultrafixMeta) return true;
    const { repoOwner, repoName, pullRequestNumber, correlatedLogger } = params;
    const nextAction: UltrafixAction = job.data.commandMode === 'fix' ? 'fix' : 'review';
    if (!requiresPassingChecks(nextAction)) {
        correlatedLogger.info({ pullRequestNumber, nextAction }, 'Ultrafix pre-check: allowing fix transition without passing CI checks');
        return true;
    }
    try {
        const headSha = await getCurrentPRHead(repoOwner, repoName, pullRequestNumber);
        if (!headSha) {
            correlatedLogger.warn({ pullRequestNumber }, 'Ultrafix pre-check: could not get PR head SHA, deferring review');
            await deferUltrafixJob(job, params, nextAction, 'pre_execution_ci_head_unavailable');
            return false;
        }
        const checksPassing = await areAllChecksPassing(repoOwner, repoName, headSha);
        if (checksPassing) { correlatedLogger.info({ pullRequestNumber }, 'Ultrafix pre-check: CI checks passing, proceeding'); return true; }
        correlatedLogger.info({ pullRequestNumber }, 'Ultrafix pre-check: CI checks not passing, deferring');
        await deferUltrafixJob(job, params, nextAction, 'pre_execution_ci_check_failed');
        return false;
    } catch (err) {
        correlatedLogger.warn({ pullRequestNumber, error: (err as Error).message }, 'Ultrafix pre-check: error checking CI, deferring review');
        await deferUltrafixJob(job, params, nextAction, 'pre_execution_ci_check_error');
        return false;
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
