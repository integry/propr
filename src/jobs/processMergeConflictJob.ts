import { Job } from 'bullmq';
import type { Logger } from 'pino';
import { logger } from '@propr/core';
import { getAuthenticatedOctokit } from '@propr/core';
import { withRetry, retryConfigs } from '@propr/core';
import { getStateManager, TaskStates } from '@propr/core';
import type { WorkerStateManager } from '@propr/core';
import { getRepoUrl, mergeBaseIntoBranch } from '@propr/core';
import type { WorktreeInfo } from '@propr/core';
import { ensureGitRepository } from '@propr/core';
import { UsageLimitError, AgentRegistry } from '@propr/core';
import type { MergeConflictJobData, JobResult } from '@propr/core';
import { Redis } from 'ioredis';
import { getDefaultModel, NoDefaultModelConfiguredError } from '@propr/core';
import { cleanupWorktree } from '@propr/core';
import {
    fetchMergeTaskPRInfo,
    updateMergeTaskWithKnownPRInfo,
} from './mergeConflictHelpers.js';
import { handleMergeWithAgent } from './mergeConflictAgentRunner.js';
import { resolvePullRequestGitTarget } from './prGitOperations.js';
import type { PullRequestGitTarget } from './prGitOperations.js';
import { PullRequestPublication } from './prPublication.js';
import type { Contribution } from './prContinuation.js';
import { generateSummaryTitle, resolveDefaultAgentAndModel } from './prCommentAgentUtils.js';
import { fetchAllComments } from './prCommentJobUtils.js';
import {
    buildDeterministicPrTaskSubtitle,
    getConflictDiffForTitle,
    buildPrTaskTitle,
    buildPrTaskTitleContext,
    buildPrTaskTitleContextHistoryMetadata,
} from './prTaskTitleHelpers.js';
import type { GitHubToken } from './githubTypes.js';

const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel() || null;
type MergeResult = Awaited<ReturnType<typeof mergeBaseIntoBranch>>;
type MergeTaskPrInfo = { prTitle: string; linkedIssueNumber: number | null };
type LivePullRequest = Contribution & {
    head: Contribution['head'] & { sha: string };
};

const redisClient = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

async function acquireMergeJobLock(
    lockKey: string,
    correlationId: string,
    job: Job<MergeConflictJobData>,
    correlatedLogger: Logger
): Promise<{ acquired: true } | { acquired: false; result: JobResult }> {
    const lockResult = await redisClient.set(lockKey, correlationId, 'EX', 3600, 'NX');
    if (lockResult !== 'OK') {
        const currentLock = await redisClient.get(lockKey);
        if (currentLock !== correlationId) {
            correlatedLogger.info({ lockOwner: currentLock }, 'PR is currently being processed by another job. Rescheduling merge conflict job.');
            const { issueQueue } = await import('@propr/core');
            await issueQueue.add(job.name, job.data, { delay: 10000 });
            return { acquired: false, result: { status: 'rescheduled', reason: 'pr_locked_by_other_job' } };
        }
    }
    return { acquired: true };
}

async function resolveModelForTask(correlatedLogger: Logger): Promise<string> {
    try {
        const registry = AgentRegistry.getInstance();
        await registry.ensureInitialized();
        return (await resolveDefaultAgentAndModel(registry, correlatedLogger)).resolvedModel;
    } catch (error) {
        if (error instanceof NoDefaultModelConfiguredError) throw error;
        correlatedLogger.debug({ error: (error as Error).message }, 'Failed to resolve default agent model for merge task state');
    }
    if (!DEFAULT_MODEL_NAME) {
        throw new NoDefaultModelConfiguredError();
    }
    return DEFAULT_MODEL_NAME;
}


async function handleMergeJobError(error: Error, options: {
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>> | null;
    startingCommentId: number | undefined;
    stateManager: WorkerStateManager;
    taskId: string;
    repoOwner: string; repoName: string;
    baseBranch: string; headBranch: string;
    pullRequestNumber: number;
    correlatedLogger: Logger;
}): Promise<JobResult> {
    const { octokit, startingCommentId, stateManager, taskId, repoOwner, repoName, baseBranch, headBranch, pullRequestNumber, correlatedLogger } = options;
    const errorMessage = error.message || 'Unknown error';
    correlatedLogger.error({ pullRequestNumber, error: errorMessage }, 'Merge conflict resolution job failed');

    await stateManager.updateTaskState(taskId, TaskStates.FAILED, {
        reason: 'Merge conflict resolution failed', error: { message: errorMessage },
    });

    if (octokit && startingCommentId) {
        try {
            await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                owner: repoOwner, repo: repoName, comment_id: startingCommentId,
                body: `❌ **Failed to resolve merge conflicts** from \`${baseBranch}\` into \`${headBranch}\`\n\n\`\`\`\n${errorMessage}\n\`\`\`\n\n---\n_System-triggered merge conflict resolution_`,
            });
        } catch (commentError) {
            correlatedLogger.error({ error: (commentError as Error).message }, 'Failed to post error comment');
        }
    }

    if (!(error instanceof UsageLimitError)) throw error;
    return { status: 'failed', reason: 'merge_conflict_resolution_failed' };
}

async function updateMergeTaskBeforeLocalMerge(options: {
    prInfo: MergeTaskPrInfo | undefined;
    stateManager: WorkerStateManager;
    taskId: string;
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    baseBranch: string;
    headBranch: string;
    correlatedLogger: Logger;
}): Promise<void> {
    const { prInfo, stateManager, taskId, pullRequestNumber, repoOwner, repoName, baseBranch, headBranch, correlatedLogger } = options;
    if (!prInfo) return;
    try {
        await updateMergeTaskWithKnownPRInfo({
            stateManager, taskId, pullRequestNumber, repoOwner, repoName, baseBranch, headBranch,
            correlatedLogger, prTitle: prInfo.prTitle, linkedIssueNumber: prInfo.linkedIssueNumber,
            title: buildPrTaskTitle({ workflow: 'merge', pullRequestNumber, prTitle: prInfo.prTitle }),
            subtitle: buildDeterministicPrTaskSubtitle('merge', { baseBranch, headBranch }),
        });
    } catch (titleError) {
        correlatedLogger.warn({ taskId, error: (titleError as Error).message }, 'Failed to update merge task title before local merge');
    }
}

/**
 * Resolves the repository that actually owns the PR head. Merge work must run in, and
 * push to, that repository: a fork's branch is not the base repository's same-named
 * branch. The live head SHA is returned so the prepared worktree can be verified
 * against the branch GitHub reports for this PR.
 */
async function resolveMergeJobHead(options: {
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    headBranch: string;
    headSha: string;
    correlationId: string;
    correlatedLogger: Logger;
}): Promise<{ target: PullRequestGitTarget; headSha: string; prData: LivePullRequest }> {
    const { octokit, pullRequestNumber, repoOwner, repoName, headBranch, headSha, correlationId, correlatedLogger } = options;
    const prResponse = await withRetry(
        () => octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner: repoOwner, repo: repoName, pull_number: pullRequestNumber,
        }),
        { ...retryConfigs.githubApi, correlationId },
        'get_pull_request_for_merge',
    ) as { data: LivePullRequest };
    const prData = prResponse.data;
    const target = resolvePullRequestGitTarget(prData.head, { repoOwner, repoName });
    if (target.branchName !== headBranch || prData.head.sha !== headSha) {
        // The queued snapshot may be stale; the live head decides what gets merged.
        correlatedLogger.info({
            pullRequestNumber, queuedHeadBranch: headBranch, queuedHeadSha: headSha,
            headBranch: target.branchName, headSha: prData.head.sha,
        }, 'Merge job head moved since the job was queued; using the live pull request head');
    }
    if (target.isFork) {
        correlatedLogger.info({
            pullRequestNumber, headRepository: `${target.repoOwner}/${target.repoName}`, headBranch: target.branchName,
        }, 'Merge job head lives in a fork; operating on the fork repository');
    }
    return { target, headSha: prData.head.sha, prData };
}

async function fetchMergeTitleContextInfo(options: {
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    taskId: string;
    prData: LivePullRequest;
    correlatedLogger: Logger;
}): Promise<{ prInfo: MergeTaskPrInfo | undefined; prDescription: string | null | undefined; recentComments: Awaited<ReturnType<typeof fetchAllComments>> }> {
    const { octokit, pullRequestNumber, repoOwner, repoName, taskId, prData, correlatedLogger } = options;
    let prInfo: MergeTaskPrInfo | undefined;
    let recentComments: Awaited<ReturnType<typeof fetchAllComments>> = [];

    try {
        prInfo = await fetchMergeTaskPRInfo({ octokit, pullRequestNumber, repoOwner, repoName });
    } catch (prError) {
        correlatedLogger.warn({ taskId, error: (prError as Error).message }, 'Failed to fetch PR info for merge task');
    }
    prInfo ??= { prTitle: prData.title || 'Untitled pull request', linkedIssueNumber: null };
    try {
        recentComments = await fetchAllComments(octokit, repoOwner, repoName, pullRequestNumber);
    } catch (commentsError) {
        correlatedLogger.warn({ taskId, error: (commentsError as Error).message }, 'Failed to fetch recent comments for merge task title context');
    }

    return { prInfo, prDescription: prData.body ?? null, recentComments };
}

async function updateMergeTaskAfterLocalMerge(options: {
    mergeResult: MergeResult;
    mergeTitleInfo: MergeTaskPrInfo;
    prDescription: string | null | undefined;
    recentComments: Awaited<ReturnType<typeof fetchAllComments>>;
    worktreeInfo: WorktreeInfo;
    githubToken: GitHubToken;
    stateManager: WorkerStateManager;
    taskId: string;
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    baseBranch: string;
    headBranch: string;
    correlationId: string;
    correlatedLogger: Logger;
}): Promise<void> {
    const { mergeResult, mergeTitleInfo, prDescription, recentComments, worktreeInfo, githubToken, stateManager,
        taskId, pullRequestNumber, repoOwner, repoName, baseBranch, headBranch, correlationId, correlatedLogger } = options;
    const hasConflictedFiles = (mergeResult.conflictedFiles?.length ?? 0) > 0;

    const fallbackSubtitle = buildDeterministicPrTaskSubtitle('merge', { baseBranch, headBranch });
    let subtitle = fallbackSubtitle;
    let titleContextMetadata: Record<string, unknown> | undefined;
    if (hasConflictedFiles) {
        try {
            const conflictDiff = await getConflictDiffForTitle(worktreeInfo.worktreePath, mergeResult.conflictedFiles);
            const titleContext = buildPrTaskTitleContext({
                workflow: 'merge',
                pullRequestNumber,
                prTitle: mergeTitleInfo.prTitle,
                recentComments,
                prDescription,
                mergeConflictDiff: conflictDiff,
            });
            titleContextMetadata = buildPrTaskTitleContextHistoryMetadata(titleContext);
            subtitle = titleContext.hasMeaningfulContext ? await generateSummaryTitle({
                combinedCommentBody: '', titleContext: titleContext.context, fallbackSubtitle, worktreeInfo, githubToken,
                pullRequestNumber, prTitle: mergeTitleInfo.prTitle, workflowLabel: 'Merge', repoOwner, repoName,
                correlationId, taskId, correlatedLogger,
            }) : fallbackSubtitle;
        } catch (subtitleError) {
            correlatedLogger.warn({ taskId, error: (subtitleError as Error).message }, 'Failed to generate merge task subtitle from conflict diff');
        }
    }
    try {
        await updateMergeTaskWithKnownPRInfo({
            stateManager, taskId, pullRequestNumber, repoOwner, repoName, baseBranch, headBranch,
            correlatedLogger, prTitle: mergeTitleInfo.prTitle,
            linkedIssueNumber: mergeTitleInfo.linkedIssueNumber,
            title: buildPrTaskTitle({ workflow: 'merge', pullRequestNumber, prTitle: mergeTitleInfo.prTitle }),
            subtitle,
            titleContextMetadata,
        });
    } catch (titleError) {
        correlatedLogger.warn({ taskId, error: (titleError as Error).message }, 'Failed to update merge task subtitle from conflict diff');
    }
}

async function mergeBaseIntoTarget(options: {
    worktreePath: string;
    baseBranch: string;
    target: PullRequestGitTarget;
    repoOwner: string;
    repoName: string;
    githubToken: GitHubToken;
}): Promise<MergeResult & { baseCommit: string }> {
    const { worktreePath, baseBranch, target, repoOwner, repoName, githubToken } = options;
    const mergeResult = await mergeBaseIntoBranch(worktreePath, baseBranch, target.isFork
        ? { baseRepoUrl: getRepoUrl({ repoOwner, repoName }), authToken: githubToken.token }
        : {});

    if (mergeResult.outcome === 'failed') {
        throw new Error(`Merge failed: ${mergeResult.error}`);
    }
    if (!mergeResult.baseCommit) {
        throw new Error(`Merge did not identify the fetched base commit for ${baseBranch}`);
    }
    return { ...mergeResult, baseCommit: mergeResult.baseCommit };
}

async function releaseMergeJobResources(options: {
    lockKey: string;
    correlationId: string;
    localRepoPath: string | undefined;
    worktreeInfo: WorktreeInfo | undefined;
    jobSucceeded: boolean;
    correlatedLogger: Logger;
}): Promise<void> {
    const { lockKey, correlationId, localRepoPath, worktreeInfo, jobSucceeded, correlatedLogger } = options;
    const lockOwner = await redisClient.get(lockKey);
    if (lockOwner === correlationId) {
        await redisClient.del(lockKey);
    }

    if (localRepoPath && worktreeInfo) {
        try {
            await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, { deleteBranch: false, success: jobSucceeded });
        } catch (cleanupError) {
            correlatedLogger.warn({ error: (cleanupError as Error).message }, 'Failed to cleanup worktree');
        }
    }
}

/**
 * Processes a merge conflict resolution job.
 * This job:
 * 1. Creates a worktree from the PR head branch
 * 2. Merges the base branch into it (git leaves conflict markers if any)
 * 3. Always invokes the AI agent to verify/resolve the merge
 * 4. Commits and pushes the result
 * 5. Posts GitHub comments about the outcome
 */
export async function processMergeConflictJob(job: Job<MergeConflictJobData>): Promise<JobResult> {
    const { pullRequestNumber, repoOwner, repoName, headBranch, baseBranch, headSha, baseSha, triggerSource, correlationId } = job.data;
    const correlatedLogger = logger.withCorrelation(correlationId);

    correlatedLogger.info({
        pullRequestNumber, headBranch, baseBranch, headSha, baseSha, triggerSource,
    }, 'Processing merge conflict resolution job');

    const taskId = job.id || `merge-conflict-${pullRequestNumber}-${Date.now()}`;
    const stateManager = getStateManager();
    const lockKey = `lock:pr:${repoOwner}:${repoName}:${pullRequestNumber}`;

    const lockStatus = await acquireMergeJobLock(lockKey, correlationId, job, correlatedLogger);
    if (!lockStatus.acquired) return lockStatus.result;

    const modelName = await resolveModelForTask(correlatedLogger);

    try {
        await stateManager.createTaskState(taskId, {
            number: pullRequestNumber, repoOwner, repoName, modelName,
            type: 'merge_conflict', pullRequestNumber,
        } as unknown as Parameters<typeof stateManager.createTaskState>[1], correlationId, String(job.id ?? taskId));
    } catch (stateError) {
        correlatedLogger.warn({ taskId, error: (stateError as Error).message }, 'Failed to create initial task state');
    }

    let localRepoPath: string | undefined;
    let worktreeInfo: WorktreeInfo | undefined;
    let octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>> | null = null;
    let startingCommentId: number | undefined;
    let prInfo: MergeTaskPrInfo | undefined;
    let prDescription: string | null | undefined;
    let recentComments: Awaited<ReturnType<typeof fetchAllComments>> = [];
    let target: PullRequestGitTarget | undefined;
    let publication: PullRequestPublication | undefined;
    let jobSucceeded = false;

    try {
        octokit = await withRetry(() => getAuthenticatedOctokit(), { ...retryConfigs.githubApi, correlationId }, 'get_authenticated_octokit');
        const githubToken = await octokit.auth({ type: "installation" }) as GitHubToken;

        const startingComment = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner, repo: repoName, issue_number: pullRequestNumber,
            body: `🔀 **Auto-resolving merge conflicts** — merging \`${baseBranch}\` into \`${headBranch}\`\n\nThis is a system-triggered action to keep the PR branch up to date.`,
        });
        startingCommentId = (startingComment as { data: { id: number } }).data.id;

        const head = await resolveMergeJobHead({
            octokit, pullRequestNumber, repoOwner, repoName, headBranch, headSha, correlationId, correlatedLogger,
        });
        target = head.target;
        publication = new PullRequestPublication(octokit, {
            repoOwner, repoName, pullRequestNumber,
        }, head.prData);

        ({ prInfo, prDescription, recentComments } = await fetchMergeTitleContextInfo({
            octokit, pullRequestNumber, repoOwner, repoName, taskId, prData: head.prData, correlatedLogger,
        }));
        await updateMergeTaskBeforeLocalMerge({
            prInfo, stateManager, taskId, pullRequestNumber, repoOwner, repoName, baseBranch,
            headBranch: target.branchName, correlatedLogger,
        });

        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Starting merge conflict resolution' });
        await ensureGitRepository(correlatedLogger);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        ({ localRepoPath, worktreeInfo } = await publication.prepare(`pr-${pullRequestNumber}-merge-${timestamp}`));
        target = publication.target;

        correlatedLogger.info({
            worktreePath: worktreeInfo.worktreePath, branchName: worktreeInfo.branchName,
            headRepository: `${target.repoOwner}/${target.repoName}`,
        }, 'Created worktree for merge conflict resolution');

        const mergeResult = await mergeBaseIntoTarget({
            worktreePath: worktreeInfo.worktreePath, baseBranch, target, repoOwner, repoName, githubToken,
        });

        if ((mergeResult.conflictedFiles?.length ?? 0) > 0 || prInfo) {
            await updateMergeTaskAfterLocalMerge({
                mergeResult,
                mergeTitleInfo: prInfo ?? { prTitle: 'Untitled pull request', linkedIssueNumber: null },
                prDescription,
                recentComments,
                worktreeInfo,
                githubToken,
                stateManager,
                taskId,
                pullRequestNumber,
                repoOwner,
                repoName,
                baseBranch,
                headBranch: target.branchName,
                correlationId,
                correlatedLogger,
            });
        }

        const result = await handleMergeWithAgent({
            conflictedFiles: mergeResult.conflictedFiles,
            worktreeInfo, publication, baseBranch, baseCommit: mergeResult.baseCommit,
            pullRequestNumber, repoOwner, repoName,
            githubToken, octokit, startingCommentId,
            stateManager, taskId, correlationId, correlatedLogger, redisClient,
        });
        jobSucceeded = result.status === 'complete';
        return result;

    } catch (error) {
        return await handleMergeJobError(error as Error, {
            octokit, startingCommentId, stateManager, taskId,
            repoOwner, repoName, baseBranch, headBranch: publication?.target.branchName ?? target?.branchName ?? headBranch,
            pullRequestNumber, correlatedLogger,
        });
    } finally {
        await releaseMergeJobResources({ lockKey, correlationId, localRepoPath, worktreeInfo, jobSucceeded, correlatedLogger });
    }
}
