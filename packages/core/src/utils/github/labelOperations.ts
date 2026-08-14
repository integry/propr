import type { Logger } from 'pino';

interface OctokitLike {
    request: <T = unknown>(endpoint: string, options: Record<string, unknown>) => Promise<T>;
}

export interface LabelContext {
    octokit: OctokitLike;
    owner: string;
    repo: string;
    issueNumber: number;
    logger: Logger;
}

export interface UpdateResults {
    success: boolean;
    removed: string[];
    added: string[];
    errors: string[];
    /** Labels observed by the final live verification read. */
    finalLabels?: string[];
}

export interface ExclusiveLabelConvergence {
    /** The one managed label that must remain after convergence. */
    targetLabel: string;
    /** Classifies labels owned by this transition. Unmanaged labels are never mutated. */
    isManagedLabel: (labelName: string) => boolean;
    /** Maximum live-read/mutate/verify attempts. */
    maxAttempts?: number;
}

interface IssueLabelsResponse {
    data: { labels?: Array<string | { name?: string }> };
}

function labelNames(response: IssueLabelsResponse): string[] {
    return (response.data.labels ?? []).flatMap(label =>
        typeof label === 'string' ? [label] : label.name ? [label.name] : []);
}

async function readLiveLabels(context: LabelContext): Promise<string[]> {
    const response = await context.octokit.request<IssueLabelsResponse>(
        'GET /repos/{owner}/{repo}/issues/{issue_number}',
        { owner: context.owner, repo: context.repo, issue_number: context.issueNumber },
    );
    return labelNames(response);
}

async function convergeExclusiveLabel(
    context: LabelContext,
    convergence: ExclusiveLabelConvergence,
    results: UpdateResults,
): Promise<void> {
    const { issueNumber, logger } = context;
    const maxAttempts = Math.max(1, convergence.maxAttempts ?? 3);
    const targetLower = convergence.targetLabel.toLowerCase();

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let liveLabels: string[];
        try {
            liveLabels = await readLiveLabels(context);
        } catch (error) {
            const message = (error as Error).message;
            results.errors.push(`Attempt ${attempt}: failed to read live labels: ${message}`);
            logger.warn({ error: message, issueNumber, attempt }, 'Failed to read live labels before model-label transition');
            continue;
        }

        const managedLabels = liveLabels.filter(convergence.isManagedLabel);
        const labelsToRemove = managedLabels.filter(label => label.toLowerCase() !== targetLower);
        const targetPresent = managedLabels.some(label => label.toLowerCase() === targetLower);

        for (const label of labelsToRemove) {
            if (await safeRemoveLabel(context, label)) results.removed.push(label);
            else results.errors.push(`Attempt ${attempt}: failed to remove '${label}'`);
        }
        if (!targetPresent) {
            if (await safeAddLabel(context, convergence.targetLabel)) results.added.push(convergence.targetLabel);
            else results.errors.push(`Attempt ${attempt}: failed to add '${convergence.targetLabel}'`);
        }

        try {
            const verifiedLabels = await readLiveLabels(context);
            results.finalLabels = verifiedLabels;
            const verifiedManagedLabels = verifiedLabels.filter(convergence.isManagedLabel);
            if (
                verifiedManagedLabels.length === 1
                && verifiedManagedLabels[0].toLowerCase() === targetLower
            ) {
                results.success = true;
                return;
            }
            results.errors.push(
                `Attempt ${attempt}: model-label invariant not satisfied (found: ${verifiedManagedLabels.join(', ') || 'none'})`,
            );
        } catch (error) {
            const message = (error as Error).message;
            results.errors.push(`Attempt ${attempt}: failed to verify live labels: ${message}`);
            logger.warn({ error: message, issueNumber, attempt }, 'Failed to verify live labels after model-label transition');
        }
    }

    results.success = false;
}

export async function safeRemoveLabel(context: LabelContext, labelName: string): Promise<boolean> {
    const { octokit, owner, repo, issueNumber, logger } = context;
    try {
        await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
            owner,
            repo,
            issue_number: issueNumber,
            name: labelName
        });
        logger.debug(`Successfully removed label '${labelName}' from issue #${issueNumber}`);
        return true;
    } catch (error) {
        const err = error as Error & { status?: number };
        if (err.status === 404) {
            logger.debug(`Label '${labelName}' not found on issue #${issueNumber}, skipping removal`);
            return true;
        }
        logger.warn({
            error: err.message,
            labelName,
            issueNumber,
            status: err.status
        }, `Failed to remove label '${labelName}' from issue #${issueNumber}`);
        return false;
    }
}

export async function safeAddLabel(context: LabelContext, labelName: string): Promise<boolean> {
    const { octokit, owner, repo, issueNumber, logger } = context;
    try {
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner,
            repo,
            issue_number: issueNumber,
            labels: [labelName]
        });
        logger.debug(`Successfully added label '${labelName}' to issue #${issueNumber}`);
        return true;
    } catch (error) {
        const err = error as Error & { status?: number; message?: string };
        if (err.status === 422 && err.message?.includes('already exists')) {
            logger.debug(`Label '${labelName}' already exists on issue #${issueNumber}`);
            return true;
        }
        logger.warn({
            error: err.message,
            labelName,
            issueNumber,
            status: err.status
        }, `Failed to add label '${labelName}' to issue #${issueNumber}`);
        return false;
    }
}

export async function safeUpdateLabels(
    context: LabelContext,
    labelsToRemove: string[] = [],
    labelsToAdd: string[] = [],
    /** Replace a snapshot, or converge one managed label exclusively from live reads. */
    currentLabelsOrConvergence?: string[] | ExclusiveLabelConvergence,
): Promise<UpdateResults> {
    const { issueNumber, logger } = context;
    const currentLabels = Array.isArray(currentLabelsOrConvergence) ? currentLabelsOrConvergence : undefined;
    const convergence = Array.isArray(currentLabelsOrConvergence) ? undefined : currentLabelsOrConvergence;
    const results: UpdateResults = {
        success: true,
        removed: [],
        added: [],
        errors: []
    };

    if (convergence) {
        // The model-selection path deliberately avoids PUT of a complete label
        // set: only labels classified as model labels may be touched.
        results.success = false;
        await convergeExclusiveLabel(context, convergence, results);
    } else if (currentLabels) {
        const removedNames = new Set(labelsToRemove.map(label => label.toLowerCase()));
        const desiredLabels = currentLabels.filter(label => !removedNames.has(label.toLowerCase()));
        for (const label of labelsToAdd) {
            if (!desiredLabels.some(existing => existing.toLowerCase() === label.toLowerCase())) desiredLabels.push(label);
        }
        try {
            await context.octokit.request('PUT /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                owner: context.owner,
                repo: context.repo,
                issue_number: issueNumber,
                labels: desiredLabels,
            });
            results.removed.push(...labelsToRemove);
            results.added.push(...labelsToAdd);
        } catch (error) {
            const err = error as Error & { status?: number };
            results.success = false;
            results.errors.push(`Failed to atomically replace labels: ${err.message}`);
            logger.warn({ error: err.message, issueNumber, status: err.status }, 'Failed to atomically replace issue labels');
        }
    } else for (const labelName of labelsToRemove) {
        const removed = await safeRemoveLabel(context, labelName);
        if (removed) {
            results.removed.push(labelName);
        } else {
            results.success = false;
            results.errors.push(`Failed to remove '${labelName}'`);
        }
    }

    if (!convergence && !currentLabels) for (const labelName of labelsToAdd) {
        const added = await safeAddLabel(context, labelName);
        if (added) {
            results.added.push(labelName);
        } else {
            results.success = false;
            results.errors.push(`Failed to add '${labelName}'`);
        }
    }

    logger.info({
        issueNumber,
        removed: results.removed,
        added: results.added,
        errors: results.errors.length > 0 ? results.errors : undefined
    }, 'Label update completed');

    return results;
}
