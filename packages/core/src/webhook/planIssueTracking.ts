import logger from '../utils/logger.js';
import {
    findPlanIssueByRepoAndNumber,
    findPlanIssueByRepoAndPR,
    updatePlanIssueStatus,
    linkPRToPlanIssue,
    updatePlanIssueByPR
} from '../config/planIssueManager.js';
import {
    determinePRStatusUpdate,
    PlanIssueStatus
} from './statusMachine.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { loadPrLabel } from '../config/configManager.js';
import { checkAndMigrateRepositoryFromWebhook } from './planIssueTrackingHelpers.js';
import { handleMergedPRNextIssueTrigger } from './planIssueTrigger.js';
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
        await checkAndMigrateRepositoryFromWebhook(repository, issueNumber, log);

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

/**
 * Decides whether the PR currently linked to a plan issue is an abandoned
 * attempt that a freshly opened PR may take over. This is the reprocess case:
 * an epic issue's PR was closed without merging and reprocessing the same issue
 * recreated a new PR for it. We only take over links whose PR is closed and
 * unmerged — an active or merged PR keeps its link, which also preserves the
 * protection against an Epic PR stealing an implementation PR's link.
 */
async function isAbandonedPrLink(
    repository: string,
    existingPrNumber: number,
    planStatus: PlanIssueStatus,
    log: ReturnType<typeof logger.withCorrelation>
): Promise<boolean> {
    // Never resurrect a merged issue, regardless of what the API reports later.
    if (planStatus === PlanIssueStatus.MERGED) return false;
    try {
        const [owner, repo] = repository.split('/');
        const octokit = await getAuthenticatedOctokit();
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner,
            repo,
            pull_number: existingPrNumber
        });
        return data.state === 'closed' && !data.merged_at;
    } catch (error) {
        // If GitHub can't confirm the PR state (e.g. it was deleted), fall back to
        // our own tracked status: a CLOSED plan issue means the PR was abandoned.
        log.warn({
            repository,
            existingPrNumber,
            error: (error as Error).message
        }, 'Failed to fetch existing PR state; using plan issue status for takeover decision');
        return planStatus === PlanIssueStatus.CLOSED;
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
                // A different PR is already linked. Normally we keep it (this
                // prevents Epic PRs from overwriting the implementation PR link).
                // But when the linked PR was abandoned (closed, unmerged) and the
                // issue was reprocessed into a new PR, let the new PR take over so
                // the epic keeps flowing without recreating the whole plan.
                if (linkedPlanIssue.pr_number && linkedPlanIssue.pr_number !== prNumber) {
                    const canTakeOver = await isAbandonedPrLink(repository, linkedPlanIssue.pr_number, linkedPlanIssue.status, log);
                    if (!canTakeOver) {
                        log.debug({
                            repository,
                            prNumber,
                            issueNumber: linkedIssueNumber,
                            existingPrNumber: linkedPlanIssue.pr_number
                        }, 'Skipping PR link - plan issue already has an active or merged PR linked');
                        continue;
                    }
                    log.info({
                        repository,
                        prNumber,
                        issueNumber: linkedIssueNumber,
                        replacedPrNumber: linkedPlanIssue.pr_number
                    }, 'Recreated PR takes over abandoned PR link for reprocessed plan issue');
                }

                await linkPRToPlanIssue(repository, linkedIssueNumber, prNumber);

                // If the issue went terminal (closed) when its previous PR was
                // abandoned, bring it back to under_review so the recreated PR's
                // eventual merge triggers the next issue in the plan.
                let effectiveStatus = linkedPlanIssue.status;
                if (linkedPlanIssue.status === PlanIssueStatus.CLOSED) {
                    await updatePlanIssueStatus(repository, linkedIssueNumber, PlanIssueStatus.UNDER_REVIEW);
                    effectiveStatus = PlanIssueStatus.UNDER_REVIEW;
                    log.info({ repository, prNumber, issueNumber: linkedIssueNumber }, 'Reset plan issue from closed to under_review for reprocessed PR');
                }
                log.info({ repository, prNumber, issueNumber: linkedIssueNumber }, 'Linked PR to plan issue');
                return { ...linkedPlanIssue, pr_number: prNumber, status: effectiveStatus };
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
// Re-export from statusMachine for backwards compatibility
export { determinePRStatusUpdate } from './statusMachine.js';
// Re-export from planIssueTrigger for backwards compatibility
export { triggerNextPendingIssue } from './planIssueTrigger.js';

/**
 * Checks for repository renames by inspecting the PR body for issue references
 * and migrating database records if needed.
 */
async function checkRenamesFromPRBody(
    payload: PullRequestEvent,
    repository: string,
    prNumber: number,
    log: ReturnType<typeof logger.withCorrelation>
): Promise<void> {
    const prBody = payload.pull_request.body || '';
    const issueRefMatch = prBody.match(/(?:fixes|closes|resolves|fix|close|resolve)\s*#(\d+)/i);
    const referencedIssue = issueRefMatch ? parseInt(issueRefMatch[1], 10) : null;

    await checkAndMigrateRepositoryFromWebhook(repository, prNumber, log);
    if (referencedIssue) {
        await checkAndMigrateRepositoryFromWebhook(repository, referencedIssue, log);
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
        await checkRenamesFromPRBody(payload, repository, prNumber, log);

        const prTitle = payload.pull_request.title || '';
        if (prTitle.startsWith('[Epic]')) {
            if (action === 'opened') {
                await handleEpicPROpened(payload, repository, prNumber, log);
            }
            return;
        }

        const planIssue = await findOrLinkPlanIssue(payload, repository, prNumber, log);
        if (!planIssue) return;

        const newStatus = determinePRStatusUpdate(action, payload.pull_request.merged ?? false, planIssue.status);

        if (newStatus) {
            await updatePlanIssueByPR(repository, prNumber, { status: newStatus });
            log.info({ repository, prNumber, newStatus }, 'Updated plan issue status from PR event');
        }

        // When a PR is merged, trigger the next pending issue in the same plan
        // Check both newStatus and current status to handle race conditions
        const isMerged = newStatus === PlanIssueStatus.MERGED
            || (action === 'closed' && payload.pull_request.merged === true && planIssue.status === PlanIssueStatus.MERGED);
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
 * Attempts to find or link a plan issue for the given PR.
 * Uses payload.action internally to determine if linking should be attempted.
 */
async function findOrLinkPlanIssue(
    payload: PullRequestEvent,
    repository: string,
    prNumber: number,
    log: ReturnType<typeof logger.withCorrelation>
): Promise<Awaited<ReturnType<typeof findPlanIssueByRepoAndPR>>> {
    let planIssue = await findPlanIssueByRepoAndPR(repository, prNumber);

    if (!planIssue && payload.action === 'opened') {
        const prBody = payload.pull_request.body || '';
        const issueRefs = prBody.match(/(?:fixes|closes|resolves|fix|close|resolve)\s*#(\d+)/gi);
        if (issueRefs) {
            planIssue = await linkPRToReferencedPlanIssue(issueRefs, repository, prNumber, log);
        }
    }

    return planIssue;
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
            const botUsername = process.env.GITHUB_BOT_USERNAME || 'propr-dev[bot]';
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
