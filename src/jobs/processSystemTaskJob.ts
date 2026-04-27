import { Job } from 'bullmq';
import { simpleGit } from 'simple-git';
import { logger, getUserWhitelist, verifyAuthToken } from '@propr/core';
import { getAuthenticatedOctokit } from '@propr/core';
import { ensureRepoCloned, createWorktreeFromExistingBranch, getRepoUrl, cleanupWorktree } from '@propr/core';
import type { SystemTaskJobData, JobResult } from '@propr/core';

interface IssueComment {
    id: number;
}

interface CorrelatedLogger {
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
    error(obj: unknown, msg?: string): void;
    debug(obj: unknown, msg?: string): void;
}

interface ResetAndPushParams {
    owner: string;
    repoName: string;
    prNumber: number;
    prBranch: string;
    commitHash: string;
    headRepoOwner?: string;
    headRepoName?: string;
}

async function performGitResetAndPush(
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
    params: ResetAndPushParams,
    correlatedLogger: CorrelatedLogger
): Promise<{ worktreePath: string; localRepoPath: string }> {
    const { owner, repoName, prNumber, prBranch, commitHash, headRepoOwner, headRepoName } = params;

    const { data: prData } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner, repo: repoName, pull_number: prNumber
    });

    const { targetOwner, targetRepoName } = validatePrHead(
        {
            actualHeadOwner: prData.head.repo?.owner?.login,
            actualHeadName: prData.head.repo?.name,
            isFork: prData.head.repo?.full_name !== prData.base.repo?.full_name
        },
        { owner, repoName, prNumber, headRepoOwner, headRepoName }
    );

    const { token } = await octokit.auth({ type: "installation" }) as { token: string };
    const repoUrl = getRepoUrl({ repoOwner: targetOwner, repoName: targetRepoName });

    const localRepoPath = await ensureRepoCloned({ repoUrl, owner: targetOwner, repoName: targetRepoName, authToken: token });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const worktreeInfo = await createWorktreeFromExistingBranch(localRepoPath, prBranch, {
        worktreeDirName: `revert-${prNumber}-${timestamp}`,
        owner: targetOwner,
        repoName: targetRepoName
    });
    const worktreePath = worktreeInfo.worktreePath;

    const git = simpleGit(worktreePath);

    await git.reset(['--hard', `${commitHash}^`]);
    correlatedLogger.info({ commitHash }, 'Git reset to parent commit complete');

    const authenticatedUrl = repoUrl.replace('https://', `https://x-access-token:${token}@`);
    await git.push([authenticatedUrl, prBranch, '--force']);
    correlatedLogger.info({ prBranch }, 'Git force push complete');

    return { worktreePath, localRepoPath };
}

async function deleteCommentsFromTarget(
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
    params: { owner: string; repoName: string; prNumber: number; targetCommentId: number },
    correlatedLogger: CorrelatedLogger
): Promise<number> {
    const { owner, repoName, prNumber, targetCommentId } = params;

    const comments = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner,
        repo: repoName,
        issue_number: prNumber,
        per_page: 100
    }) as IssueComment[];

    const startIndex = comments.findIndex((c: IssueComment) => c.id === targetCommentId);

    if (startIndex === -1) {
        correlatedLogger.warn({ targetCommentId }, 'Target comment not found in thread');
        return 0;
    }

    const commentsToDelete = comments.slice(startIndex);
    correlatedLogger.info({ count: commentsToDelete.length }, 'Deleting comments');

    for (const comment of commentsToDelete) {
        try {
            await octokit.request('DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                owner,
                repo: repoName,
                comment_id: comment.id
            });
            correlatedLogger.debug({ commentId: comment.id }, 'Deleted comment');
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (deleteError) {
            correlatedLogger.warn({
                commentId: comment.id,
                error: (deleteError as Error).message
            }, 'Failed to delete comment, continuing...');
        }
    }
    correlatedLogger.info({ count: commentsToDelete.length }, 'Comment cleanup complete');
    return commentsToDelete.length;
}

function verifyWhitelist(requestingUser: string, correlatedLogger: CorrelatedLogger): void {
    const whitelist = getUserWhitelist();
    if (whitelist.length === 0) {
        correlatedLogger.warn('System task rejected: user whitelist is not configured');
        throw new Error('Unauthorized: user whitelist is not configured — destructive operations require an explicit allowlist');
    }
    if (!whitelist.includes(requestingUser)) {
        correlatedLogger.warn({ requestingUser }, 'System task rejected: user not in whitelist');
        throw new Error(`Unauthorized: user '${requestingUser}' is not allowed to perform system tasks`);
    }
}

function verifyToken(jobData: SystemTaskJobData, correlatedLogger: CorrelatedLogger): void {
    if (!jobData.authToken) {
        correlatedLogger.warn({ requestingUser: jobData.requestingUser }, 'System task rejected: missing auth token');
        throw new Error('Unauthorized: missing system task auth token');
    }
    const tokenResult = verifyAuthToken(jobData, process.env.SYSTEM_TASK_SECRET);
    if (!tokenResult.valid) {
        correlatedLogger.warn({ requestingUser: jobData.requestingUser, reason: tokenResult.reason }, 'System task rejected: auth token verification failed');
        throw new Error(`Unauthorized: system task auth token invalid — ${tokenResult.reason}`);
    }
}

interface PrHeadInfo {
    actualHeadOwner: string | undefined;
    actualHeadName: string | undefined;
    isFork: boolean;
}

function validatePrHead(
    prHead: PrHeadInfo,
    jobData: { owner: string; repoName: string; prNumber: number; headRepoOwner?: string; headRepoName?: string }
): { targetOwner: string; targetRepoName: string } {
    const { actualHeadOwner, actualHeadName, isFork } = prHead;
    const { owner, repoName, prNumber, headRepoOwner, headRepoName } = jobData;

    if (isFork) {
        if (!headRepoOwner || !headRepoName) {
            throw new Error(
                `Unauthorized: PR #${prNumber} is a fork PR (head: ${actualHeadOwner}/${actualHeadName}) ` +
                `but job payload does not include headRepoOwner/headRepoName. Re-queue with fork-aware payload.`
            );
        }
        if (headRepoOwner !== actualHeadOwner || headRepoName !== actualHeadName) {
            throw new Error(
                `Unauthorized: PR head repo mismatch — job claims ${headRepoOwner}/${headRepoName} ` +
                `but PR head is ${actualHeadOwner}/${actualHeadName}.`
            );
        }
        return { targetOwner: headRepoOwner, targetRepoName: headRepoName };
    }

    if (actualHeadOwner !== owner || actualHeadName !== repoName) {
        throw new Error(
            `Unauthorized: PR head repo mismatch — expected ${owner}/${repoName} ` +
            `but found ${actualHeadOwner}/${actualHeadName}.`
        );
    }
    return { targetOwner: owner, targetRepoName: repoName };
}

/**
 * Process system tasks like reverting commits and cleaning up comments.
 * This job is purely deterministic and does not use the LLM agent.
 */
export async function processSystemTaskJob(job: Job<SystemTaskJobData>): Promise<JobResult> {
    const { repoName, prBranch, commitHash, targetCommentId, owner, prNumber, correlationId, requestingUser, headRepoOwner, headRepoName } = job.data;
    const correlatedLogger = logger.withCorrelation(correlationId);

    correlatedLogger.info({
        jobId: job.id,
        type: job.data.type,
        repoName,
        prNumber,
        commitHash,
        targetCommentId,
        requestingUser
    }, 'Starting system task processing');

    if (job.data.type !== 'revert') {
        throw new Error(`Unknown system task type: ${job.data.type}`);
    }

    verifyWhitelist(requestingUser, correlatedLogger);
    verifyToken(job.data, correlatedLogger);

    let worktreePath: string | undefined;
    let localRepoPath: string | undefined;

    try {
        const octokit = await getAuthenticatedOctokit();

        correlatedLogger.info('Starting git hard reset...');
        const resetResult = await performGitResetAndPush(
            octokit,
            { owner, repoName, prNumber, prBranch, commitHash, headRepoOwner, headRepoName },
            correlatedLogger
        );
        worktreePath = resetResult.worktreePath;
        localRepoPath = resetResult.localRepoPath;

        correlatedLogger.info('Starting comment cleanup...');
        const deletedComments = await deleteCommentsFromTarget(
            octokit,
            { owner, repoName, prNumber, targetCommentId },
            correlatedLogger
        );

        correlatedLogger.info({
            jobId: job.id,
            prNumber,
            commitHash
        }, 'System task completed successfully');

        return {
            status: 'complete',
            correlationId,
            revertedCommit: commitHash,
            deletedComments
        };

    } catch (error) {
        correlatedLogger.error({
            err: error,
            jobId: job.id,
            prNumber,
            commitHash
        }, 'System task failed');
        throw error;
    } finally {
        if (worktreePath && localRepoPath) {
            try {
                await cleanupWorktree(localRepoPath, worktreePath, prBranch);
                correlatedLogger.debug({ worktreePath }, 'Cleaned up worktree');
            } catch (cleanupError) {
                correlatedLogger.warn({
                    worktreePath,
                    error: (cleanupError as Error).message
                }, 'Failed to cleanup worktree');
            }
        }
    }
}

export { processSystemTaskJob as default };
