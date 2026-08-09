/**
 * Ultrafix Job Helpers
 *
 * Ultrafix-specific helper functions extracted from processPullRequestCommentJob
 * to keep the main job file within lint line limits.
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { getCurrentPRHead, areAllChecksPassing, getIssueQueue, getPendingPrCommentsKey } from '@propr/core';
import type { CommentJobData, JobResult } from '@propr/core';
import type { WorkerStateManager } from '@propr/core';
import { continueUltrafixLoop } from './ultrafixLoopContinuation.js';
import { buildUltrafixHistoryMeta, buildContinuationMeta, patchUltrafixContinuationMeta } from './ultrafixContinuationMeta.js';
import {
    adoptLegacyUltrafixGeneration,
    commitFreshUltrafixLoop,
    getActiveUltrafixTakeoverSequence,
    hasFollowUpJobsForPR,
    hasPendingBatchedComments,
    isFreshUltrafixTransitionReserved,
    isManualUltrafixCommandSequenceCurrent,
    isUltrafixGenerationActive,
    loadState as loadUltrafixState,
    saveDeferredContinuation,
    type UltrafixAction,
} from './ultrafixOrchestrationService.js';
import { requiresPassingChecks } from './ultrafixReadinessPolicy.js';
import { withUltrafixTransitionLease } from './ultrafixTransitionLease.js';

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
    const current = await isUltrafixGenerationActive(
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

async function checkManualCommandSequence(
    job: Job<CommentJobData>,
    params: { repoOwner: string; repoName: string; pullRequestNumber: number; correlatedLogger: Logger; redisClient: Redis },
): Promise<boolean> {
    if (job.data.ultrafixMeta
        || (job.data.commandMode !== 'fix' && job.data.commandMode !== 'review')
        || job.data.commandSequence === undefined) {
        return true;
    }
    const current = await isManualUltrafixCommandSequenceCurrent(
        params.redisClient,
        { owner: params.repoOwner, repo: params.repoName, pr: params.pullRequestNumber },
        job.data.commandSequence,
    );
    if (!current) {
        params.correlatedLogger.info(
            {
                pullRequestNumber: params.pullRequestNumber,
                commandSequence: job.data.commandSequence,
            },
            'Manual command job belongs to a superseded comment revision, cancelling before execution',
        );
    }
    return current;
}

export async function guardUltrafixJobExecution(
    job: Job<CommentJobData>,
    params: { repoOwner: string; repoName: string; pullRequestNumber: number; correlatedLogger: Logger; redisClient: Redis },
): Promise<JobResult | null> {
    if (!await checkManualCommandSequence(job, params)) {
        return { status: 'cancelled', reason: 'manual_command_superseded' };
    }
    if (!await checkUltrafixGeneration(job, params)) {
        const generation = job.data.ultrafixMeta?.generation;
        const reserved = generation !== undefined && await isFreshUltrafixTransitionReserved(
            params.redisClient,
            { owner: params.repoOwner, repo: params.repoName, pr: params.pullRequestNumber },
            generation,
        );
        if (reserved) {
            const recoveryResult = await withUltrafixTransitionLease(
                params.redisClient,
                { owner: params.repoOwner, repo: params.repoName, pr: params.pullRequestNumber },
                job.data.correlationId,
                async assertOwned => {
                    await assertOwned();
                    if (await checkUltrafixGeneration(job, params)) return null;
                    if (!await isFreshUltrafixTransitionReserved(
                        params.redisClient,
                        { owner: params.repoOwner, repo: params.repoName, pr: params.pullRequestNumber },
                        generation!,
                    )) return { status: 'cancelled', reason: 'ultrafix_startup_superseded' } as JobResult;
                    const recovery = job.data.ultrafixStartupRecovery;
                    if (!recovery || recovery.generation !== generation) {
                        params.correlatedLogger.warn(
                            { pullRequestNumber: params.pullRequestNumber, generation },
                            'Reserved Ultrafix startup job has no matching recovery data; cancelling safely',
                        );
                        return { status: 'cancelled', reason: 'ultrafix_startup_unrecoverable' } as JobResult;
                    }
                    const committed = await commitFreshUltrafixLoop(params.redisClient, {
                        owner: params.repoOwner,
                        repo: params.repoName,
                        pr: params.pullRequestNumber,
                        commandSequence: recovery.commandSequence,
                        generation: recovery.generation,
                        baseGeneration: recovery.baseGeneration,
                        goal: recovery.goal,
                        maxCycles: recovery.maxCycles,
                        pauseSeconds: recovery.pauseSeconds,
                        reviewModel: recovery.reviewModel,
                    }, recovery.initialAction === 'fix');
                    if (!committed || !await checkUltrafixGeneration(job, params)) {
                        return { status: 'cancelled', reason: 'ultrafix_startup_superseded' } as JobResult;
                    }
                    params.correlatedLogger.info(
                        { pullRequestNumber: params.pullRequestNumber, generation },
                        'Recovered and published reserved Ultrafix startup from its durable first job',
                    );
                    return null;
                },
            );
            if (recoveryResult) return recoveryResult;
        } else {
            return { status: 'cancelled', reason: 'ultrafix_superseded' };
        }
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
    const { repoOwner, repoName, pullRequestNumber, correlatedLogger, redisClient } = params;
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
    try {
        const followUpJobsExist = await hasFollowUpJobsForPR(
            repoOwner, repoName, pullRequestNumber,
            async () => {
                const jobs = await (await getIssueQueue()).getJobs(['waiting', 'active', 'delayed']);
                return jobs.filter(candidate => candidate.id !== job.id);
            },
        );
        if (followUpJobsExist) {
            correlatedLogger.info({ pullRequestNumber, nextAction }, 'Ultrafix pre-check: follow-up job still queued, deferring');
            await deferUltrafixJob(job, params, nextAction, 'pre_execution_followup_job');
            return false;
        }
    } catch (err) {
        correlatedLogger.warn({ pullRequestNumber, error: (err as Error).message }, 'Ultrafix pre-check: could not inspect follow-up jobs, deferring');
        await deferUltrafixJob(job, params, nextAction, 'pre_execution_queue_unavailable');
        return false;
    }
    try {
        const pendingComments = await hasPendingBatchedComments(
            redisClient, getPendingPrCommentsKey(repoOwner, repoName, pullRequestNumber),
        );
        if (pendingComments) {
            correlatedLogger.info({ pullRequestNumber, nextAction }, 'Ultrafix pre-check: pending batched comments remain, deferring');
            await deferUltrafixJob(job, params, nextAction, 'pre_execution_pending_comments');
            return false;
        }
    } catch (err) {
        correlatedLogger.warn({ pullRequestNumber, error: (err as Error).message }, 'Ultrafix pre-check: could not inspect pending comments, deferring');
        await deferUltrafixJob(job, params, nextAction, 'pre_execution_pending_comments_unavailable');
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
