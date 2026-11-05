/**
 * GitHub side effects of the Ultrafix loop: the `ultrafix` label, status
 * comments and re-arming auto-merge once the goal is reached.
 */

import type { Logger } from 'pino';
import {
    findPlanIssueByRepoAndPR,
    gateAutoMergeArming,
    getAuthenticatedOctokit,
    reevaluatePRAutoMerge,
    retryConfigs,
    safeRemoveLabel,
    withRetry,
} from '@propr/core';
import { enableAutoMerge } from '../github/autoMergeOperations.js';
import { isAutoMergeDisabledForRepository, suggestEnablingAutoMerge } from '../github/autoMergeAvailability.js';

async function fetchUltrafixLabelPresence(owner: string, repo: string, pullRequestNumber: number): Promise<boolean> {
    const octokit = await withRetry(
        () => getAuthenticatedOctokit(),
        { ...retryConfigs.githubApi },
        'get_authenticated_octokit_ultrafix_label_check',
    );
    const prData = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner,
        repo,
        pull_number: pullRequestNumber,
    });
    return prData.data.labels.some((label: { name?: string }) => label.name === 'ultrafix');
}

export async function hasUltrafixLabel(
    owner: string,
    repo: string,
    pullRequestNumber: number,
    correlatedLogger: Logger,
): Promise<boolean> {
    try {
        return await fetchUltrafixLabelPresence(owner, repo, pullRequestNumber);
    } catch (err) {
        correlatedLogger.warn(
            { error: (err as Error).message, pullRequestNumber },
            'Failed to check ultrafix label, assuming removed for safety',
        );
        return false;
    }
}

/** `unverified` when GitHub could not be asked: the label may well still be there. */
export type UltrafixLabelState = 'present' | 'absent' | 'unverified';

/**
 * Like `hasUltrafixLabel`, but a failed lookup is reported as `unverified`
 * rather than as a removed label, for callers that must not tear a loop down
 * on a transient GitHub error.
 */
export async function getUltrafixLabelState(
    owner: string,
    repo: string,
    pullRequestNumber: number,
    correlatedLogger: Logger,
): Promise<UltrafixLabelState> {
    try {
        return await fetchUltrafixLabelPresence(owner, repo, pullRequestNumber) ? 'present' : 'absent';
    } catch (err) {
        correlatedLogger.warn(
            { error: (err as Error).message, pullRequestNumber },
            'Failed to check ultrafix label; leaving the loop untouched',
        );
        return 'unverified';
    }
}

export async function removeUltrafixLabel(
    owner: string,
    repo: string,
    pullRequestNumber: number,
    correlatedLogger: Logger,
): Promise<void> {
    try {
        const octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi },
            'get_authenticated_octokit_ultrafix_label_remove',
        );
        await safeRemoveLabel(
            { octokit, owner, repo, issueNumber: pullRequestNumber, logger: correlatedLogger },
            'ultrafix',
        );
    } catch (err) {
        correlatedLogger.warn(
            { error: (err as Error).message, pullRequestNumber },
            'Failed to remove ultrafix label',
        );
    }
}

/** Posts an Ultrafix status comment; returns its id, or null when posting failed. */
export async function postPrComment(options: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    body: string;
    correlatedLogger: Logger;
}): Promise<number | null> {
    const { owner, repo, pullRequestNumber, body, correlatedLogger } = options;
    try {
        const octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi },
            'get_authenticated_octokit_ultrafix_comment',
        );
        const response = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner,
            repo,
            issue_number: pullRequestNumber,
            body,
        });
        return typeof response?.data?.id === 'number' ? response.data.id : null;
    } catch (err) {
        correlatedLogger.warn({ error: (err as Error).message, pullRequestNumber }, 'Failed to post ultrafix status comment');
        return null;
    }
}

/** Rewrites an earlier Ultrafix status comment in place; false when it could not be edited. */
export async function updatePrComment(options: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    commentId: number;
    body: string;
    correlatedLogger: Logger;
}): Promise<boolean> {
    const { owner, repo, pullRequestNumber, commentId, body, correlatedLogger } = options;
    try {
        const octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi },
            'get_authenticated_octokit_ultrafix_comment_update',
        );
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner,
            repo,
            comment_id: commentId,
            body,
        });
        return true;
    } catch (err) {
        correlatedLogger.warn({ error: (err as Error).message, pullRequestNumber, commentId }, 'Failed to update ultrafix status comment');
        return false;
    }
}

export async function maybeEnableAutoMerge(
    pr: { owner: string; repo: string; pullRequestNumber: number; correlationId?: string; currentJobId?: string },
    correlatedLogger: Logger,
): Promise<void> {
    const { owner, repo, pullRequestNumber } = pr;
    try {
        const repository = `${owner}/${repo}`;
        const planIssue = await findPlanIssueByRepoAndPR(repository, pullRequestNumber);
        if (!planIssue) return;

        const octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi },
            'get_authenticated_octokit_ultrafix_issue_labels',
        );
        const issueResponse = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
            owner,
            repo,
            issue_number: planIssue.issue_number,
        });
        const labels = (issueResponse.data.labels as Array<{ name?: string } | string>)
            .map((label) => typeof label === 'string' ? label : (label.name || ''));
        if (!labels.includes('auto-merge')) return;

        const gate = await gateAutoMergeArming({
            owner, repo, prNumber: pullRequestNumber, opportunity: 'ultrafix_goal', issueNumber: planIssue.issue_number, log: correlatedLogger,
        });
        if (!gate.arm || !gate.pullRequest) return;
        // Arm only the head the policy evaluated; a newer head needs its own decision.
        const result = await enableAutoMerge({
            owner, repoName: repo, prNumber: pullRequestNumber, mergeMethod: gate.mergeMethod,
            expectedHead: { headSha: gate.pullRequest.headSha, baseRef: gate.pullRequest.baseRef },
        });
        if (result.success) return;
        correlatedLogger.warn({ pullRequestNumber, error: result.error }, 'Failed to enable auto-merge after ultrafix success');
        if (!result.unavailable) return;
        if (isAutoMergeDisabledForRepository(result.error)) {
            const suggestionError = await suggestEnablingAutoMerge(owner, repo, pullRequestNumber);
            if (suggestionError) correlatedLogger.warn({ pullRequestNumber, error: suggestionError.message }, 'Failed to suggest enabling GitHub auto-merge');
        }
        // GitHub cannot wait for this PR (setting off, or already mergeable), and
        // CI may have finished before the goal was reached, so no later check
        // event would merge it. Merge directly through the same gates instead;
        // only this finishing job is excluded from the active-work check.
        correlatedLogger.info({ pullRequestNumber }, 'GitHub auto-merge unavailable after ultrafix success, evaluating a direct merge');
        await reevaluatePRAutoMerge(owner, repo, pullRequestNumber, {
            correlationId: pr.correlationId ?? `ultrafix-automerge-${owner}-${repo}-${pullRequestNumber}`,
            ignoreWorkIds: pr.currentJobId ? [pr.currentJobId] : [],
        });
    } catch (err) {
        correlatedLogger.warn({ error: (err as Error).message, pullRequestNumber }, 'Failed to evaluate auto-merge re-enable after ultrafix success');
    }
}
