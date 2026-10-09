import type { Logger } from 'pino';
import type { IssueJobData, RepoValidationResult, WorktreeInfo } from '@propr/core';
import { getAuthenticatedOctokit, linkPRToPlanIssue } from '@propr/core';

export interface RetryPRCreationOptions {
    worktreeInfo: WorktreeInfo;
    issueRef: IssueJobData;
    repoValidation: RepoValidationResult;
    correlatedLogger: Logger;
}

/**
 * Retries PR creation via GitHub API when the initial PR creation failed.
 * This is a fallback that uses direct API calls instead of having Claude create the PR.
 * Returns the created or already existing PR, or null.
 */
export async function retryPRCreationViaAPI(options: RetryPRCreationOptions): Promise<{ number: number } | null> {
    const { worktreeInfo, issueRef, repoValidation, correlatedLogger } = options;

    const targetBaseBranch = issueRef.baseBranch || repoValidation.repoData?.defaultBranch || 'main';

    correlatedLogger.info({
        issueNumber: issueRef.number,
        branchName: worktreeInfo.branchName,
        baseBranch: targetBaseBranch
    }, 'Retrying PR creation via GitHub API');

    // Kept outside the try so a later plan-link failure still reports the created PR.
    let createdPrNumber: number | null = null;
    try {
        const octokit = await getAuthenticatedOctokit();

        const prResponse = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
            owner: issueRef.repoOwner,
            repo: issueRef.repoName,
            title: `Fix issue #${issueRef.number}`,
            head: worktreeInfo.branchName,
            base: targetBaseBranch,
            body: `Resolves #${issueRef.number}\n\n_PR created via retry mechanism_`
        });

        const prNumber = prResponse.data.number;
        createdPrNumber = prNumber;
        correlatedLogger.info({ issueNumber: issueRef.number, prNumber }, 'PR creation retry successful');

        // Link PR to plan issue
        const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
        await linkPRToPlanIssue(repository, issueRef.number, prNumber);
        correlatedLogger.info({ repository, issueNumber: issueRef.number, prNumber }, 'Linked PR to plan issue (retry creation)');
        return { number: prNumber };
    } catch (error) {
        const err = error as Error & { status?: number };

        // If PR already exists (422), try to find it
        if (createdPrNumber !== null) {
            correlatedLogger.warn({ issueNumber: issueRef.number, prNumber: createdPrNumber, error: err.message }, 'Failed to link the retried PR to its plan issue');
            return { number: createdPrNumber };
        }
        if (err.status === 422) {
            correlatedLogger.info({ issueNumber: issueRef.number }, 'PR already exists, searching for it');

            const octokit = await getAuthenticatedOctokit();
            const existingPRs = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                head: `${issueRef.repoOwner}:${worktreeInfo.branchName}`,
                state: 'open'
            });

            if (existingPRs.data.length > 0) {
                const existingPR = existingPRs.data[0];
                correlatedLogger.info({ issueNumber: issueRef.number, prNumber: existingPR.number }, 'Found existing PR');

                const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
                await linkPRToPlanIssue(repository, issueRef.number, existingPR.number);
                return { number: existingPR.number };
            }
        } else {
            correlatedLogger.error({
                issueNumber: issueRef.number,
                branchName: worktreeInfo.branchName,
                error: err.message,
                status: err.status
            }, 'PR creation retry failed');
        }
    }
    return null;
}
