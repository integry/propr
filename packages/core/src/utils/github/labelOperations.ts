import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { LabelTransitionLeaseError, withLabelTransitionLease, type LabelTransitionLease } from '../ultrafixLabelTransition.js';

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
    /** The transition was superseded before any labels were mutated. */
    skipped?: boolean;
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
    /** Redis client used to serialize this PR's complete exclusive transition. */
    redis: Pick<Redis, 'set' | 'eval'>;
    /** Claim this transition while its per-PR lease is held. */
    claimTransition?: () => Promise<boolean>;
    /** The caller's verified lease when publication extends beyond convergence. */
    lease?: LabelTransitionLease;
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

async function restoreManagedLabels(
    context: LabelContext,
    convergence: ExclusiveLabelConvergence,
    priorManagedLabels: string[],
    results: UpdateResults,
    lease: LabelTransitionLease,
): Promise<void> {
    await lease.assertOwned();
    const priorLabelNames = new Set(priorManagedLabels.map(label => label.toLowerCase()));
    let liveLabels: string[];
    try {
        liveLabels = await readLiveLabels(context);
    } catch (error) {
        results.errors.push(`Failed to read live labels for restoration: ${(error as Error).message}`);
        return;
    }

    const transitionLabelNames = new Set([
        ...priorManagedLabels.map(label => label.toLowerCase()),
        convergence.targetLabel.toLowerCase(),
    ]);
    const liveManagedLabels = liveLabels.filter(convergence.isManagedLabel);
    const newerSingletonSelection = liveManagedLabels.length === 1
        && !transitionLabelNames.has(liveManagedLabels[0].toLowerCase())
        ? liveManagedLabels[0]
        : undefined;
    if (newerSingletonSelection) {
        // Another transition has established a valid singleton selection that
        // this failed attempt never owned. Restoring our snapshot would
        // overwrite that newer durable source of truth.
        results.finalLabels = liveLabels;
        results.errors.push(
            `Skipped model-label restoration because live selection changed to: ${newerSingletonSelection}`,
        );
        context.logger.warn({
            issueNumber: context.issueNumber,
            targetLabel: convergence.targetLabel,
            newerSingletonSelection,
        }, 'Skipped stale model-label restoration after a concurrent transition');
        return;
    }

    for (const label of priorManagedLabels) {
        if (liveLabels.some(liveLabel => liveLabel.toLowerCase() === label.toLowerCase())) continue;
        await lease.assertOwned();
        const added = await safeAddLabel(context, label);
        await lease.assertOwned();
        if (added) results.added.push(label);
        else results.errors.push(`Failed to restore '${label}'`);
    }

    await lease.assertOwned();
    try {
        liveLabels = await readLiveLabels(context);
    } catch (error) {
        results.errors.push(`Failed to verify restored model labels: ${(error as Error).message}`);
        return;
    }

    const allPriorLabelsPresent = priorManagedLabels.every(label =>
        liveLabels.some(liveLabel => liveLabel.toLowerCase() === label.toLowerCase()));
    if (!allPriorLabelsPresent) {
        results.finalLabels = liveLabels;
        results.errors.push('Could not restore the prior model-label set');
        return;
    }

    for (const label of liveLabels.filter(convergence.isManagedLabel)) {
        if (priorLabelNames.has(label.toLowerCase())) continue;
        await lease.assertOwned();
        const removed = await safeRemoveLabel(context, label);
        await lease.assertOwned();
        if (removed) results.removed.push(label);
        else results.errors.push(`Failed to remove partial transition label '${label}' during restoration`);
    }

    await lease.assertOwned();
    try {
        results.finalLabels = await readLiveLabels(context);
        const restoredManagedLabels = results.finalLabels.filter(convergence.isManagedLabel);
        const restoredExactly = restoredManagedLabels.length === priorManagedLabels.length
            && restoredManagedLabels.every(label => priorLabelNames.has(label.toLowerCase()));
        if (!restoredExactly) results.errors.push('Prior model-label set was not restored exactly');
    } catch (error) {
        results.errors.push(`Failed to verify final restored labels: ${(error as Error).message}`);
    }
}

async function convergeExclusiveLabel(
    context: LabelContext,
    convergence: ExclusiveLabelConvergence,
    results: UpdateResults,
    lease: LabelTransitionLease,
): Promise<void> {
    const { issueNumber, logger } = context;
    const maxAttempts = Math.max(1, convergence.maxAttempts ?? 3);
    const targetLower = convergence.targetLabel.toLowerCase();
    let priorManagedLabels: string[] | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        // Fence every attempt as well as every mutation. If ownership expires
        // during a GitHub request, the post-mutation check prevents this stale
        // transition from issuing any further managed-label writes.
        await lease.assertOwned();
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
        priorManagedLabels ??= managedLabels;
        const targetPresent = managedLabels.some(label => label.toLowerCase() === targetLower);
        let targetEstablished = targetPresent;
        if (!targetPresent) {
            await lease.assertOwned();
            targetEstablished = await safeAddLabel(context, convergence.targetLabel);
            await lease.assertOwned();
            if (targetEstablished) {
                results.added.push(convergence.targetLabel);
            } else {
                results.errors.push(`Attempt ${attempt}: failed to add '${convergence.targetLabel}'; prior model labels were retained`);
            }
        }

        const labelsToRemove = targetEstablished
            ? managedLabels.filter(label => label.toLowerCase() !== targetLower)
            : [];
        for (const label of labelsToRemove) {
            await lease.assertOwned();
            const removed = await safeRemoveLabel(context, label);
            await lease.assertOwned();
            if (removed) results.removed.push(label);
            else results.errors.push(`Attempt ${attempt}: failed to remove '${label}'`);
        }

        await lease.assertOwned();
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
    if (priorManagedLabels !== undefined) {
        await restoreManagedLabels(context, convergence, priorManagedLabels, results, lease);
    }
}

async function runExclusiveLabelTransition(
    context: LabelContext,
    convergence: ExclusiveLabelConvergence,
    transition: (lease: LabelTransitionLease) => Promise<void>,
): Promise<void> {
    if (!convergence.lease) {
        await withLabelTransitionLease(
            convergence.redis,
            { owner: context.owner, repo: context.repo, pr: context.issueNumber },
            transition,
        );
        return;
    }

    const { identity } = convergence.lease;
    if (
        identity.owner !== context.owner
        || identity.repo !== context.repo
        || identity.pr !== context.issueNumber
    ) throw new LabelTransitionLeaseError('PR label transition lease identity does not match label context');
    await convergence.lease.assertOwned();
    await transition(convergence.lease);
    await convergence.lease.assertOwned();
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
        // set: only labels classified as model labels may be touched. Its lease
        // covers the initial snapshot, convergence, verification, and rollback.
        results.success = false;
        try {
            const transition = async (lease: LabelTransitionLease): Promise<void> => {
                if (convergence.claimTransition && !await convergence.claimTransition()) {
                    results.skipped = true;
                    return;
                }
                await convergeExclusiveLabel(context, convergence, results, lease);
            };
            await runExclusiveLabelTransition(context, convergence, transition);
        } catch (error) {
            const message = (error as Error).message;
            results.success = false;
            results.errors.push(`Failed to hold PR label transition lease: ${message}`);
            logger.warn({ error: message, issueNumber }, 'Exclusive label transition lease failed');
        }
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
