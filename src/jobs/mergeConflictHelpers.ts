import type { WorktreeInfo } from '@propr/core';
import type { AutoResolveContext } from '@propr/core';

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
4. Provide a brief summary of what conflicts were found and how they were resolved.

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
    model?: string;
    executionTimeMs?: number;
    taskUrl?: string;
}): string {
    const { wasCleanMerge, commitHash, baseBranch, headBranch, conflictedFiles, model, executionTimeMs, taskUrl } = options;

    const shortHash = commitHash ? commitHash.substring(0, 7) : 'unknown';

    if (wasCleanMerge) {
        let comment = `🔀 **Auto-merged \`${baseBranch}\` into \`${headBranch}\`** (clean merge) in commit ${shortHash}\n\n`;
        comment += `No conflicts were found — the merge was applied automatically without invoking an AI agent.\n`;
        comment += `\n---\n_System-triggered merge conflict resolution_`;
        return comment;
    }

    let comment = `🔀 **Resolved merge conflicts** from \`${baseBranch}\` into \`${headBranch}\` in commit ${shortHash}\n\n`;

    if (conflictedFiles && conflictedFiles.length > 0) {
        comment += `### Resolved Conflicts\n\n`;
        comment += conflictedFiles.map(f => `- \`${f}\``).join('\n');
        comment += '\n\n';
    }

    comment += `An AI agent resolved the merge conflicts while preserving the PR intent.\n`;

    if (model || executionTimeMs) {
        comment += `\n---\n### 🤖 Resolution Details\n\n`;
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
