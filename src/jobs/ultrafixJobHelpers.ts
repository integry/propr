/**
 * Ultrafix Job Helpers
 *
 * Ultrafix-specific helper functions extracted from processPullRequestCommentJob
 * to keep the main job file within lint line limits.
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { getCurrentPRHead, areAllChecksPassing, getIssueQueue } from '@propr/core';
import type { CommentJobData, JobResult } from '@propr/core';
import type { WorkerStateManager } from '@propr/core';
import { continueUltrafixLoop } from './ultrafixLoopContinuation.js';
import { buildUltrafixHistoryMeta, buildContinuationMeta, patchUltrafixContinuationMeta } from './ultrafixContinuationMeta.js';
import {
    adoptLegacyUltrafixGeneration,
    getActiveUltrafixTakeoverSequence,
    isFreshUltrafixTransitionReserved,
    isUltrafixGenerationCurrent,
    loadState as loadUltrafixState,
    saveDeferredContinuation,
    type UltrafixAction,
} from './ultrafixOrchestrationService.js';
import { requiresPassingChecks } from './ultrafixReadinessPolicy.js';

/** Reject delayed or retried work from a loop superseded by a manual command. */
export async function checkUltrafixGeneration(
    job: Job<CommentJobData>,
    params: { repoOwner: string; repoName: string; pullRequestNumber: number; correlatedLogger: Logger; redisClient: Redis },
): Promise<boolean> {
    if (!job.data.ultrafixMeta) return true;
    const { repoOwner, repoName, pullRequestNumber, correlatedLogger, redisClient } = params;
    if (job.data.ultrafixMeta.generation === undefined) {
        const adopted = await adoptLegacyUltrafixGeneration(
            redisClient, { owner: repoOwner, repo: repoName, pr: pullRequestNumber },
        );
        if (adopted) job.data.ultrafixMeta.generation = 0;
    }
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
        const generation = job.data.ultrafixMeta?.generation;
        const reserved = generation !== undefined && await isFreshUltrafixTransitionReserved(
            params.redisClient,
            { owner: params.repoOwner, repo: params.repoName, pr: params.pullRequestNumber },
            generation,
        );
        if (reserved) {
            const waitCount = (job.data.ultrafixStartupWaitCount ?? 0) + 1;
            const retryData = { ...job.data, ultrafixStartupWaitCount: waitCount };
            await (await getIssueQueue()).add(job.name, retryData, {
                jobId: `pr-comments-ultrafix-wait-${params.repoOwner}-${params.repoName}-${params.pullRequestNumber}-${generation}-${waitCount}`,
                delay: 5_000,
                attempts: 3,
                backoff: { type: 'exponential', delay: 10_000 },
            });
            params.correlatedLogger.info(
                { pullRequestNumber: params.pullRequestNumber, generation },
                'Ultrafix startup publication is pending; rescheduled reserved job',
            );
            return { status: 'rescheduled', reason: 'ultrafix_startup_pending' };
        }
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
    try {
        const takeoverSequence = await getActiveUltrafixTakeoverSequence(
            params.redisClient,
            { owner: repoOwner, repo: repoName, pr: pullRequestNumber },
        );
        if (takeoverSequence !== null) {
            correlatedLogger.info(
                { pullRequestNumber, nextAction, takeoverSequence },
                'Ultrafix pre-check: manual takeover in progress, deferring stale loop work',
            );
            await deferUltrafixJob(job, params, nextAction, 'manual_takeover_in_progress');
            return false;
        }
    } catch (err) {
        correlatedLogger.warn(
            { pullRequestNumber, error: (err as Error).message },
            'Ultrafix pre-check: could not inspect manual takeover fence, deferring',
        );
        await deferUltrafixJob(job, params, nextAction, 'manual_takeover_fence_unavailable');
        return false;
    }
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
