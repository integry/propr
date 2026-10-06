import logger from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { getIssueQueue } from '../queue/taskQueue.js';
import { generateCorrelationId } from '../utils/logger.js';
import type { MergeConflictJobData } from '../queue/taskQueue.types.js';
import type { PullRequestEvent, PushEvent } from '@octokit/webhooks-types';
import { isRescueRef } from '../git/rescueRefs.js';
import { loadEffectiveAutoResolveMergeConflicts } from '../config/mergeConflictSettings.js';
import {
    evaluateOpenPullRequests,
    isProprManagedPullRequest,
    maybeQueueConflictResolution,
    normalizeLabelNames,
    type ConflictDetectionResult,
    type MergeConflictDetectionDeps,
    type MergeConflictRedis,
} from './mergeConflictAutoResolve.js';

export type { ConflictDetectionResult, ConflictSkipReason } from './mergeConflictAutoResolve.js';
export type ConflictDetectionOutcome = ConflictDetectionResult['outcome'];

export interface HandleMergeCommandOptions {
    owner: string;
    repoName: string;
    prNumber: number;
    userId?: string;
    redisClient: unknown;
    correlationId: string;
}

/**
 * Handles a /merge comment on a PR by enqueuing a merge conflict resolution job.
 * This is an explicit user command: it never consults the auto-resolve setting,
 * but the PR must still be ProPR-managed. Unlike automatic detection, it does not
 * check whether the PR is conflicted — it merges regardless (clean or with conflicts).
 */
export async function handleMergeCommand(
    options: HandleMergeCommandOptions
): Promise<ConflictDetectionResult | null> {
    const { owner, repoName, prNumber, userId, correlationId } = options;
    const log = logger.withCorrelation(correlationId);
    const repository = `${owner}/${repoName}`;

    const octokit = await getAuthenticatedOctokit();
    const { data: pr } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner,
        repo: repoName,
        pull_number: prNumber,
    });

    if (pr.state !== 'open') {
        log.info({ repository, pullNumber: prNumber, trigger: 'comment', reason: 'pull_request_closed' }, '/merge command: PR is not open, skipping');
        return null;
    }

    // Defense in depth: never enqueue merge work for a PR that was not opted into ProPR.
    if (!await isProprManagedPullRequest({ repository, prNumber, labels: pr.labels })) {
        log.info({ repository, pullNumber: prNumber, trigger: 'comment', reason: 'not_propr_pull_request', labels: normalizeLabelNames(pr.labels) }, '/merge command: PR is not ProPR-managed, skipping');
        return { outcome: 'skipped', reason: 'not_propr_pull_request', prNumber, repository };
    }

    const jobCorrelationId = generateCorrelationId();
    const jobData: MergeConflictJobData = {
        ...(userId ? { userId } : {}),
        pullRequestNumber: prNumber,
        repoOwner: owner,
        repoName,
        headBranch: pr.head.ref,
        baseBranch: pr.base.ref,
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        triggerSource: 'comment',
        correlationId: jobCorrelationId,
        systemGenerated: true,
    };

    const jobId = `merge-conflict-${owner}-${repoName}-${prNumber}-${Date.now()}`;
    const queue = await getIssueQueue();
    await queue.add('processMergeConflict', jobData, { jobId });

    log.info({
        repository,
        pullNumber: prNumber,
        trigger: 'comment',
        headBranch: pr.head.ref,
        baseBranch: pr.base.ref,
        jobId,
        outcome: 'queued',
    }, '/merge command: enqueued merge job');

    return { outcome: 'queued', prNumber, repository, jobId };
}

const RELEVANT_PULL_REQUEST_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);

/**
 * Handles pull_request events that could indicate a new merge conflict.
 * Triggers: opened, reopened, synchronize, ready_for_review
 */
export async function handlePullRequestConflictDetection(
    payload: PullRequestEvent,
    redisClient: MergeConflictRedis,
    correlationId: string,
    deps?: MergeConflictDetectionDeps
): Promise<ConflictDetectionResult | null> {
    if (!RELEVANT_PULL_REQUEST_ACTIONS.has(payload.action)) return null;

    const [owner, repoName] = payload.repository.full_name.split('/');
    return maybeQueueConflictResolution({
        owner,
        repoName,
        prNumber: payload.pull_request.number,
        trigger: 'pull_request',
        redisClient,
        correlationId,
        deps,
    });
}

/**
 * Handles push events by checking open PRs targeting the pushed branch: when a
 * base branch receives new commits (typically another PR merging), open PRs
 * against it may become conflicted without receiving any pull_request event.
 */
export async function handlePushConflictDetection(
    payload: PushEvent,
    redisClient: MergeConflictRedis,
    correlationId: string,
    deps?: MergeConflictDetectionDeps
): Promise<ConflictDetectionResult[]> {
    const log = logger.withCorrelation(correlationId);
    const [owner, repoName] = payload.repository.full_name.split('/');
    const repository = `${owner}/${repoName}`;

    // Push-salvage rescue refs hold rejected work, not task branches.
    if (isRescueRef(payload.ref)) {
        log.debug({ repository, ref: payload.ref }, 'Merge conflict detection: ignoring push salvage rescue ref');
        return [];
    }
    if (!payload.ref.startsWith('refs/heads/') || payload.deleted) return [];
    const branchName = payload.ref.slice('refs/heads/'.length);

    // Evaluate the setting first so disabled repositories cost no GitHub calls.
    const setting = await loadEffectiveAutoResolveMergeConflicts(repository);
    if (!setting.enabled) {
        log.info({ repository, branchName, trigger: 'push', reason: 'auto_resolve_disabled', source: setting.source }, 'Merge conflict auto-resolve skipped: auto_resolve_disabled');
        return [];
    }

    return evaluateOpenPullRequests({
        owner, repoName, baseBranch: branchName, trigger: 'push', redisClient, correlationId, setting, deps,
    });
}
