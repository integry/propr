import logger from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { getPrimaryProcessingLabels } from '../daemon/configLoader.js';
import { migrateRepositoryReferences } from '../services/repositoryMigrationService.js';
import { db } from '../db/connection.js';

/**
 * Checks if there are database records with old repository names that need migration.
 * Detects repository renames by checking if we have plan_issues for issue numbers
 * that exist in the webhook's repository but are stored under a different repo name.
 */
export async function checkAndMigrateRepositoryFromWebhook(
    currentRepository: string,
    issueOrPrNumber: number,
    log: ReturnType<typeof logger.withCorrelation>
): Promise<void> {
    try {
        const mismatchedRecord = await db('plan_issues')
            .where('issue_number', issueOrPrNumber)
            .whereNot('repository', currentRepository)
            .first();

        if (!mismatchedRecord) {
            const mismatchedByPR = await db('plan_issues')
                .where('pr_number', issueOrPrNumber)
                .whereNot('repository', currentRepository)
                .first();

            if (!mismatchedByPR) return;

            const oldRepository = mismatchedByPR.repository;
            log.warn({ currentRepository, oldRepository, prNumber: issueOrPrNumber },
                'Repository rename detected from webhook (by PR number) - initiating migration');

            const result = await migrateRepositoryReferences(oldRepository, currentRepository);
            log.info({ oldRepository, currentRepository, tablesUpdated: result.tablesUpdated,
                rowsAffected: result.rowsAffected, success: result.success },
                'Repository migration completed from webhook detection');
            return;
        }

        const oldRepository = mismatchedRecord.repository;
        log.warn({ currentRepository, oldRepository, issueNumber: issueOrPrNumber },
            'Repository rename detected from webhook - initiating migration');

        const result = await migrateRepositoryReferences(oldRepository, currentRepository);
        log.info({ oldRepository, currentRepository, tablesUpdated: result.tablesUpdated,
            rowsAffected: result.rowsAffected, success: result.success },
            'Repository migration completed from webhook detection');
    } catch (error) {
        log.debug({ currentRepository, issueOrPrNumber, error: (error as Error).message },
            'Repository rename check failed (non-fatal)');
    }
}

/**
 * Gets all labels from an issue.
 */
export async function getIssueLabels(
    repository: string,
    issueNumber: number,
    log: ReturnType<typeof logger.withCorrelation>
): Promise<string[]> {
    try {
        const [owner, repo] = repository.split('/');
        const octokit = await getAuthenticatedOctokit();
        const response = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
            owner, repo, issue_number: issueNumber
        });
        const labels = response.data.labels as Array<{ name: string } | string>;
        return labels.map(label => typeof label === 'string' ? label : label.name);
    } catch (error) {
        log.warn({ repository, issueNumber, error: (error as Error).message }, 'Failed to get issue labels');
        return [];
    }
}

/**
 * Adds the processing label to the Epic PR when all child issues are done.
 */
export async function addProcessingLabelToEpicPR(
    repository: string,
    epicLabel: string,
    log: ReturnType<typeof logger.withCorrelation>
): Promise<void> {
    try {
        if (!epicLabel.startsWith('base-')) {
            log.debug({ epicLabel }, 'Invalid epic label format, skipping');
            return;
        }
        const epicBranchName = epicLabel.slice(5);
        const [owner, repo] = repository.split('/');
        const octokit = await getAuthenticatedOctokit();

        const epicPRs = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
            owner, repo, head: `${owner}:${epicBranchName}`, state: 'open'
        });

        if (epicPRs.data.length === 0) {
            log.debug({ repository, epicBranchName }, 'No open Epic PR found');
            return;
        }

        const epicPR = epicPRs.data[0];
        const processingLabels = getPrimaryProcessingLabels();
        const primaryLabel = processingLabels[0] || 'AI';

        const existingLabels = epicPR.labels?.map(l => typeof l === 'string' ? l : l.name) || [];
        if (existingLabels.includes(primaryLabel)) {
            log.debug({ repository, prNumber: epicPR.number, primaryLabel }, 'Epic PR already has processing label');
            return;
        }

        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner, repo, issue_number: epicPR.number, labels: [primaryLabel]
        });

        log.info({ repository, prNumber: epicPR.number, label: primaryLabel },
            'Added processing label to Epic PR - all child issues are done');
    } catch (error) {
        log.warn({ repository, epicLabel, error: (error as Error).message },
            'Failed to add processing label to Epic PR');
    }
}
