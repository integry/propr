import { Redis } from 'ioredis';
import { logger } from '@gitfix/core';
import { handleError } from '@gitfix/core';
import { getAuthenticatedOctokit } from '@gitfix/core';
import type { PaginatedOctokitInstance } from '@gitfix/core';
import { getRepos, getPrimaryProcessingLabels } from './configLoader.js';

interface GitHubIssue {
    number: number;
    labels: Array<{ name: string }>;
}

export async function resetQueues(): Promise<void> {
    logger.info('Resetting all queue data...');

    try {
        const redis = new Redis({
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
        });

        const queueName = process.env.GITHUB_ISSUE_QUEUE_NAME || 'github-issue-processor';
        const keys = await redis.keys(`bull:${queueName}:*`);

        if (keys.length > 0) {
            logger.info({ queueName, keysCount: keys.length }, 'Found queue keys to delete');
            await redis.del(...keys);
            logger.info({ queueName, deletedKeys: keys.length }, 'Successfully cleared all queue data');
        } else {
            logger.info({ queueName }, 'No queue data found to clear');
        }

        await redis.quit();

    } catch (error) {
        handleError(error, 'Failed to reset queues');
        throw error;
    }
}

async function removeProcessingLabelFromIssue(
    octokit: PaginatedOctokitInstance,
    issue: GitHubIssue,
    processingLabel: string,
    repoFullName: string
): Promise<boolean> {
    const [owner, repo] = repoFullName.split('/');
    const currentLabels = issue.labels.map(label => label.name);

    if (!currentLabels.includes(processingLabel)) {
        return false;
    }

    logger.info({
        repository: repoFullName,
        issueNumber: issue.number,
        labelToRemove: processingLabel
    }, 'Removing processing label from issue (preserving done labels)');

    await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
        owner,
        repo,
        issue_number: issue.number,
        name: processingLabel
    });
    return true;
}

async function processRepoLabelReset(
    octokit: PaginatedOctokitInstance,
    repoFullName: string,
    primaryProcessingLabels: string[]
): Promise<number> {
    const [owner, repo] = repoFullName.split('/');
    if (!owner || !repo) return 0;

    logger.info({ repository: repoFullName }, 'Checking for issues with processing labels...');
    let repoResetCount = 0;

    for (const primaryLabel of primaryProcessingLabels) {
        const processingLabel = `${primaryLabel}-processing`;

        const issues = await octokit.paginate('GET /repos/{owner}/{repo}/issues', {
            owner,
            repo,
            state: 'open',
            labels: processingLabel,
            per_page: 100
        }) as GitHubIssue[];

        for (const issue of issues) {
            const wasRemoved = await removeProcessingLabelFromIssue(octokit, issue, processingLabel, repoFullName);
            if (wasRemoved) repoResetCount++;
        }
    }

    logger.info({ repository: repoFullName }, 'Processed repository for label reset');
    return repoResetCount;
}

export async function resetIssueLabels(): Promise<void> {
    logger.info('Resetting issue labels...');

    const repos = getRepos();
    if (repos.length === 0) {
        logger.warn('No repositories configured for label reset');
        return;
    }

    const primaryProcessingLabels = getPrimaryProcessingLabels();

    try {
        const octokit = await getAuthenticatedOctokit();
        let totalReset = 0;

        for (const repoFullName of repos) {
            try {
                totalReset += await processRepoLabelReset(octokit, repoFullName, primaryProcessingLabels);
            } catch (repoError) {
                const err = repoError as Error;
                logger.error({ repository: repoFullName, error: err.message }, 'Failed to reset labels for repository');
            }
        }

        logger.info({ totalIssuesReset: totalReset, repositoriesProcessed: repos.length }, 'Completed issue label reset');

    } catch (error) {
        handleError(error, 'Failed to reset issue labels');
        throw error;
    }
}
