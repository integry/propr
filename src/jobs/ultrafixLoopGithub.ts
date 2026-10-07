/**
 * GitHub side effects of the Ultrafix loop: the `ultrafix` label, status
 * comments and re-arming auto-merge once the goal is reached.
 */

import type { Logger } from 'pino';
import {
    findPlanIssueByRepoAndPR,
    gateAutoMergeArming,
    getAuthenticatedOctokit,
    retryConfigs,
    safeRemoveLabel,
    withRetry,
} from '@propr/core';
import { enableAutoMerge } from '../github/autoMergeOperations.js';

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

export async function postPrComment(options: {
    owner: string;
    repo: string;
    pullRequestNumber: number;
    body: string;
    correlatedLogger: Logger;
}): Promise<void> {
    const { owner, repo, pullRequestNumber, body, correlatedLogger } = options;
    try {
        const octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi },
            'get_authenticated_octokit_ultrafix_comment',
        );
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner,
            repo,
            issue_number: pullRequestNumber,
            body,
        });
    } catch (err) {
        correlatedLogger.warn({ error: (err as Error).message, pullRequestNumber }, 'Failed to post ultrafix status comment');
    }
}

export async function maybeEnableAutoMerge(
    owner: string,
    repo: string,
    pullRequestNumber: number,
    correlatedLogger: Logger,
): Promise<void> {
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
        if (!result.success) {
            correlatedLogger.warn({ pullRequestNumber, error: result.error }, 'Failed to enable auto-merge after ultrafix success');
        }
    } catch (err) {
        correlatedLogger.warn({ error: (err as Error).message, pullRequestNumber }, 'Failed to evaluate auto-merge re-enable after ultrafix success');
    }
}
