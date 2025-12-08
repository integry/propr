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

export async function safeUpdateLabels(context: LabelContext, labelsToRemove: string[] = [], labelsToAdd: string[] = []): Promise<UpdateResults> {
    const { issueNumber, logger } = context;
    const results: UpdateResults = {
        success: true,
        removed: [],
        added: [],
        errors: []
    };

    for (const labelName of labelsToRemove) {
        const removed = await safeRemoveLabel(context, labelName);
        if (removed) {
            results.removed.push(labelName);
        } else {
            results.success = false;
            results.errors.push(`Failed to remove '${labelName}'`);
        }
    }

    for (const labelName of labelsToAdd) {
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
