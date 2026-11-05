import { randomUUID } from 'node:crypto';
import {
    getAuthenticatedOctokit, getStateManager, inspectTaskContainerLivenessForTask, logger, TaskStates,
} from '@propr/core';
import type { UnprocessedComment } from '@propr/core';
import type { PRProcessingLockRedisClient } from './prProcessingLock.js';
import { restorePendingComments, withdrawPendingComments } from './prPendingComments.js';
import { createFollowupHandoffGitOps, type FollowupHandoffGitOps } from './followupHandoffGitOps.js';
import { splitHandoffRepository, type HandoffOctokit, type HandoffStateManager, type HandoffTaskStates, type LoggerLike } from './followupHandoffResume.js';
import {
    parseHandoffJobData, recordFollowupHandoffDiagnostic, HANDOFF_AWAITING_OPERATOR, type FollowupHandoffRecord, type FollowupHandoffStoreDeps,
} from './followupHandoffStore.js';

/** Shared dependency resolution for follow-up handoff recovery and operator actions. */

export type HandoffRedis = PRProcessingLockRedisClient & { lrange?: unknown; quit?(): Promise<unknown> };

export interface TaskContainerInspection {
    liveness: string;
    container?: { id: string; name: string } | null;
}

export interface FollowupHandoffRecoveryDeps {
    store?: FollowupHandoffStoreDeps;
    redis?: HandoffRedis;
    log?: LoggerLike;
    stateManager?: HandoffStateManager;
    getOctokit?: () => Promise<HandoffOctokit>;
    inspectLiveness?: (taskId: string) => Promise<TaskContainerInspection>;
    git?: FollowupHandoffGitOps;
    restoreComments?: (record: FollowupHandoffRecord, comments: UnprocessedComment[]) => Promise<void>;
    /** Removes a cancelled handoff's claimed comments from the pending list again (restored ones included). */
    withdrawRestoredComments?: (record: FollowupHandoffRecord, comments: UnprocessedComment[]) => Promise<void>;
    /** Queues the follow-up job that picks up comments a standalone no-change recovery restored. */
    scheduleRestoredComments?: (record: FollowupHandoffRecord) => Promise<void>;
    taskStates?: HandoffTaskStates;
    /** PR lease heartbeat cadence while recovery owns a handoff; tests shorten it. */
    heartbeatIntervalMs?: number;
}

export interface ResolvedRecoveryDeps {
    store: FollowupHandoffStoreDeps;
    redis: HandoffRedis;
    ownRedis: boolean;
    log: LoggerLike;
    stateManager: HandoffStateManager;
    getOctokit: () => Promise<HandoffOctokit>;
    inspectLiveness: (taskId: string) => Promise<TaskContainerInspection>;
    git: FollowupHandoffGitOps;
    restoreComments: (record: FollowupHandoffRecord, comments: UnprocessedComment[]) => Promise<void>;
    withdrawRestoredComments: (record: FollowupHandoffRecord, comments: UnprocessedComment[]) => Promise<void>;
    scheduleRestoredComments: (record: FollowupHandoffRecord) => Promise<void>;
    taskStates: HandoffTaskStates;
    heartbeatIntervalMs?: number;
}

/**
 * Restored comments sit in the PR's pending list, which only a
 * processPullRequestComment job drains: the webhook queues one per new user
 * comment, and a finishing job queues one when its cleanup finds leftovers.
 * A standalone recovery pass runs in neither, so without this job the restored
 * request would wait for an unrelated new comment (and expire with the list's
 * TTL). The job ID is fixed per handoff incarnation, so a retried pass that
 * restores the same comments again does not queue a second job.
 */
export async function queueRestoredCommentFollowup(record: FollowupHandoffRecord): Promise<void> {
    // Lazy import: test suites replace @propr/core with enumerated mocks.
    const { issueQueue } = await import('@propr/core');
    const { owner, repo } = splitHandoffRepository(record.repository);
    const jobData = parseHandoffJobData(record);
    // The replacement resumes the interrupted request under a new task ID, so
    // it keeps that request's spend cap override and counts what the
    // interrupted attempt (and its own earlier attempts) already spent.
    const costBudgetTaskIds = [...new Set([...(jobData.costBudgetTaskIds ?? []), record.task_id])];
    await issueQueue.add('processPullRequestComment', {
        pullRequestNumber: record.pull_request, comments: [],
        repoOwner: jobData.repoOwner ?? owner, repoName: jobData.repoName ?? repo,
        branchName: jobData.branchName ?? record.branch_name, llm: jobData.llm ?? record.llm,
        correlationId: randomUUID(), reasoningLevel: jobData.reasoningLevel,
        ...(jobData.maxCostUsd === undefined ? {} : { maxCostUsd: jobData.maxCostUsd }),
        costBudgetTaskIds,
    }, { jobId: `pr-comments-batch-${owner}-${repo}-${record.pull_request}-handoff-${record.incarnation}`, delay: 3000 });
}

/** The supplied Redis client, or a new one the caller owns and must quit. */
export async function resolveHandoffRedis(deps: Pick<FollowupHandoffRecoveryDeps, 'redis'>): Promise<{ redis: HandoffRedis; ownRedis: boolean }> {
    if (deps.redis) return { redis: deps.redis, ownRedis: false };
    // Recovery must read the same Redis the workers use for leases and
    // pending comments: the shared runtime configuration carries the URL,
    // credentials, TLS and database selection, not just host and port.
    // (Lazy imports: test suites replace @propr/core with enumerated mocks.)
    const [{ Redis }, { buildRedisRuntimeConfig }] = await Promise.all([import('ioredis'), import('@propr/core')]);
    const { url, options } = buildRedisRuntimeConfig();
    return { redis: (url ? new Redis(url, options) : new Redis(options)) as unknown as HandoffRedis, ownRedis: true };
}

export async function resolveRecoveryDeps(deps: FollowupHandoffRecoveryDeps): Promise<ResolvedRecoveryDeps> {
    const log = deps.log ?? logger as unknown as LoggerLike;
    const { redis, ownRedis } = await resolveHandoffRedis(deps);
    let octokit: Promise<HandoffOctokit> | undefined;
    const getOctokit = deps.getOctokit
        ?? (() => octokit ??= getAuthenticatedOctokit() as unknown as Promise<HandoffOctokit>);
    const git = deps.git ?? createFollowupHandoffGitOps(async () => {
        const client = await getOctokit();
        return (await client.auth({ type: 'installation' }) as { token: string }).token;
    });
    const resolvedRedis = redis;
    return {
        store: deps.store ?? {},
        redis: resolvedRedis,
        ownRedis,
        log,
        stateManager: deps.stateManager ?? getStateManager() as unknown as HandoffStateManager,
        getOctokit,
        inspectLiveness: deps.inspectLiveness ?? (taskId => inspectTaskContainerLivenessForTask(taskId)),
        git,
        restoreComments: deps.restoreComments ?? (async (record, comments) => {
            const { owner, repo } = splitHandoffRepository(record.repository);
            await restorePendingComments(comments, {
                repoOwner: owner, repoName: repo, pullRequestNumber: record.pull_request,
                redisClient: resolvedRedis as Parameters<typeof restorePendingComments>[1]['redisClient'],
            });
        }),
        withdrawRestoredComments: deps.withdrawRestoredComments ?? (async (record, comments) => {
            const { owner, repo } = splitHandoffRepository(record.repository);
            await withdrawPendingComments(comments.map(comment => comment.id), {
                repoOwner: owner, repoName: repo, pullRequestNumber: record.pull_request,
                redisClient: resolvedRedis as Parameters<typeof withdrawPendingComments>[1]['redisClient'],
            });
        }),
        scheduleRestoredComments: deps.scheduleRestoredComments ?? queueRestoredCommentFollowup,
        taskStates: deps.taskStates ?? {
            COMPLETED: TaskStates.COMPLETED, FAILED: TaskStates.FAILED, CANCELLED: TaskStates.CANCELLED,
        },
        heartbeatIntervalMs: deps.heartbeatIntervalMs,
    };
}

/**
 * The agent container found for the task must be the one the handoff bound at
 * launch. A different or additional container under the same task label is
 * ambiguous evidence, so recovery fails closed instead of trusting it.
 */
export function containerIdentityConflict(
    record: Pick<FollowupHandoffRecord, 'container_id'>,
    inspection: TaskContainerInspection,
): string | null {
    if (!record.container_id || !inspection.container) return null;
    return inspection.container.id === record.container_id ? null : 'container_identity_mismatch';
}

export async function recordFailedClosed(
    record: FollowupHandoffRecord,
    deps: Pick<ResolvedRecoveryDeps, 'store' | 'log'>,
    reason = 'liveness_unavailable',
): Promise<void> {
    deps.log.warn({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request, reason, holdReason: record.status_reason },
        'Agent container evidence is unavailable or ambiguous; failing closed and leaving the handoff untouched');
    // An operator hold's reason is its classification: it decides whether the
    // hold can be released automatically or resumed without authorization, so
    // a probe that merely could not read a long-gone container must not
    // overwrite it. publication_failed likewise protects ownership by a queued
    // retry. The warning above carries the diagnostic instead.
    if (record.status === HANDOFF_AWAITING_OPERATOR || record.status_reason === 'publication_failed') return;
    if (record.status_reason !== reason) {
        // Diagnostic only: this runs without the PR lease, so it must not
        // advance the generation and invalidate a live owner's checkpoints.
        await recordFollowupHandoffDiagnostic(deps.store, record, reason);
    }
}
