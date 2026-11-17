/**
 * Labels a ProPR pull request at creation. Each attempt reads the labels the
 * PR already has and adds only the missing ones, so a retried request (or the
 * existing-PR fallback after a create that did go through) never applies the
 * same label twice.
 */
import { retryConfigs, withRetry } from '@propr/core';

interface LabelOctokit {
    request: <T = unknown>(endpoint: string, options: Record<string, unknown>) => Promise<T>;
}

export async function addMissingPullRequestLabels(
    octokit: LabelOctokit,
    target: { owner: string; repo: string; pullRequestNumber: number },
    labels: readonly string[],
    operationName: string,
): Promise<string[]> {
    const wanted = [...new Set(labels.filter(Boolean))];
    if (wanted.length === 0) return [];
    let added: string[] = [];
    await withRetry(async () => {
        let present = new Set<string>();
        try {
            const response = await octokit.request<{ data?: Array<{ name?: string } | string> }>('GET /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                owner: target.owner, repo: target.repo, issue_number: target.pullRequestNumber, per_page: 100,
            });
            const current = Array.isArray(response?.data) ? response.data : [];
            present = new Set(current.map(label => typeof label === 'string' ? label : label?.name ?? '').filter(Boolean));
        } catch {
            // Unknown current labels: adding all of them is still correct, only possibly repeated.
        }
        const missing = wanted.filter(label => !present.has(label));
        added = missing;
        if (missing.length === 0) return;
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner: target.owner, repo: target.repo, issue_number: target.pullRequestNumber, labels: missing,
        });
    }, retryConfigs.githubApi, operationName);
    return added;
}
