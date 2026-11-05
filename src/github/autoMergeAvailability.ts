import { getAuthenticatedOctokit } from '@propr/core';

/** GitHub's refusal when the repository's "Allow auto-merge" setting is off. */
export function isAutoMergeDisabledForRepository(message: string | undefined): boolean {
    return /auto merge is not allowed for this repository/i.test(message ?? '');
}

/** Comment suggesting the repository setting that lets GitHub merge on its own. */
export const AUTO_MERGE_DISABLED_COMMENT = [
    'ℹ️ **GitHub auto-merge is turned off for this repository**, so ProPR merges this PR itself once it is ready '
        + '(checks passed or no CI configured, and the review goal met).',
    '',
    'To let GitHub merge it the moment required checks pass, enable **Settings → General → Pull Requests → Allow auto-merge**.',
].join('\n');

/** Posts {@link AUTO_MERGE_DISABLED_COMMENT} on the PR; returns the failure instead of throwing. */
export async function suggestEnablingAutoMerge(owner: string, repoName: string, prNumber: number): Promise<Error | null> {
    try {
        const octokit = await getAuthenticatedOctokit();
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner, repo: repoName, issue_number: prNumber, body: AUTO_MERGE_DISABLED_COMMENT,
        });
        return null;
    } catch (error) {
        return error as Error;
    }
}

/** GitHub errors meaning auto-merge cannot be armed, so a direct merge is needed. */
export function isAutoMergeUnavailableError(message: string): boolean {
    return isAutoMergeDisabledForRepository(message)
        || /pull request is in clean status/i.test(message);
}
