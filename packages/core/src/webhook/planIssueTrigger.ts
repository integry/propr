import logger from '../utils/logger.js';
import {
    getPlanIssuesByDraft
} from '../config/planIssueManager.js';
import {
    isInProgressStatus,
    PlanIssueStatus
} from './statusMachine.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { getPrimaryProcessingLabels } from '../daemon/configLoader.js';
import { isDraftPaused } from '../services/taskPlanning/draftPauseResume.js';

/**
 * Gets all labels from an issue.
 */
async function getIssueLabels(
    repository: string,
    issueNumber: number,
    log: ReturnType<typeof logger.withCorrelation>
): Promise<string[]> {
    try {
        const [owner, repo] = repository.split('/');
        const octokit = await getAuthenticatedOctokit();

        const response = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
            owner,
            repo,
            issue_number: issueNumber
        });

        const labels = response.data.labels as Array<{ name: string } | string>;
        return labels.map(label => typeof label === 'string' ? label : label.name);
    } catch (error) {
        log.warn({
            repository,
            issueNumber,
            error: (error as Error).message
        }, 'Failed to get issue labels');
        return [];
    }
}

/**
 * Adds the processing label to the Epic PR when all child issues are done.
 * This allows the Epic PR to react to CI checks and followup comments.
 */
async function addProcessingLabelToEpicPR(
    repository: string,
    epicLabel: string,
    log: ReturnType<typeof logger.withCorrelation>
): Promise<void> {
    try {
        // Extract the Epic branch name from the label (format: base-{branchName})
        if (!epicLabel.startsWith('base-')) {
            log.debug({ epicLabel }, 'Invalid epic label format, skipping');
            return;
        }
        const epicBranchName = epicLabel.slice(5); // Remove 'base-' prefix

        const [owner, repo] = repository.split('/');
        const octokit = await getAuthenticatedOctokit();

        // Find the Epic PR
        const epicPRs = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
            owner,
            repo,
            head: `${owner}:${epicBranchName}`,
            state: 'open'
        });

        if (epicPRs.data.length === 0) {
            log.debug({ repository, epicBranchName }, 'No open Epic PR found');
            return;
        }

        const epicPR = epicPRs.data[0];
        const processingLabels = getPrimaryProcessingLabels();
        const primaryLabel = processingLabels[0] || 'AI';

        // Check if the Epic PR already has the processing label
        const existingLabels = epicPR.labels?.map(l => typeof l === 'string' ? l : l.name) || [];
        if (existingLabels.includes(primaryLabel)) {
            log.debug({ repository, prNumber: epicPR.number, primaryLabel }, 'Epic PR already has processing label');
            return;
        }

        // Add the processing label to the Epic PR
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner,
            repo,
            issue_number: epicPR.number,
            labels: [primaryLabel]
        });

        log.info({
            repository,
            prNumber: epicPR.number,
            label: primaryLabel
        }, 'Added processing label to Epic PR - all child issues are done');

    } catch (error) {
        log.warn({
            repository,
            epicLabel,
            error: (error as Error).message
        }, 'Failed to add processing label to Epic PR');
    }
}

/**
 * Triggers the next pending issue in a plan by adding processing labels.
 * Only triggers if there are no issues currently being processed or under review.
 */
export async function triggerNextPendingIssue(
    draftId: string,
    repository: string,
    epicLabel: string | undefined,
    log: ReturnType<typeof logger.withCorrelation>
): Promise<void> {
    try {
        // Check if the draft is paused - if so, don't trigger the next issue
        const paused = await isDraftPaused(draftId);
        if (paused) {
            log.info({ draftId }, 'Skipping next issue trigger - draft execution is paused');
            return;
        }

        // Get all issues in the same plan
        const planIssues = await getPlanIssuesByDraft(draftId);

        // Check if there are any issues currently in progress (processing or under_review)
        // These statuses indicate an active PR or processing that hasn't completed yet
        const hasInProgressIssue = planIssues.some(issue => isInProgressStatus(issue.status));
        if (hasInProgressIssue) {
            const inProgressIssues = planIssues.filter(issue => isInProgressStatus(issue.status));
            log.debug({
                draftId,
                inProgressIssues: inProgressIssues.map(i => ({ number: i.issue_number, status: i.status }))
            }, 'Skipping next issue trigger - there are issues still in progress');
            return;
        }

        // Find the next pending issue
        const nextPending = planIssues.find(issue => issue.status === PlanIssueStatus.PENDING);
        if (!nextPending) {
            log.debug({ draftId }, 'No more pending issues in plan');

            // All issues are done - add processing label to Epic PR if present
            if (epicLabel) {
                await addProcessingLabelToEpicPR(repository, epicLabel, log);
            }
            return;
        }

        const [owner, repo] = repository.split('/');
        const processingLabels = getPrimaryProcessingLabels();
        const primaryLabel = processingLabels[0] || 'AI';

        // Build labels list: processing label, auto-merge, and epic label if present
        const labelsToAdd = [primaryLabel, 'auto-merge'];
        if (epicLabel) {
            labelsToAdd.push(epicLabel);
        }

        log.info({
            draftId,
            nextIssueNumber: nextPending.issue_number,
            labels: labelsToAdd
        }, 'Triggering next pending issue in plan');

        const octokit = await getAuthenticatedOctokit();

        // Add the processing labels to trigger the issue
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner,
            repo,
            issue_number: nextPending.issue_number,
            labels: labelsToAdd
        });

        log.info({
            draftId,
            issueNumber: nextPending.issue_number,
            labels: labelsToAdd
        }, 'Added processing labels to next pending issue');

    } catch (error) {
        log.warn({
            draftId,
            error: (error as Error).message
        }, 'Failed to trigger next pending issue');
    }
}

/**
 * Handles triggering the next issue after a PR is merged.
 * Checks for auto-merge label and epic label before triggering.
 */
export async function handleMergedPRNextIssueTrigger(
    repository: string,
    issueNumber: number,
    draftId: string,
    log: ReturnType<typeof logger.withCorrelation>
): Promise<void> {
    const issueLabels = await getIssueLabels(repository, issueNumber, log);
    const hasAutoMerge = issueLabels.includes('auto-merge');
    const epicLabel = issueLabels.find(label => label.startsWith('base-'));
    const isEpicSequentialMerge = !!epicLabel;
    log.info({ repository, issueNumber, issueLabels, hasAutoMerge, epicLabel, isEpicSequentialMerge }, 'Checking auto-merge for next issue trigger');

    if (!hasAutoMerge && !isEpicSequentialMerge) {
        log.info({ repository, issueNumber }, 'Skipping next issue trigger - no auto-merge or epic label');
        return;
    }

    // Trigger next issue immediately - no need to wait for Epic PR checks since:
    // 1. Child issues can start processing independently
    // 2. triggerNextPendingIssue already guards against triggering while issues are in progress
    await triggerNextPendingIssue(draftId, repository, epicLabel, log);
}
