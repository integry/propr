import logger from '../utils/logger.js';
import {
    getPlanIssuesByDraft,
    updatePlanIssueStatus,
    type PlanIssue
} from '../config/planIssueManager.js';
import {
    isInProgressStatus,
    PlanIssueStatus
} from './statusMachine.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { getPrimaryProcessingLabels } from '../daemon/configLoader.js';
import { isDraftPaused } from '../services/taskPlanning/draftPauseResume.js';
import { db } from '../db/connection.js';
import { getEpicExecutionQueue, finalizeCompletedEpicQueue } from '../services/taskPlanning/epicExecutionQueue.js';

interface LatestTaskHistoryRow {
    state: string;
    metadata?: string | Record<string, unknown> | null;
}

function parseHistoryMetadata(metadata: LatestTaskHistoryRow['metadata']): Record<string, unknown> {
    if (!metadata) return {};
    if (typeof metadata === 'object') return metadata;
    try {
        const parsed = JSON.parse(metadata);
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

function isTerminalNoPrTask(row: LatestTaskHistoryRow | undefined): boolean {
    if (!row) return false;
    if (row.state === 'failed' || row.state === 'cancelled') return true;
    if (row.state !== 'completed') return false;

    const metadata = parseHistoryMetadata(row.metadata);
    const prResult = metadata.prResult && typeof metadata.prResult === 'object'
        ? metadata.prResult as Record<string, unknown>
        : {};

    return metadata.pr === null || prResult.prCreated === false || prResult.prNumber === null;
}

async function latestTaskHistory(taskId: string): Promise<LatestTaskHistoryRow | undefined> {
    return db('task_history')
        .where({ task_id: taskId })
        .select('state', 'metadata')
        .orderBy('timestamp', 'desc')
        .orderBy('history_id', 'desc')
        .first<LatestTaskHistoryRow>();
}

export async function reconcileTerminalInProgressIssues(
    repository: string,
    planIssues: PlanIssue[],
    log: ReturnType<typeof logger.withCorrelation>
): Promise<PlanIssue[]> {
    const reconciledIssues = [...planIssues];

    await Promise.all(reconciledIssues.map(async (issue, index) => {
        if (!isInProgressStatus(issue.status) || !issue.task_id || issue.pr_number) return;

        const latestHistory = await latestTaskHistory(issue.task_id);
        if (!isTerminalNoPrTask(latestHistory)) return;

        await updatePlanIssueStatus(repository, issue.issue_number, PlanIssueStatus.CLOSED);
        reconciledIssues[index] = { ...issue, status: PlanIssueStatus.CLOSED };
        log.warn({
            repository,
            issueNumber: issue.issue_number,
            taskId: issue.task_id,
            taskState: latestHistory?.state
        }, 'Reconciled stale in-progress plan issue from terminal task without PR');
    }));

    return reconciledIssues;
}

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
    log: ReturnType<typeof logger.withCorrelation>,
    canFinalize: () => Promise<boolean>
): Promise<boolean> {
    try {
        // Extract the Epic branch name from the label (format: base-{branchName})
        if (!epicLabel.startsWith('base-')) {
            log.debug({ epicLabel }, 'Invalid epic label format, skipping');
            return true;
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

        if (!await canFinalize()) return false;

        if (epicPRs.data.length === 0) {
            log.debug({ repository, epicBranchName }, 'No open Epic PR found');
            return true;
        }

        const epicPR = epicPRs.data[0];
        const processingLabels = getPrimaryProcessingLabels();
        const primaryLabel = processingLabels[0] || 'AI';

        // Check if the Epic PR already has the processing label
        const existingLabels = epicPR.labels?.map(l => typeof l === 'string' ? l : l.name) || [];
        if (existingLabels.includes(primaryLabel)) {
            log.debug({ repository, prNumber: epicPR.number, primaryLabel }, 'Epic PR already has processing label');
            return true;
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
        return true;

    } catch (error) {
        log.warn({
            repository,
            epicLabel,
            error: (error as Error).message
        }, 'Failed to add processing label to Epic PR');
        return false;
    }
}

/** Starts an issue using the same processing-label path as the legacy epic chain. */
export async function labelPlanIssueForProcessing({
    repository, issueNumber, correlationId, draftId, epicLabel, autoMerge = true, log: suppliedLog, canStart
}: {
    repository: string;
    issueNumber: number;
    correlationId?: string;
    draftId?: string;
    epicLabel?: string;
    autoMerge?: boolean;
    log?: ReturnType<typeof logger.withCorrelation>;
    canStart?: () => Promise<boolean>;
}): Promise<void> {
    const log = suppliedLog ?? logger.withCorrelation(correlationId || `epic-queue-${draftId}-${issueNumber}`);
    const [owner, repo] = repository.split('/');
    const processingLabels = getPrimaryProcessingLabels();
    const primaryLabel = processingLabels[0] || 'AI';

    // Build labels list: processing label, auto-merge, and epic label if present
    const labelsToAdd = [primaryLabel];
    if (autoMerge) labelsToAdd.push('auto-merge');
    if (epicLabel) {
        labelsToAdd.push(epicLabel);
    }

    log.info({
        draftId,
        nextIssueNumber: issueNumber,
        labels: labelsToAdd
    }, 'Triggering next pending issue in plan');

    const octokit = await getAuthenticatedOctokit();

    if (canStart && !await canStart()) return;

    // Add the processing labels to trigger the issue
    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
        owner,
        repo,
        issue_number: issueNumber,
        labels: labelsToAdd
    });

    log.info({
        draftId,
        issueNumber: issueNumber,
        labels: labelsToAdd
    }, 'Added processing labels to next pending issue');

}

/** Labels the epic PR only after all children in the draft are done. */
export async function finalizeEpicPlanIfComplete(draftId: string, legacy?: {
    repository: string; epicLabel?: string; log: ReturnType<typeof logger.withCorrelation>;
}, canFinalize: () => Promise<boolean> = async () => true): Promise<boolean> {
    const isReady = async () => {
        const issues = await getPlanIssuesByDraft(draftId);
        if (issues.some(issue => isInProgressStatus(issue.status) || issue.status === PlanIssueStatus.PENDING)) return false;
        const draft = await db('task_drafts').where({ draft_id: draftId }).first('paused');
        return !!draft && !draft.paused && await canFinalize();
    };
    const draft = await db('task_drafts').where({ draft_id: draftId }).first('repository', 'context_config');
    if (!draft || !await isReady()) return false;
    const context = parseHistoryMetadata(draft.context_config);
    const epicLabel = legacy ? legacy.epicLabel : typeof context.epicLabel === 'string' ? context.epicLabel : undefined;
    if (!epicLabel) return true;
    return addProcessingLabelToEpicPR(legacy?.repository ?? draft.repository, epicLabel,
        legacy?.log ?? logger.withCorrelation(`epic-complete-${draftId}`), isReady);
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
        const queue = await getEpicExecutionQueue(draftId);
        // Only an active queue owns progression; finished subsets return control to the UI chain.
        if (queue?.status === 'active') {
            log.info({ draftId, handledBy: 'epic_execution_queue' }, 'Queue owns plan issue progression');
            return;
        }

        const legacyOwnsProgression = async () => (await getEpicExecutionQueue(draftId))?.status !== 'active';

        // Check if the draft is paused - if so, don't trigger the next issue
        const paused = await isDraftPaused(draftId);
        if (paused) {
            log.info({ draftId }, 'Skipping next issue trigger - draft execution is paused');
            return;
        }

        // Get all issues in the same plan
        const planIssues = await reconcileTerminalInProgressIssues(
            repository,
            await getPlanIssuesByDraft(draftId),
            log
        );

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
            if (queue?.status === 'completed') {
                await finalizeCompletedEpicQueue(draftId, {}, queue.executionId);
            } else {
                await finalizeEpicPlanIfComplete(draftId, { repository, epicLabel, log }, legacyOwnsProgression);
            }
            return;
        }

        await labelPlanIssueForProcessing({ repository, issueNumber: nextPending.issue_number, draftId, epicLabel, log,
            canStart: legacyOwnsProgression });

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
