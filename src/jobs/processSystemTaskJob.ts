import { Job } from 'bullmq';
import { simpleGit } from 'simple-git';
import { logger, getUserWhitelist, verifyAuthToken } from '@propr/core';
import { getAuthenticatedOctokit } from '@propr/core';
import { ensureRepoCloned, createWorktreeFromExistingBranch, getRepoUrl, cleanupWorktree } from '@propr/core';
import type { SystemTaskJobData, JobResult } from '@propr/core';

interface IssueComment {
    id: number;
}

/**
 * Process system tasks like reverting commits and cleaning up comments.
 * This job is purely deterministic and does not use the LLM agent.
 */
export async function processSystemTaskJob(job: Job<SystemTaskJobData>): Promise<JobResult> {
    const { repoName, prBranch, commitHash, targetCommentId, owner, prNumber, correlationId, requestingUser, authToken } = job.data;
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

    // Authorization: verify requesting user is in the whitelist (fail-closed for destructive operations)
    const whitelist = getUserWhitelist();
    if (whitelist.length === 0) {
        correlatedLogger.warn('System task rejected: user whitelist is not configured');
        throw new Error('Unauthorized: user whitelist is not configured — destructive operations require an explicit allowlist');
    }
    if (!whitelist.includes(requestingUser)) {
        correlatedLogger.warn({ requestingUser }, 'System task rejected: user not in whitelist');
        throw new Error(`Unauthorized: user '${requestingUser}' is not allowed to perform system tasks`);
    }

    // Authorization: verify HMAC auth token (covers all payload fields + timestamp for replay resistance)
    if (!authToken) {
        correlatedLogger.warn({ requestingUser }, 'System task rejected: missing auth token');
        throw new Error('Unauthorized: missing system task auth token');
    }
    const tokenResult = verifyAuthToken(job.data, process.env.SYSTEM_TASK_SECRET);
    if (!tokenResult.valid) {
        correlatedLogger.warn({ requestingUser, reason: tokenResult.reason }, 'System task rejected: auth token verification failed');
        throw new Error(`Unauthorized: system task auth token invalid — ${tokenResult.reason}`);
    }

    let worktreePath: string | undefined;
    let localRepoPath: string | undefined;

    try {
        // 1. Git Hard Reset (Revert Code)
        correlatedLogger.info('Starting git hard reset...');

        const octokit = await getAuthenticatedOctokit();
        const { token } = await octokit.auth({ type: "installation" }) as { token: string };
        const repoUrl = getRepoUrl({ repoOwner: owner, repoName });

        localRepoPath = await ensureRepoCloned({ repoUrl, owner, repoName, authToken: token });

        // Create a worktree from the existing PR branch
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const worktreeInfo = await createWorktreeFromExistingBranch(localRepoPath, prBranch, {
            worktreeDirName: `revert-${prNumber}-${timestamp}`,
            owner,
            repoName
        });
        worktreePath = worktreeInfo.worktreePath;

        const git = simpleGit(worktreePath);

        // Reset to parent of the target commit to drop it and everything after
        await git.reset(['--hard', `${commitHash}^`]);
        correlatedLogger.info({ commitHash }, 'Git reset to parent commit complete');

        // Force push the reset
        const authenticatedUrl = repoUrl.replace('https://', `https://x-access-token:${token}@`);
        await git.push([authenticatedUrl, prBranch, '--force']);
        correlatedLogger.info({ prBranch }, 'Git force push complete');

        // 2. Cascade Comment Deletion (Cleanup Conversation)
        correlatedLogger.info('Starting comment cleanup...');

        // Fetch all comments using paginate (paginate if necessary)
        const comments = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner,
            repo: repoName,
            issue_number: prNumber,
            per_page: 100
        }) as IssueComment[];

        // Find the starting point (the instruction comment that triggered the change)
        const startIndex = comments.findIndex((c: IssueComment) => c.id === Number(targetCommentId));

        if (startIndex !== -1) {
            // Delete the target and EVERYTHING after it
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
                    // Small delay to avoid secondary rate limits
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (deleteError) {
                    correlatedLogger.warn({
                        commentId: comment.id,
                        error: (deleteError as Error).message
                    }, 'Failed to delete comment, continuing...');
                }
            }
            correlatedLogger.info({ count: commentsToDelete.length }, 'Comment cleanup complete');
        } else {
            correlatedLogger.warn({ targetCommentId }, 'Target comment not found in thread');
        }

        correlatedLogger.info({
            jobId: job.id,
            prNumber,
            commitHash
        }, 'System task completed successfully');

        return {
            status: 'complete',
            correlationId,
            revertedCommit: commitHash,
            deletedComments: startIndex !== -1 ? comments.slice(startIndex).length : 0
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
        // Cleanup worktree
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
