import logger from '../utils/logger.js';
import type {
    WebhookEvent,
    IssuesLabeledEvent,
    IssueCommentCreatedEvent,
    IssueCommentDeletedEvent,
    IssueCommentEditedEvent,
    PullRequestReviewCommentCreatedEvent,
    PullRequestReviewCommentDeletedEvent,
    PullRequestReviewCommentEditedEvent
} from '@octokit/webhooks-types';

export type WebhookEventType = 
    | 'issues' 
    | 'issue_comment' 
    | 'pull_request_review_comment';

export interface DetectedIssue {
    id: number;
    number: number;
    title: string;
    url: string;
    repoOwner: string;
    repoName: string;
    labels: string[];
    createdAt: string;
    updatedAt: string;
}

export type IssueProcessor = (issue: DetectedIssue, correlationId: string) => Promise<void>;
export type CommentProcessor = (payload: WebhookEvent, eventType: string, correlationId: string) => Promise<void>;
export type CommentDeletedHandler = (payload: WebhookEvent, eventType: string, correlationId: string) => Promise<void>;
export type CommentEditedHandler = (payload: WebhookEvent, eventType: string, correlationId: string) => Promise<void>;

let processDetectedIssue: IssueProcessor | undefined;
let processCommentEvent: CommentProcessor | undefined;
let handleCommentDeleted: CommentDeletedHandler | undefined;
let handleCommentEdited: CommentEditedHandler | undefined;

function isIssuesLabeledEvent(payload: WebhookEvent): payload is IssuesLabeledEvent {
    return 'issue' in payload && 'action' in payload && (payload as { action: string }).action === 'labeled';
}

function isIssueCommentEvent(payload: WebhookEvent): payload is IssueCommentCreatedEvent | IssueCommentDeletedEvent | IssueCommentEditedEvent {
    return 'comment' in payload && 'issue' in payload;
}

function isPRReviewCommentEvent(payload: WebhookEvent): payload is PullRequestReviewCommentCreatedEvent | PullRequestReviewCommentDeletedEvent | PullRequestReviewCommentEditedEvent {
    return 'comment' in payload && 'pull_request' in payload;
}

export async function initializeWebhookHandler(
    issueProcessor: IssueProcessor,
    commentProcessor: CommentProcessor,
    commentDeletedHandler: CommentDeletedHandler,
    commentEditedHandler: CommentEditedHandler
): Promise<void> {
    processDetectedIssue = issueProcessor;
    processCommentEvent = commentProcessor;
    handleCommentDeleted = commentDeletedHandler;
    handleCommentEdited = commentEditedHandler;
    logger.info('Webhook handler initialized');
}

export async function processWebhookEvent(
    payload: WebhookEvent,
    eventType: WebhookEventType,
    correlationId: string
): Promise<void> {
    const correlatedLogger = logger.withCorrelation(correlationId);

    if (!processDetectedIssue || !processCommentEvent || !handleCommentDeleted || !handleCommentEdited) {
        correlatedLogger.error('Webhook handler not properly initialized');
        throw new Error('Webhook handler not initialized');
    }

    switch (eventType) {
        case 'issues':
            if (isIssuesLabeledEvent(payload)) {
                const issuePayload = payload as IssuesLabeledEvent;
                const [owner, repo] = issuePayload.repository.full_name.split('/');

                const issue: DetectedIssue = {
                    id: issuePayload.issue.id,
                    number: issuePayload.issue.number,
                    title: issuePayload.issue.title,
                    url: issuePayload.issue.html_url,
                    repoOwner: owner,
                    repoName: repo,
                    labels: issuePayload.issue.labels?.map(l => typeof l === 'string' ? l : l.name) || [],
                    createdAt: issuePayload.issue.created_at,
                    updatedAt: issuePayload.issue.updated_at
                };

                await processDetectedIssue(issue, correlationId);
            }
            break;

        case 'issue_comment':
            if (isIssueCommentEvent(payload)) {
                const commentPayload = payload as IssueCommentCreatedEvent | IssueCommentDeletedEvent | IssueCommentEditedEvent;
                
                if (commentPayload.action === 'created' && commentPayload.issue.pull_request) {
                    await processCommentEvent(payload, 'issue_comment', correlationId);
                } else if (commentPayload.action === 'deleted' && commentPayload.issue.pull_request) {
                    await handleCommentDeleted(payload, 'issue_comment', correlationId);
                } else if (commentPayload.action === 'edited' && commentPayload.issue.pull_request) {
                    await handleCommentEdited(payload, 'issue_comment', correlationId);
                }
            }
            break;

        case 'pull_request_review_comment':
            if (isPRReviewCommentEvent(payload)) {
                const reviewPayload = payload as PullRequestReviewCommentCreatedEvent | PullRequestReviewCommentDeletedEvent | PullRequestReviewCommentEditedEvent;
                
                if (reviewPayload.action === 'created') {
                    await processCommentEvent(payload, 'pull_request_review_comment', correlationId);
                } else if (reviewPayload.action === 'deleted') {
                    await handleCommentDeleted(payload, 'pull_request_review_comment', correlationId);
                } else if (reviewPayload.action === 'edited') {
                    await handleCommentEdited(payload, 'pull_request_review_comment', correlationId);
                }
            }
            break;

        default:
            correlatedLogger.debug({ event: eventType }, 'Ignoring webhook event');
    }
}
