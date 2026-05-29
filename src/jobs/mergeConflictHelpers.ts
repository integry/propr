import type { Logger } from 'pino';
import type { WorktreeInfo } from '@propr/core';
import type { AutoResolveContext } from '@propr/core';
import { getAuthenticatedOctokit } from '@propr/core';
import type { WorkerStateManager } from '@propr/core';
import { db } from '@propr/core';
import { buildPrTaskTitle } from './prTaskTitleHelpers.js';

/**
 * Builds a prompt that instructs the agent to check for and resolve any merge conflicts
 * after merging the target (base) branch into the PR branch.
 */
export function buildConflictResolutionPrompt(options: {
    pullRequestNumber: number;
    baseBranch: string;
    headBranch: string;
    conflictedFiles?: string[];
    worktreeInfo: WorktreeInfo;
    repoOwner: string;
    repoName: string;
}): string {
    const { pullRequestNumber, baseBranch, headBranch, conflictedFiles, worktreeInfo, repoOwner, repoName } = options;

    const hasKnownConflicts = conflictedFiles && conflictedFiles.length > 0;
    const fileList = hasKnownConflicts ? conflictedFiles.map(f => `- \`${f}\``).join('\n') : '';

    return `You are working on pull request #${pullRequestNumber} after merging \`${baseBranch}\` into \`${headBranch}\`.

**Context:**
The target branch \`${baseBranch}\` was just merged into the PR branch \`${headBranch}\`. ${hasKnownConflicts ? 'Merge conflicts were detected.' : 'The merge may or may not have conflicts.'}

${hasKnownConflicts ? `**Known Conflicted Files:**\n${fileList}\n` : ''}
**Instructions:**
1. Search ALL files for merge conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`).
2. If ANY conflict markers are found in ANY file, resolve them:
   - Preserve the intent of the PR changes while incorporating updates from \`${baseBranch}\`.
   - If both sides modified the same logic, prefer the PR's intent but ensure compatibility.
   - Remove ALL conflict markers after resolving.
3. Verify the code is syntactically correct after resolution.
4. **IMPORTANT:** Provide a detailed summary that includes:
   - What each conflict was about (e.g., "Both branches modified the user validation logic")
   - How you resolved it (e.g., "Combined both changes by keeping the new validation from main while preserving the error messages from the PR")
   - Why you chose this resolution approach

**CRITICAL INSTRUCTIONS:**
- You are in directory: ${worktreeInfo.worktreePath}
- DO NOT commit your changes - the system will handle the commit for you.
- DO NOT create a new pull request.
- The repository is ${repoOwner}/${repoName}.
- Focus ONLY on finding and resolving merge conflicts. Do not make unrelated changes.
- If no conflict markers are found, simply confirm the merge is clean.`;
}

/**
 * Builds a commit message for a merge conflict resolution.
 */
export function buildMergeConflictCommitMessage(options: {
    baseBranch: string;
    headBranch: string;
    pullRequestNumber: number;
    conflictedFiles?: string[];
    model?: string;
    wasCleanMerge: boolean;
}): string {
    const { baseBranch, headBranch, pullRequestNumber, conflictedFiles, model, wasCleanMerge } = options;

    if (wasCleanMerge) {
        return `merge: merge ${baseBranch} into ${headBranch}

Automatically merged target branch into PR branch (clean merge, no conflicts).

PR: #${pullRequestNumber}`;
    }

    const fileList = conflictedFiles && conflictedFiles.length > 0
        ? `\nResolved conflicts in:\n${conflictedFiles.map(f => `- ${f}`).join('\n')}`
        : '';

    return `merge: resolve conflicts from ${baseBranch} into ${headBranch}

Automatically resolved merge conflicts after merging target branch into PR branch.${fileList}

PR: #${pullRequestNumber}
Model: ${model || 'unknown'}`;
}

/**
 * Builds the GitHub comment for a system-triggered merge conflict resolution.
 */
export function buildMergeConflictComment(options: {
    wasCleanMerge: boolean;
    commitHash?: string;
    baseBranch: string;
    headBranch: string;
    conflictedFiles?: string[];
    resolutionSummary?: string | null;
    model?: string;
    executionTimeMs?: number;
    taskUrl?: string;
}): string {
    const { wasCleanMerge, commitHash, baseBranch, headBranch, conflictedFiles, resolutionSummary, model, executionTimeMs, taskUrl } = options;

    const shortHash = commitHash ? commitHash.substring(0, 7) : 'unknown';

    if (wasCleanMerge) {
        let comment = `🔀 **Auto-merged \`${baseBranch}\` into \`${headBranch}\`** (clean merge) in commit ${shortHash}\n\n`;
        comment += `No conflicts were found — the merge was verified by an AI agent.\n`;

        if (model || executionTimeMs) {
            comment += `\n---\n### 🤖 Verification Details\n\n`;
            if (model) comment += `* **Model:** ${model}\n`;
            if (executionTimeMs) {
                const seconds = Math.floor(executionTimeMs / 1000);
                const m = Math.floor(seconds / 60);
                const s = seconds % 60;
                comment += `* **Time:** ${m > 0 ? `${m}m ${s}s` : `${s}s`}\n`;
            }
        }

        if (taskUrl) {
            comment += `\n[View Task Execution](${taskUrl})`;
        }

        comment += `\n\n---\n_System-triggered merge conflict resolution_`;
        return comment;
    }

    let comment = `🔀 **Resolved merge conflicts** from \`${baseBranch}\` into \`${headBranch}\` in commit ${shortHash}\n\n`;

    if (conflictedFiles && conflictedFiles.length > 0) {
        comment += `### Conflicting Files\n\n`;
        comment += conflictedFiles.map(f => `- \`${f}\``).join('\n');
        comment += '\n\n';
    }

    if (resolutionSummary) {
        comment += `### Resolution Summary\n\n${resolutionSummary}\n\n`;
    } else {
        comment += `An AI agent resolved the merge conflicts while preserving the PR intent.\n\n`;
    }

    if (model || executionTimeMs) {
        comment += `---\n### 🤖 Resolution Details\n\n`;
        if (model) comment += `* **Model:** ${model}\n`;
        if (executionTimeMs) {
            const seconds = Math.floor(executionTimeMs / 1000);
            const m = Math.floor(seconds / 60);
            const s = seconds % 60;
            comment += `* **Time:** ${m > 0 ? `${m}m ${s}s` : `${s}s`}\n`;
        }
    }

    if (taskUrl) {
        comment += `\n[View Task Execution](${taskUrl})`;
    }

    comment += `\n\n---\n_System-triggered merge conflict resolution_`;
    return comment;
}

/**
 * Converts a MergeConflictJobData into a CommentJobData for the PR comment processing pipeline.
 */
export function mergeConflictJobToCommentJob(mergeJob: {
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    headBranch: string;
    baseBranch: string;
    headSha: string;
    baseSha: string;
    triggerSource: 'pull_request' | 'push' | 'auto_merge';
    correlationId: string;
}): {
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    branchName: string;
    correlationId: string;
    systemAction: 'auto_resolve_merge_conflicts';
    autoResolveContext: AutoResolveContext;
} {
    return {
        pullRequestNumber: mergeJob.pullRequestNumber,
        repoOwner: mergeJob.repoOwner,
        repoName: mergeJob.repoName,
        branchName: mergeJob.headBranch,
        correlationId: mergeJob.correlationId,
        systemAction: 'auto_resolve_merge_conflicts',
        autoResolveContext: {
            baseBranch: mergeJob.baseBranch,
            headBranch: mergeJob.headBranch,
            headSha: mergeJob.headSha,
            baseSha: mergeJob.baseSha,
            triggerSource: mergeJob.triggerSource,
        },
    };
}

export async function updateMergeTaskWithPRInfo(options: {
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
    stateManager: WorkerStateManager;
    taskId: string;
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    baseBranch: string;
    headBranch: string;
    correlatedLogger: Logger;
    redisClient: { setex: (key: string, ttl: number, value: string) => Promise<unknown> };
    title?: string;
    subtitle?: string;
}): Promise<{ prTitle: string; linkedIssueNumber: number | null }> {
    const { octokit, pullRequestNumber, repoOwner, repoName } = options;

    const graphqlResponse = await octokit.graphql<{
        repository: {
            pullRequest: {
                title: string;
                closingIssuesReferences: {
                    nodes: Array<{ number: number; title: string }>;
                };
            };
        };
    }>(`
        query($owner: String!, $repo: String!, $prNumber: Int!) {
            repository(owner: $owner, name: $repo) {
                pullRequest(number: $prNumber) {
                    title
                    closingIssuesReferences(first: 1) {
                        nodes {
                            number
                            title
                        }
                    }
                }
            }
        }
    `, { owner: repoOwner, repo: repoName, prNumber: pullRequestNumber });

    const prTitle = graphqlResponse.repository.pullRequest.title;
    const linkedIssues = graphqlResponse.repository.pullRequest.closingIssuesReferences.nodes;
    const linkedIssueNumber = linkedIssues.length > 0 ? linkedIssues[0].number : null;

    await updateMergeTaskWithKnownPRInfo({ ...options, prTitle, linkedIssueNumber });
    return { prTitle, linkedIssueNumber };
}

export async function updateMergeTaskWithKnownPRInfo(options: {
    stateManager: WorkerStateManager;
    taskId: string;
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    baseBranch: string;
    headBranch: string;
    correlatedLogger: Logger;
    redisClient: { setex: (key: string, ttl: number, value: string) => Promise<unknown> };
    prTitle: string;
    linkedIssueNumber: number | null;
    title?: string;
    subtitle?: string;
}): Promise<void> {
    const { stateManager, taskId, pullRequestNumber, repoOwner, repoName, baseBranch, headBranch, correlatedLogger, redisClient, prTitle, linkedIssueNumber } = options;
    const taskTitle = options.title || buildPrTaskTitle({ workflow: 'merge', pullRequestNumber, prTitle });
    const taskSubtitle = options.subtitle || `Merging ${baseBranch} into ${headBranch}`;
    if (linkedIssueNumber) {
        correlatedLogger.info({ taskId, pullRequestNumber, linkedIssueNumber }, 'Found linked issue for merge task');
    }

    await db('tasks').where({ task_id: taskId }).update({
        pr_number: pullRequestNumber,
        initial_job_data: JSON.stringify({
            pullRequestNumber, repoOwner, repoName,
            title: taskTitle, subtitle: taskSubtitle,
            baseBranch, headBranch, type: 'merge_conflict',
            ...(linkedIssueNumber && { issueNumber: linkedIssueNumber }),
        }),
    });

    const state = await stateManager.getTaskState(taskId);
    if (state) {
        state.issueRef = {
            ...state.issueRef,
            pullRequestNumber, title: taskTitle, subtitle: taskSubtitle,
            ...(linkedIssueNumber && { issueNumber: linkedIssueNumber }),
        };
        await redisClient.setex(stateManager.getTaskKey(taskId), 7 * 24 * 3600, JSON.stringify(state));
    }

    correlatedLogger.info({ taskId, prTitle, taskTitle, linkedIssueNumber }, 'Updated merge task with PR title and linked issue');
}
