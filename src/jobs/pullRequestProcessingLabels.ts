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

type LabelPayload = ReadonlyArray<{ name?: string | null } | string | null> | null | undefined;

/** Label names from a GitHub pull request payload, whose entries may be strings or objects. */
export function pullRequestLabelNames(labels: LabelPayload): string[] {
    if (!Array.isArray(labels)) return [];
    return labels
        .map(label => typeof label === 'string' ? label : label?.name ?? '')
        .filter(name => name.length > 0);
}

/**
 * Adds the processing label (and model label) to a pull request an issue run
 * opened. Each path that opens or finds the pull request calls this once, and
 * labels the pull request already has (from the create, list or validation
 * response) are not sent again: every added label is a timeline entry and a
 * webhook delivery ProPR has to process (#3691). Follow-up intake treats a
 * pull request without a processing label as not opted in and ignores plain
 * comments on it, so every way an issue run
 * can end up with a pull request (normal creation, the API retry, or one found
 * during final validation) must leave these labels on it. A failure is
 * logged, never fatal: the pull request already exists.
 */
export async function addPullRequestProcessingLabels(
    octokit: LabelOctokit,
    ref: { repoOwner: string; repoName: string; prNumber: number },
    labels: string[],
    options: { correlatedLogger: Logger; retryDelayMs?: number; presentLabels?: readonly string[] },
): Promise<boolean> {
    const { correlatedLogger, retryDelayMs = LABEL_RETRY_DELAY_MS, presentLabels = [] } = options;
    const missing = [...new Set(labels)].filter(label => !presentLabels.includes(label));
    if (missing.length === 0) {
        if (labels.length > 0) correlatedLogger.debug({ prNumber: ref.prNumber, labels }, 'Pull request already has its processing labels');
        return true;
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= LABEL_ATTEMPTS; attempt += 1) {
        try {
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                owner: ref.repoOwner,
                repo: ref.repoName,
                issue_number: ref.prNumber,
                labels: missing,
            });
            correlatedLogger.info({ prNumber: ref.prNumber, labels: missing }, 'Added processing labels to the pull request');
            return true;
        } catch (error) {
            lastError = error;
            if (attempt < LABEL_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
        }
    }
    correlatedLogger.warn({ prNumber: ref.prNumber, labels: missing, error: (lastError as Error)?.message }, 'Failed to add processing labels to the pull request after retries; follow-up comments on it need a processing label');
    return false;
}
