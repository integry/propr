import type { Logger } from 'pino';
import type { IssueJobData } from '@propr/core';

type LabelOctokit = {
    request: <T = unknown>(endpoint: string, options: Record<string, unknown>) => Promise<T>;
};

const LABEL_ATTEMPTS = 3;
const LABEL_RETRY_DELAY_MS = 2000;

/**
 * The labels normal pull request creation adds: the processing label and the
 * run's model label. Empty when the caller has no processing label to add.
 */
export async function issuePullRequestLabels(
    issueRef: Pick<IssueJobData, 'agentAlias' | 'modelLabel'>,
    prLabel: string | undefined,
    modelName: string | undefined,
): Promise<string[]> {
    if (!prLabel) return [];
    // Loaded lazily: suites that mock the helpers enumerate the exports they replace.
    const { getPullRequestModelLabel } = await import('./issueJobHelpers.js');
    const modelLabel = modelName ? getPullRequestModelLabel(issueRef, modelName) : null;
    return modelLabel ? [prLabel, modelLabel] : [prLabel];
}

/**
 * Adds the processing label (and model label) to a pull request an issue run
 * opened. Follow-up intake treats a pull request without a processing label
 * as not opted in and ignores plain comments on it, so every way an issue run
 * can end up with a pull request (normal creation, the API retry, or one found
 * during final validation) must leave these labels on it. A failure is
 * logged, never fatal: the pull request already exists.
 */
export async function addPullRequestProcessingLabels(
    octokit: LabelOctokit,
    ref: { repoOwner: string; repoName: string; prNumber: number },
    labels: string[],
    options: { correlatedLogger: Logger; retryDelayMs?: number },
): Promise<boolean> {
    if (labels.length === 0) return true;
    const { correlatedLogger, retryDelayMs = LABEL_RETRY_DELAY_MS } = options;
    let lastError: unknown;
    for (let attempt = 1; attempt <= LABEL_ATTEMPTS; attempt += 1) {
        try {
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                owner: ref.repoOwner,
                repo: ref.repoName,
                issue_number: ref.prNumber,
                labels,
            });
            correlatedLogger.info({ prNumber: ref.prNumber, labels }, 'Added processing labels to the pull request');
            return true;
        } catch (error) {
            lastError = error;
            if (attempt < LABEL_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
        }
    }
    correlatedLogger.warn({ prNumber: ref.prNumber, labels, error: (lastError as Error)?.message }, 'Failed to add processing labels to the pull request after retries; follow-up comments on it need a processing label');
    return false;
}
