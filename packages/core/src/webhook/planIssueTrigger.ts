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
import { db } from '../db/connection.js';

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

/** Starts an issue using the processing-label path owned by the epic queue. */
export async function labelPlanIssueForProcessing({
    repository, issueNumber, correlationId, draftId, epicLabel, autoMerge = true
}: {
    repository: string;
    issueNumber: number;
    correlationId?: string;
    draftId?: string;
    epicLabel?: string;
    autoMerge?: boolean;
}): Promise<void> {
    const log = logger.withCorrelation(correlationId || `epic-queue-${draftId}-${issueNumber}`);
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

    if (!autoMerge) {
        try {
            await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
                owner, repo, issue_number: issueNumber, name: 'auto-merge'
            });
        } catch (error) {
            if ((error as { status?: number }).status !== 404) throw error;
        }
    }

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

/**
 * Labels the epic PR only after all children in the draft are done.
 * A missing saved selector never counts as success: it is recovered or finalization stays owed.
 */
export async function finalizeEpicPlanIfComplete(
    draftId: string,
    canFinalize: () => Promise<boolean> = async () => true,
    recoverEpicLabel?: () => Promise<string | undefined>
): Promise<boolean> {
    const isReady = async () => {
        const issues = await getPlanIssuesByDraft(draftId);
        if (issues.some(issue => isInProgressStatus(issue.status) || issue.status === PlanIssueStatus.PENDING)) return false;
        const draft = await db('task_drafts').where({ draft_id: draftId }).first('paused');
        return !!draft && !draft.paused && await canFinalize();
    };
    const draft = await db('task_drafts').where({ draft_id: draftId }).first('repository', 'context_config');
    if (!draft || !await isReady()) return false;
    const context = parseHistoryMetadata(draft.context_config);
    const epicLabel = typeof context.epicLabel === 'string' ? context.epicLabel : await recoverEpicLabel?.();
    if (!epicLabel) {
        logger.withCorrelation(`epic-complete-${draftId}`).warn({ draftId },
            'Epic branch selector is missing; epic PR finalization deferred');
        return false;
    }
    return addProcessingLabelToEpicPR(draft.repository, epicLabel,
        logger.withCorrelation(`epic-complete-${draftId}`), isReady);
}
