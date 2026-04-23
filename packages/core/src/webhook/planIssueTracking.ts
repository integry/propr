import logger from '../utils/logger.js';
import {
    findPlanIssueByRepoAndNumber,
    findPlanIssueByRepoAndPR,
    updatePlanIssueStatus,
    linkPRToPlanIssue,
    updatePlanIssueByPR,
    getPlanIssuesByDraft
} from '../config/planIssueManager.js';
import {
    determinePRStatusUpdate,
    isInProgressStatus,
    PlanIssueStatus
} from './statusMachine.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { getPrimaryProcessingLabels } from '../daemon/configLoader.js';
import { loadPrLabel } from '../config/configManager.js';
import { isDraftPaused } from '../services/taskPlanning/draftPauseResume.js';
import { migrateRepositoryReferences } from '../services/repositoryMigrationService.js';
import { db } from '../db/connection.js';
import type {
    IssuesEvent,
    IssueCommentEvent,
    PullRequestReviewCommentEvent,
    PullRequestEvent
} from '@octokit/webhooks-types';

export type CommentEventType = 'issue_comment' | 'pull_request_review_comment';

/**
 * Handles plan issue status updates based on issue label events.
 */
export async function handlePlanIssueStatusUpdate(
    payload: IssuesEvent,
    correlationId: string
): Promise<void> {
    const log = logger.withCorrelation(correlationId);
    const repository = payload.repository.full_name;
    const issueNumber = payload.issue.number;

    try {
        // Check for repository rename: if we have this issue under a different repo name, migrate
        try {
            const mismatchedRecord = await db('plan_issues')
                .where('issue_number', issueNumber)
                .whereNot('repository', repository)
                .first();

            if (mismatchedRecord) {
                const oldRepository = mismatchedRecord.repository;
                log.warn({
                    currentRepository: repository,
                    oldRepository,
                    issueNumber
                }, 'Repository rename detected from issue webhook - initiating migration');

                const result = await migrateRepositoryReferences(oldRepository, repository);
                log.info({
                    oldRepository,
                    currentRepository: repository,
                    tablesUpdated: result.tablesUpdated,
                    rowsAffected: result.rowsAffected,
                    success: result.success
                }, 'Repository migration completed from issue webhook');
            }
        } catch (renameError) {
            log.debug({ error: (renameError as Error).message }, 'Repository rename check failed (non-fatal)');
        }

        const planIssue = await findPlanIssueByRepoAndNumber(repository, issueNumber);
        if (!planIssue) return;

        const labels = payload.issue.labels?.map(l => typeof l === 'string' ? l : l.name) ?? [];
        let newStatus: PlanIssueStatus | null = null;

        if (payload.action === 'closed') {
            // Don't downgrade from 'merged' to 'closed' - when a PR is merged,
            // GitHub auto-closes the linked issue, but we want to keep 'merged' status
            if (planIssue.status !== PlanIssueStatus.MERGED) {
                newStatus = PlanIssueStatus.CLOSED;
            }
        } else if (payload.action === 'labeled') {
            const processingLabels = (process.env.PRIMARY_PROCESSING_LABELS || 'AI').split(',').map(l => l.trim());
            const hasProcessingLabel = labels.some(label => processingLabels.includes(label));
            if (hasProcessingLabel && planIssue.status === PlanIssueStatus.PENDING) {
                newStatus = PlanIssueStatus.PROCESSING;
            }
        }

        if (newStatus && newStatus !== planIssue.status) {
            await updatePlanIssueStatus(repository, issueNumber, newStatus);
            log.info({ repository, issueNumber, oldStatus: planIssue.status, newStatus }, 'Updated plan issue status');
        }
    } catch (error) {
        log.error({ error, repository, issueNumber }, 'Failed to handle plan issue status update');
    }
}

async function linkPRToReferencedPlanIssue(
    issueRefs: RegExpMatchArray,
    repository: string,
    prNumber: number,
    log: ReturnType<typeof logger.withCorrelation>
): Promise<Awaited<ReturnType<typeof findPlanIssueByRepoAndNumber>> | null> {
    for (const ref of issueRefs) {
        const match = ref.match(/#(\d+)/);
        if (match) {
            const linkedIssueNumber = parseInt(match[1], 10);
            const linkedPlanIssue = await findPlanIssueByRepoAndNumber(repository, linkedIssueNumber);
            if (linkedPlanIssue) {
                // Don't overwrite existing PR link - this prevents Epic PRs from
                // overwriting the implementation PR link when they reference issues
                if (linkedPlanIssue.pr_number && linkedPlanIssue.pr_number !== prNumber) {
                    log.debug({
                        repository,
                        prNumber,
                        issueNumber: linkedIssueNumber,
                        existingPrNumber: linkedPlanIssue.pr_number
                    }, 'Skipping PR link - plan issue already has a different PR linked');
                    continue;
                }
                await linkPRToPlanIssue(repository, linkedIssueNumber, prNumber);
                log.info({ repository, prNumber, issueNumber: linkedIssueNumber }, 'Linked PR to plan issue');
                return linkedPlanIssue;
            }
        }
    }
    return null;
}

/**
 * Handles Epic PR opened events - adds PR label
 * This allows users to post followup comments on Epic PRs for refinement.
 */
async function handleEpicPROpened(
    payload: PullRequestEvent,
    repository: string,
    prNumber: number,
    log: ReturnType<typeof logger.withCorrelation>
): Promise<void> {
    try {
        const [owner, repo] = repository.split('/');
        const prBody = payload.pull_request.body || '';

        // Find all issue references in the Epic PR body
        const issueRefs = prBody.match(/#(\d+)/g);
        if (!issueRefs || issueRefs.length === 0) {
            log.debug({ repository, prNumber }, 'Epic PR has no issue references, skipping label sync');
            return;
        }

        // Add the PR label to the Epic PR (same label used for regular PRs)
        // This allows followup comments on Epic PRs to trigger refinement
        const prLabel = await loadPrLabel();
        const octokit = await getAuthenticatedOctokit();

        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner,
            repo,
            issue_number: prNumber,
            labels: [prLabel]
        });
        log.info({ repository, prNumber, label: prLabel }, 'Added PR label to Epic PR for followup handling');
    } catch (error) {
        log.warn({
            repository,
            prNumber,
            error: (error as Error).message
        }, 'Failed to handle Epic PR opened event');
    }
}

/**
 * Handles triggering the next pending issue after a PR is merged.
 * Checks if epic PR has pending checks and defers if necessary.
 */
async function handleMergedPRNextIssueTrigger(
    repository: string,
    issueNumber: number,
    draftId: string,
    log: ReturnType<typeof logger.withCorrelation>
): Promise<void> {
    const issueLabels = await getIssueLabels(repository, issueNumber, log);
    const hasAutoMerge = issueLabels.includes('auto-merge');
    log.info({ repository, issueNumber, issueLabels, hasAutoMerge }, 'Checking auto-merge for next issue trigger');

    if (!hasAutoMerge) {
        log.info({ repository, issueNumber }, 'Skipping next issue trigger - no auto-merge label');
        return;
    }

    // Find epic label to pass to next issue (format: base-{epicBranchName})
    const epicLabel = issueLabels.find(label => label.startsWith('base-'));

    // Trigger next issue immediately - no need to wait for Epic PR checks since:
    // 1. Child issues can start processing independently
    // 2. triggerNextPendingIssue already guards against triggering while issues are in progress
    await triggerNextPendingIssue(draftId, repository, epicLabel, log);
}

// Re-export from statusMachine for backwards compatibility
export { determinePRStatusUpdate } from './statusMachine.js';

/**
 * Checks if there are database records with old repository names that need migration.
 * This detects repository renames by checking if we have plan_issues for issue numbers
 * that exist in the webhook's repository but are stored under a different repo name.
 *
 * Example: If webhook comes from 'integry/propr' for issue #1351, but our DB has
 * plan_issues for issue #1351 under 'integry/gitfix', we migrate all records.
 */
async function checkAndMigrateRepositoryFromWebhook(
    currentRepository: string,
    issueOrPrNumber: number,
    log: ReturnType<typeof logger.withCorrelation>
): Promise<void> {
    try {
        // Check if we have a plan_issue for this issue number under a DIFFERENT repository
        const mismatchedRecord = await db('plan_issues')
            .where('issue_number', issueOrPrNumber)
            .whereNot('repository', currentRepository)
            .first();

        if (!mismatchedRecord) {
            // Also check by PR number
            const mismatchedByPR = await db('plan_issues')
                .where('pr_number', issueOrPrNumber)
                .whereNot('repository', currentRepository)
                .first();

            if (!mismatchedByPR) {
                return; // No mismatch found
            }

            // Found mismatch by PR number
            const oldRepository = mismatchedByPR.repository;
            log.warn({
                currentRepository,
                oldRepository,
                prNumber: issueOrPrNumber
            }, 'Repository rename detected from webhook (by PR number) - initiating migration');

            const result = await migrateRepositoryReferences(oldRepository, currentRepository);
            log.info({
                oldRepository,
                currentRepository,
                tablesUpdated: result.tablesUpdated,
                rowsAffected: result.rowsAffected,
                success: result.success
            }, 'Repository migration completed from webhook detection');
            return;
        }

        const oldRepository = mismatchedRecord.repository;
        log.warn({
            currentRepository,
            oldRepository,
            issueNumber: issueOrPrNumber
        }, 'Repository rename detected from webhook - initiating migration');

        const result = await migrateRepositoryReferences(oldRepository, currentRepository);
        log.info({
            oldRepository,
            currentRepository,
            tablesUpdated: result.tablesUpdated,
            rowsAffected: result.rowsAffected,
            success: result.success
        }, 'Repository migration completed from webhook detection');

    } catch (error) {
        // Non-fatal: log and continue processing
        log.debug({
            currentRepository,
            issueOrPrNumber,
            error: (error as Error).message
        }, 'Repository rename check failed (non-fatal)');
    }
}

/**
 * Handles PR events to track PR associations with plan issues.
 */
export async function handlePlanPRUpdate(
    payload: PullRequestEvent,
    correlationId: string
): Promise<void> {
    const log = logger.withCorrelation(correlationId);
    const repository = payload.repository.full_name;
    const prNumber = payload.pull_request.number;
    const action = payload.action;

    try {
        // Check for repository rename before processing
        // Extract issue number from PR body if it references one
        const prBody = payload.pull_request.body || '';
        const issueRefMatch = prBody.match(/(?:fixes|closes|resolves|fix|close|resolve)\s*#(\d+)/i);
        const referencedIssue = issueRefMatch ? parseInt(issueRefMatch[1], 10) : null;

        // Check both PR number and referenced issue number for potential renames
        await checkAndMigrateRepositoryFromWebhook(repository, prNumber, log);
        if (referencedIssue) {
            await checkAndMigrateRepositoryFromWebhook(repository, referencedIssue, log);
        }

        const prTitle = payload.pull_request.title || '';
        if (prTitle.startsWith('[Epic]')) {
            if (action === 'opened') {
                await handleEpicPROpened(payload, repository, prNumber, log);
            }
            return;
        }

        let planIssue = await findPlanIssueByRepoAndPR(repository, prNumber);

        if (!planIssue && action === 'opened') {
            const prBody = payload.pull_request.body || '';
            const issueRefs = prBody.match(/(?:fixes|closes|resolves|fix|close|resolve)\s*#(\d+)/gi);
            if (issueRefs) {
                planIssue = await linkPRToReferencedPlanIssue(issueRefs, repository, prNumber, log);
            }
        }

        if (!planIssue) return;

        const newStatus = determinePRStatusUpdate(action, payload.pull_request.merged ?? false, planIssue.status);

        // Update status if there's a new status to set
        if (newStatus) {
            await updatePlanIssueByPR(repository, prNumber, { status: newStatus });
            log.info({ repository, prNumber, newStatus }, 'Updated plan issue status from PR event');
        }

        // When a PR is merged, trigger the next pending issue in the same plan
        // Only if the merged issue had auto-merge enabled (indicated by auto-merge label)
        // Check both newStatus and current status to handle race conditions where status was already updated
        const isMerged = newStatus === PlanIssueStatus.MERGED || (action === 'closed' && payload.pull_request.merged && planIssue.status === PlanIssueStatus.MERGED);
        if (isMerged && planIssue.draft_id) {
            await handleMergedPRNextIssueTrigger(repository, planIssue.issue_number, planIssue.draft_id, log);
        } else if (isMerged) {
            log.warn({ repository, prNumber, hasDraftId: !!planIssue.draft_id }, 'Merged but cannot trigger next issue - missing draft_id');
        }
    } catch (error) {
        log.error({ error, repository, prNumber }, 'Failed to handle plan PR update');
    }
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
 * Tracks comment counts on PRs linked to plan issues.
 */
export async function handlePlanPRCommentTracking(
    payload: IssueCommentEvent | PullRequestReviewCommentEvent,
    eventType: CommentEventType,
    correlationId: string
): Promise<void> {
    const log = logger.withCorrelation(correlationId);
    const repository = payload.repository.full_name;

    try {
        let prNumber: number | null = null;

        if (eventType === 'pull_request_review_comment') {
            prNumber = (payload as PullRequestReviewCommentEvent).pull_request.number;
        } else if (eventType === 'issue_comment') {
            const issuePayload = payload as IssueCommentEvent;
            if ('pull_request' in issuePayload.issue && issuePayload.issue.pull_request) {
                prNumber = issuePayload.issue.number;
            }
        }

        if (!prNumber) return;

        const planIssue = await findPlanIssueByRepoAndPR(repository, prNumber);
        if (!planIssue) return;

        if (payload.action === 'created') {
            const commentAuthor = payload.comment.user?.login;
            const botUsername = process.env.GITHUB_BOT_USERNAME || 'propr.dev[bot]';
            if (commentAuthor === botUsername) return;

            // Don't update status if the issue is already merged or closed
            if (planIssue.status === PlanIssueStatus.MERGED || planIssue.status === PlanIssueStatus.CLOSED) {
                log.debug({
                    repository,
                    prNumber,
                    currentStatus: planIssue.status
                }, 'Skipping refinement status update - plan issue already completed');
                return;
            }

            const newFollowupCount = (planIssue.followup_count || 0) + 1;
            const newStatus: PlanIssueStatus = PlanIssueStatus.IN_REFINEMENT;

            await updatePlanIssueByPR(repository, prNumber, { followup_count: newFollowupCount, status: newStatus });
            log.info({ repository, prNumber, followupCount: newFollowupCount }, 'Updated plan issue follow-up count from PR comment');
        }
    } catch (error) {
        log.error({ error, repository }, 'Failed to handle plan PR comment tracking');
    }
}
