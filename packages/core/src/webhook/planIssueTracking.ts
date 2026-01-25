import logger from '../utils/logger.js';
import {
    findPlanIssueByRepoAndNumber,
    findPlanIssueByRepoAndPR,
    updatePlanIssueStatus,
    linkPRToPlanIssue,
    updatePlanIssueByPR,
    type PlanIssueStatus
} from '../config/planIssueManager.js';
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
        const planIssue = await findPlanIssueByRepoAndNumber(repository, issueNumber);
        if (!planIssue) return;

        const labels = payload.issue.labels?.map(l => typeof l === 'string' ? l : l.name) ?? [];
        let newStatus: PlanIssueStatus | null = null;

        if (payload.action === 'closed') {
            newStatus = 'closed';
        } else if (payload.action === 'labeled') {
            const processingLabels = (process.env.PRIMARY_PROCESSING_LABELS || 'AI').split(',').map(l => l.trim());
            const hasProcessingLabel = labels.some(label => processingLabels.includes(label));
            if (hasProcessingLabel && planIssue.status === 'pending') {
                newStatus = 'processing';
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
                await linkPRToPlanIssue(repository, linkedIssueNumber, prNumber);
                log.info({ repository, prNumber, issueNumber: linkedIssueNumber }, 'Linked PR to plan issue');
                return linkedPlanIssue;
            }
        }
    }
    return null;
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
        let planIssue = await findPlanIssueByRepoAndPR(repository, prNumber);

        if (!planIssue && action === 'opened') {
            const prBody = payload.pull_request.body || '';
            const issueRefs = prBody.match(/(?:fixes|closes|resolves|fix|close|resolve)\s*#(\d+)/gi);
            if (issueRefs) {
                planIssue = await linkPRToReferencedPlanIssue(issueRefs, repository, prNumber, log);
            }
        }

        if (!planIssue) return;

        let newStatus: PlanIssueStatus | null = null;

        if (action === 'closed') {
            newStatus = payload.pull_request.merged ? 'merged' : 'closed';
        } else if (action === 'opened' || action === 'reopened') {
            newStatus = 'under_review';
        } else if (action === 'synchronize' && planIssue.status === 'in_refinement') {
            newStatus = 'refinement_processing';
        }

        if (newStatus) {
            await updatePlanIssueByPR(repository, prNumber, { status: newStatus });
            log.info({ repository, prNumber, newStatus }, 'Updated plan issue status from PR event');
        }
    } catch (error) {
        log.error({ error, repository, prNumber }, 'Failed to handle plan PR update');
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
            const botUsername = process.env.BOT_USERNAME || 'gitfixio[bot]';
            if (commentAuthor === botUsername) return;

            const newFollowupCount = (planIssue.followup_count || 0) + 1;
            const newStatus: PlanIssueStatus = 'in_refinement';

            await updatePlanIssueByPR(repository, prNumber, { followup_count: newFollowupCount, status: newStatus });
            log.info({ repository, prNumber, followupCount: newFollowupCount }, 'Updated plan issue follow-up count from PR comment');
        }
    } catch (error) {
        log.error({ error, repository }, 'Failed to handle plan PR comment tracking');
    }
}
