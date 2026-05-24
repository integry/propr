import logger from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { loadAutoResolveMergeConflicts } from '../config/configManager.js';
import { getIssueQueue } from '../queue/taskQueue.js';
import { getMergeConflictIdempotencyKey } from '../utils/constants.js';
import { generateCorrelationId } from '../utils/logger.js';
import { clearPendingPrQueueJob, markPrQueueJobPending, trackPrQueueJob } from './prQueueJobIndex.js';
import { discardFreshQueueJobAfterMerge, shouldSkipEnqueueForMergedPullRequest } from './mergedPrQueueHelpers.js';
import type { MergeConflictJobData } from '../queue/taskQueue.types.js';
import type { PullRequestEvent, PushEvent } from '@octokit/webhooks-types';
import type { Redis } from 'ioredis';

export type ConflictDetectionOutcome =
    | 'skipped_disabled'
    | 'skipped_clean'
    | 'skipped_draft'
    | 'skipped_merged'
    | 'skipped_duplicate'
    | 'skipped_not_conflicted'
    | 'queued';

export interface ConflictDetectionResult {
    outcome: ConflictDetectionOutcome;
    prNumber: number;
    repository: string;
}

interface PRConflictInfo {
    number: number;
    headBranch: string;
    baseBranch: string;
    headSha: string;
    baseSha: string;
    isDraft: boolean;
    mergeable: boolean | null;
    mergeableState: string;
}

const IDEMPOTENCY_TTL_SECONDS = 24 * 3600; // 24 hours

/**
 * Checks a single PR for merge conflicts and enqueues a resolution job if needed.
 */
async function detectAndEnqueueForPR(
    prInfo: PRConflictInfo,
    options: { owner: string; repoName: string; triggerSource: MergeConflictJobData['triggerSource']; redisClient: Redis; correlationId: string }
): Promise<ConflictDetectionResult> {
    const { owner, repoName, triggerSource, redisClient, correlationId } = options;
    const log = logger.withCorrelation(correlationId);
    const repository = `${owner}/${repoName}`;
    const { number: prNumber } = prInfo;

    // Skip draft PRs
    if (prInfo.isDraft) {
        log.info({ repository, prNumber, outcome: 'skipped_draft' }, 'Merge conflict detection: skipping draft PR');
        return { outcome: 'skipped_draft', prNumber, repository };
    }

    // Check if PR is actually conflicted
    const isConflicted = prInfo.mergeable === false || prInfo.mergeableState === 'dirty';
    if (!isConflicted) {
        log.debug({ repository, prNumber, mergeable: prInfo.mergeable, mergeableState: prInfo.mergeableState, outcome: 'skipped_not_conflicted' }, 'Merge conflict detection: PR is not conflicted');
        return { outcome: 'skipped_not_conflicted', prNumber, repository };
    }

    // Check idempotency: same PR + head SHA + base SHA already queued?
    const idempotencyKey = getMergeConflictIdempotencyKey({ owner, repo: repoName, prNumber, headSha: prInfo.headSha, baseSha: prInfo.baseSha });
    const alreadyQueued = await redisClient.get(idempotencyKey);
    if (alreadyQueued) {
        log.info({ repository, prNumber, headSha: prInfo.headSha, baseSha: prInfo.baseSha, outcome: 'skipped_duplicate' }, 'Merge conflict detection: already queued for this conflict state');
        return { outcome: 'skipped_duplicate', prNumber, repository };
    }

    // Enqueue the merge conflict resolution job
    const jobCorrelationId = generateCorrelationId();
    const jobData: MergeConflictJobData = {
        pullRequestNumber: prNumber,
        repoOwner: owner,
        repoName,
        headBranch: prInfo.headBranch,
        baseBranch: prInfo.baseBranch,
        headSha: prInfo.headSha,
        baseSha: prInfo.baseSha,
        triggerSource,
        correlationId: jobCorrelationId,
        systemGenerated: true,
    };

    const jobId = `merge-conflict-${owner}-${repoName}-${prNumber}-${Date.now()}`;
    const queue = await getIssueQueue();
    if (await shouldSkipEnqueueForMergedPullRequest({
        redisClient,
        repository,
        prNumber,
        log,
        mergedMessage: 'Merge conflict detection: skipping enqueue because PR is already merged',
        lookupFailureMessage: 'Merge conflict detection: failed to verify PR merge state before enqueue; continuing',
    })) {
        return { outcome: 'skipped_merged', prNumber, repository };
    }

    await markPrQueueJobPending(queue as never, repository, prNumber, jobId);
    let queuedJob;
    try {
        queuedJob = await queue.add('processMergeConflict', jobData, { jobId });
    } catch (error) {
        await clearPendingPrQueueJob(queue as never, repository, prNumber, jobId);
        throw error;
    }
    if (await shouldSkipEnqueueForMergedPullRequest({
        redisClient,
        repository,
        prNumber,
        log,
        mergedMessage: 'Merge conflict detection: PR merged during enqueue; discarding freshly-queued job',
        lookupFailureMessage: 'Merge conflict detection: failed to verify PR merge state after enqueue; leaving queued job in place',
    })) {
        await discardFreshQueueJobAfterMerge({
            queuedJob,
            queue: queue as never,
            redisClient,
            repository,
            prNumber,
            jobId,
            log,
            taskIds: [jobId, `${owner}-${repoName}-${prNumber}`],
            removedMessage: 'Merge conflict detection: removed freshly-queued job because PR merged during enqueue',
            removalFailureMessage: 'Merge conflict detection: failed to remove freshly-queued job after merge; set abort signals instead',
            pendingIndexClearFailureMessage: 'Merge conflict detection: failed to clear pending PR queue-job index entry after merge',
            trackFailureMessage: 'Merge conflict detection: failed to move merged PR job into the tracked queue-job index',
        });
        return { outcome: 'skipped_merged', prNumber, repository };
    }

    try {
        await trackPrQueueJob(queue as never, repository, prNumber, jobId);
    } catch (error) {
        log.warn({ repository, prNumber, jobId, error: (error as Error).message }, 'Merge conflict detection: failed to update PR queue-job index');
    }

    // Mark as queued in Redis
    await redisClient.setex(idempotencyKey, IDEMPOTENCY_TTL_SECONDS, Date.now().toString());

    log.info({
        repository,
        prNumber,
        headBranch: prInfo.headBranch,
        baseBranch: prInfo.baseBranch,
        headSha: prInfo.headSha,
        baseSha: prInfo.baseSha,
        triggerSource,
        jobId,
        outcome: 'queued',
    }, 'Merge conflict detection: enqueued conflict resolution job');

    return { outcome: 'queued', prNumber, repository };
}

/**
 * Fetches PR details including mergeable status from GitHub.
 * GitHub may return null for mergeable if it hasn't computed it yet,
 * so we retry briefly to allow the computation to complete.
 */
async function fetchPRConflictInfo(
    owner: string,
    repoName: string,
    prNumber: number
): Promise<PRConflictInfo | null> {
    const octokit = await getAuthenticatedOctokit();

    // GitHub sometimes needs time to compute mergeable status; retry up to 3 times
    for (let attempt = 0; attempt < 3; attempt++) {
        const { data: pr } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner,
            repo: repoName,
            pull_number: prNumber,
        });

        if (pr.state !== 'open') return null;

        if (pr.mergeable !== null) {
            return {
                number: pr.number,
                headBranch: pr.head.ref,
                baseBranch: pr.base.ref,
                headSha: pr.head.sha,
                baseSha: pr.base.sha,
                isDraft: pr.draft ?? false,
                mergeable: pr.mergeable,
                mergeableState: (pr as Record<string, unknown>).mergeable_state as string ?? 'unknown',
            };
        }

        // Wait briefly for GitHub to compute mergeable status
        if (attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    // If mergeable is still null after retries, return what we have
    const { data: pr } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner,
        repo: repoName,
        pull_number: prNumber,
    });

    if (pr.state !== 'open') return null;

    return {
        number: pr.number,
        headBranch: pr.head.ref,
        baseBranch: pr.base.ref,
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        isDraft: pr.draft ?? false,
        mergeable: pr.mergeable,
        mergeableState: (pr as Record<string, unknown>).mergeable_state as string ?? 'unknown',
    };
}

export interface HandleMergeCommandOptions {
    owner: string;
    repoName: string;
    prNumber: number;
    redisClient: Redis;
    correlationId: string;
}

/**
 * Handles a /merge comment on a PR by enqueuing a merge conflict resolution job.
 * This bypasses the auto_resolve_merge_conflicts setting since the user explicitly requested it.
 * Unlike automatic detection, this does not check if the PR is actually conflicted —
 * it will perform the merge regardless (clean or with conflicts).
 */
export async function handleMergeCommand(
    options: HandleMergeCommandOptions
): Promise<ConflictDetectionResult | null> {
    const { owner, repoName, prNumber, correlationId } = options;
    const log = logger.withCorrelation(correlationId);
    const repository = `${owner}/${repoName}`;

    const octokit = await getAuthenticatedOctokit();
    const { data: pr } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner,
        repo: repoName,
        pull_number: prNumber,
    });

    if (pr.state !== 'open') {
        log.info({ repository, prNumber }, '/merge command: PR is not open, skipping');
        return null;
    }

    const jobCorrelationId = generateCorrelationId();
    const jobData: MergeConflictJobData = {
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
    if (await shouldSkipEnqueueForMergedPullRequest({
        redisClient: options.redisClient,
        repository,
        prNumber,
        log,
        mergedMessage: '/merge command: PR already merged, skipping',
        lookupFailureMessage: '/merge command: failed to verify PR merge state before enqueue; continuing',
    })) {
        return null;
    }

    await markPrQueueJobPending(queue as never, repository, prNumber, jobId);
    let queuedJob;
    try {
        queuedJob = await queue.add('processMergeConflict', jobData, { jobId });
    } catch (error) {
        await clearPendingPrQueueJob(queue as never, repository, prNumber, jobId);
        throw error;
    }
    if (await shouldSkipEnqueueForMergedPullRequest({
        redisClient: options.redisClient,
        repository,
        prNumber,
        log,
        mergedMessage: '/merge command: PR merged during enqueue; discarding freshly-queued job',
        lookupFailureMessage: '/merge command: failed to verify PR merge state after enqueue; leaving queued job in place',
    })) {
        await discardFreshQueueJobAfterMerge({
            queuedJob,
            queue: queue as never,
            redisClient: options.redisClient,
            repository,
            prNumber,
            jobId,
            log,
            taskIds: [jobId, `${owner}-${repoName}-${prNumber}`],
            removedMessage: '/merge command: removed freshly-queued job because the PR merged during enqueue',
            removalFailureMessage: '/merge command: failed to remove freshly-queued job after merge; set abort signals instead',
            pendingIndexClearFailureMessage: 'Merge conflict detection: failed to clear pending PR queue-job index entry after merge',
            trackFailureMessage: 'Merge conflict detection: failed to move merged PR job into the tracked queue-job index',
        });
        return null;
    }

    try {
        await trackPrQueueJob(queue as never, repository, prNumber, jobId);
    } catch (error) {
        log.warn({ repository, prNumber, jobId, error: (error as Error).message }, '/merge command: failed to update PR queue-job index');
    }

    log.info({
        repository,
        prNumber,
        headBranch: pr.head.ref,
        baseBranch: pr.base.ref,
        jobId,
        outcome: 'queued',
    }, '/merge command: enqueued merge job');

    return { outcome: 'queued', prNumber, repository };
}

/**
 * Handles pull_request events that could indicate a new merge conflict.
 * Triggers: opened, reopened, synchronize, ready_for_review
 */
export async function handlePullRequestConflictDetection(
    payload: PullRequestEvent,
    redisClient: Redis,
    correlationId: string
): Promise<ConflictDetectionResult | null> {
    const log = logger.withCorrelation(correlationId);
    const action = payload.action;

    const relevantActions = ['opened', 'reopened', 'synchronize', 'ready_for_review'];
    if (!relevantActions.includes(action)) return null;

    // Check feature flag
    const enabled = await loadAutoResolveMergeConflicts();
    if (!enabled) {
        const [owner, repoName] = payload.repository.full_name.split('/');
        log.info({ repository: payload.repository.full_name, prNumber: payload.pull_request.number, outcome: 'skipped_disabled' }, 'Merge conflict detection: feature disabled');
        return { outcome: 'skipped_disabled', prNumber: payload.pull_request.number, repository: `${owner}/${repoName}` };
    }

    const [owner, repoName] = payload.repository.full_name.split('/');
    const prNumber = payload.pull_request.number;

    const prInfo = await fetchPRConflictInfo(owner, repoName, prNumber);
    if (!prInfo) {
        log.debug({ repository: payload.repository.full_name, prNumber }, 'Merge conflict detection: PR not open, skipping');
        return null;
    }

    return detectAndEnqueueForPR(prInfo, { owner, repoName, triggerSource: 'pull_request', redisClient, correlationId });
}

/**
 * Handles push events by checking all open PRs targeting the pushed branch.
 * When a base branch receives new commits, open PRs against it may become conflicted.
 */
export async function handlePushConflictDetection(
    payload: PushEvent,
    redisClient: Redis,
    correlationId: string
): Promise<ConflictDetectionResult[]> {
    const log = logger.withCorrelation(correlationId);
    const [owner, repoName] = payload.repository.full_name.split('/');
    const repository = `${owner}/${repoName}`;

    // Check feature flag
    const enabled = await loadAutoResolveMergeConflicts();
    if (!enabled) {
        log.info({ repository, outcome: 'skipped_disabled' }, 'Merge conflict detection: feature disabled');
        return [];
    }

    // Extract branch name from ref (refs/heads/main -> main)
    const ref = payload.ref;
    if (!ref.startsWith('refs/heads/')) return [];
    const branchName = ref.replace('refs/heads/', '');

    log.info({ repository, branchName }, 'Merge conflict detection: checking open PRs targeting pushed branch');

    // Find all open PRs targeting this branch
    const octokit = await getAuthenticatedOctokit();
    const { data: openPRs } = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
        owner,
        repo: repoName,
        state: 'open',
        base: branchName,
        per_page: 100,
    });

    if (openPRs.length === 0) {
        log.debug({ repository, branchName }, 'Merge conflict detection: no open PRs targeting this branch');
        return [];
    }

    log.info({ repository, branchName, prCount: openPRs.length }, 'Merge conflict detection: found open PRs to check');

    const results: ConflictDetectionResult[] = [];
    for (const pr of openPRs) {
        try {
            const prInfo = await fetchPRConflictInfo(owner, repoName, pr.number);
            if (!prInfo) continue;

            const result = await detectAndEnqueueForPR(prInfo, { owner, repoName, triggerSource: 'push', redisClient, correlationId });
            results.push(result);
        } catch (error) {
            log.error({ repository, prNumber: pr.number, error: (error as Error).message }, 'Merge conflict detection: error checking PR');
        }
    }

    return results;
}
