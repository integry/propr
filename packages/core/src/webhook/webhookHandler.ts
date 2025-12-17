import logger from '../utils/logger.js';
import { fetch } from 'undici';
import { exec } from 'child_process';
import { promisify } from 'util';
import type {
    IssuesEvent,
    IssuesLabeledEvent,
    IssueCommentEvent,
    IssueCommentCreatedEvent,
    IssueCommentDeletedEvent,
    IssueCommentEditedEvent,
    PullRequestReviewCommentEvent,
    PullRequestReviewCommentCreatedEvent,
    PullRequestReviewCommentDeletedEvent,
    PullRequestReviewCommentEditedEvent,
    PullRequestEvent,
    PullRequestLabeledEvent,
    PullRequestUnlabeledEvent
} from '@octokit/webhooks-types';

const execAsync = promisify(exec);

export type WebhookEventType = 'issues' | 'issue_comment' | 'pull_request_review_comment' | 'pull_request';

// --- PREVIEW ENVIRONMENT CONFIGURATION ---
// This implements the "Singleton Processor" pattern for webhook routing.
//
// The 'preview-env' label is applied to gitfix repo PRs (not source issues/PRs).
// When a gitfix PR has this label, it becomes the active processor for all webhooks.
// The routing logic is simple:
// - If an open PR is assigned the label, it becomes the processor (overriding any previous)
// - If the label is removed, the main instance becomes the processor again
// - If the PR is closed/merged, the main instance becomes the processor again
// - Source issues/comments do NOT need any special labels for processing
//
// ENABLE_PREVIEW_ROUTING: Set to 'true' to enable the preview environment feature.
const ENABLE_PREVIEW_ROUTING = process.env.ENABLE_PREVIEW_ROUTING === 'true';
// PROCESSOR_LABEL: The label that designates a gitfix PR as the active processor.
const PROCESSOR_LABEL = process.env.PROCESSOR_LABEL || 'preview-env';
// GITFIX_REPO: The gitfix repository in 'owner/repo' format. Label events from this repo
// trigger processor assignment changes.
const GITFIX_REPO = process.env.GITFIX_REPO || 'integry/gitfix';
// processorPrNumber: Dynamically tracks which gitfix PR has the 'preview-env' label.
// When set, all webhooks are forwarded to that PR's preview instance.
// When null, webhooks are processed by the main instance.
// Can be initialized from PROCESSOR_PR_NUMBER env var for backward compatibility.
let processorPrNumber: number | null = process.env.PROCESSOR_PR_NUMBER ? parseInt(process.env.PROCESSOR_PR_NUMBER, 10) : null;
const API_PORT_BASE = 20000;
const HOST_ADDRESS = process.env.HOST_GATEWAY_ADDRESS || 'http://host.docker.internal';

// Export getter for current processor PR number (useful for monitoring/debugging)
export function getProcessorPrNumber(): number | null {
    return processorPrNumber;
}
export type CommentEventType = 'issue_comment' | 'pull_request_review_comment';

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
export type CommentProcessor = (payload: IssueCommentEvent | PullRequestReviewCommentEvent, eventType: CommentEventType, correlationId: string) => Promise<void>;
export type CommentDeletedHandler = (payload: IssueCommentEvent | PullRequestReviewCommentEvent, eventType: CommentEventType, correlationId: string) => Promise<void>;
export type CommentEditedHandler = (payload: IssueCommentEvent | PullRequestReviewCommentEvent, eventType: CommentEventType, correlationId: string) => Promise<void>;
export type PullRequestProcessor = (payload: PullRequestEvent, correlationId: string) => Promise<void>;

let processDetectedIssue: IssueProcessor | null = null;
let processCommentEvent: CommentProcessor | null = null;
let handleCommentDeleted: CommentDeletedHandler | null = null;
let handleCommentEdited: CommentEditedHandler | null = null;
let processPullRequest: PullRequestProcessor | null = null;

export interface WebhookHandlerOptions {
    issueProcessor: IssueProcessor;
    commentProcessor: CommentProcessor;
    commentDeletedHandler: CommentDeletedHandler;
    commentEditedHandler: CommentEditedHandler;
    pullRequestProcessor?: PullRequestProcessor;
}

export async function initializeWebhookHandler(options: WebhookHandlerOptions): Promise<void> {
    processDetectedIssue = options.issueProcessor;
    processCommentEvent = options.commentProcessor;
    handleCommentDeleted = options.commentDeletedHandler;
    handleCommentEdited = options.commentEditedHandler;
    processPullRequest = options.pullRequestProcessor || null;
    logger.info('Webhook handler initialized');
}

function isIssuesEvent(payload: unknown): payload is IssuesEvent {
    return typeof payload === 'object' && payload !== null && 'issue' in payload && 'action' in payload && !('comment' in payload);
}

function isIssuesLabeledEvent(payload: IssuesEvent): payload is IssuesLabeledEvent {
    return payload.action === 'labeled';
}

function isIssueCommentEvent(payload: unknown): payload is IssueCommentEvent {
    return typeof payload === 'object' && payload !== null && 'issue' in payload && 'comment' in payload && 'action' in payload;
}

function isIssueCommentCreatedEvent(payload: IssueCommentEvent): payload is IssueCommentCreatedEvent {
    return payload.action === 'created';
}

function isIssueCommentDeletedEvent(payload: IssueCommentEvent): payload is IssueCommentDeletedEvent {
    return payload.action === 'deleted';
}

function isIssueCommentEditedEvent(payload: IssueCommentEvent): payload is IssueCommentEditedEvent {
    return payload.action === 'edited';
}

function isPullRequestReviewCommentEvent(payload: unknown): payload is PullRequestReviewCommentEvent {
    return typeof payload === 'object' && payload !== null && 'pull_request' in payload && 'comment' in payload && 'action' in payload;
}

function isPullRequestReviewCommentCreatedEvent(payload: PullRequestReviewCommentEvent): payload is PullRequestReviewCommentCreatedEvent {
    return payload.action === 'created';
}

function isPullRequestReviewCommentDeletedEvent(payload: PullRequestReviewCommentEvent): payload is PullRequestReviewCommentDeletedEvent {
    return payload.action === 'deleted';
}

function isPullRequestReviewCommentEditedEvent(payload: PullRequestReviewCommentEvent): payload is PullRequestReviewCommentEditedEvent {
    return payload.action === 'edited';
}

function isPullRequestEvent(payload: unknown): payload is PullRequestEvent {
    return typeof payload === 'object' && payload !== null && 'pull_request' in payload && 'action' in payload && !('comment' in payload);
}

function isPullRequestLabeledEvent(payload: PullRequestEvent): payload is PullRequestLabeledEvent {
    return payload.action === 'labeled';
}

function isPullRequestUnlabeledEvent(payload: PullRequestEvent): payload is PullRequestUnlabeledEvent {
    return payload.action === 'unlabeled';
}

// --- PROCESSOR LABEL MANAGEMENT: Track 'preview-env' label on gitfix repo PRs ---
// This function handles label events from the gitfix repo itself to dynamically
// update which PR is the active processor for webhook routing.
function handleProcessorLabelChange(
    payload: PullRequestEvent,
    correlationId: string
): void {
    const log = logger.withCorrelation(correlationId);
    const repoFullName = payload.repository.full_name;

    // Only process label events from the gitfix repo
    if (repoFullName !== GITFIX_REPO) {
        return;
    }

    const prNumber = payload.pull_request.number;
    const prState = payload.pull_request.state;

    // Handle labeled event - set this PR as the processor if label matches
    if (isPullRequestLabeledEvent(payload)) {
        const labelName = payload.label?.name;
        if (labelName === PROCESSOR_LABEL && prState === 'open') {
            const previousProcessor = processorPrNumber;
            processorPrNumber = prNumber;
            log.info(
                { prNumber, previousProcessor, label: PROCESSOR_LABEL },
                'Processor PR updated: gitfix PR labeled with preview-env'
            );
        }
        return;
    }

    // Handle unlabeled event - reset processor if this PR was the processor
    if (isPullRequestUnlabeledEvent(payload)) {
        const labelName = payload.label?.name;
        if (labelName === PROCESSOR_LABEL && processorPrNumber === prNumber) {
            log.info(
                { prNumber, label: PROCESSOR_LABEL },
                'Processor PR reset: preview-env label removed from current processor'
            );
            processorPrNumber = null;
        }
        return;
    }

    // Handle closed/merged event - reset processor if this PR was the processor
    if (payload.action === 'closed' && processorPrNumber === prNumber) {
        log.info(
            { prNumber, merged: payload.pull_request.merged },
            'Processor PR reset: gitfix PR closed/merged'
        );
        processorPrNumber = null;
    }
}

// --- INFRASTRUCTURE MANAGEMENT: Handle PR lifecycle for preview environments ---
async function handleInfrastructureEvents(
    payload: unknown,
    eventType: WebhookEventType,
    correlationId: string
): Promise<void> {
    if (eventType !== 'pull_request') return;

    const prEvent = payload as PullRequestEvent;
    const prNumber = prEvent.pull_request.number;
    const action = prEvent.action;
    const log = logger.withCorrelation(correlationId);

    try {
        if (['opened', 'reopened', 'synchronize'].includes(action)) {
            log.info({ prNumber, action }, 'Triggering Preview Deployment...');
            // In production, ensure these scripts exist and are executable
            await execAsync(`./scripts/deploy-pr.sh ${prNumber}`);
        } else if (action === 'closed') {
            log.info({ prNumber, action }, 'Triggering Preview Teardown...');
            await execAsync(`./scripts/teardown-pr.sh ${prNumber}`);
        }
    } catch (err) {
        log.error({ err, prNumber }, 'Failed to execute infrastructure script');
    }
}

// --- EVENT ROUTING: Forward webhooks to specific PR preview instance ---
async function forwardToProcessor(payload: unknown, prNumber: number, correlationId: string): Promise<void> {
    const targetPort = API_PORT_BASE + prNumber;
    const targetUrl = `${HOST_ADDRESS}:${targetPort}/webhook`;
    const log = logger.withCorrelation(correlationId);

    log.info({ prNumber, targetUrl }, 'Forwarding event to Preview Instance');

    try {
        await fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (err) {
        log.error({ err, targetUrl }, 'Failed to forward webhook');
    }
}

async function handleIssuesEvent(
    payload: IssuesEvent,
    correlationId: string
): Promise<void> {
    if (!processDetectedIssue) {
        throw new Error('Issue processor not initialized');
    }

    if (isIssuesLabeledEvent(payload)) {
        const [owner, repo] = payload.repository.full_name.split('/');

        const issue: DetectedIssue = {
            id: payload.issue.id,
            number: payload.issue.number,
            title: payload.issue.title,
            url: payload.issue.html_url,
            repoOwner: owner,
            repoName: repo,
            labels: payload.issue.labels?.map(l => typeof l === 'string' ? l : l.name) ?? [],
            createdAt: payload.issue.created_at,
            updatedAt: payload.issue.updated_at
        };

        await processDetectedIssue(issue, correlationId);
    }
}

async function handleIssueCommentEvent(
    payload: IssueCommentEvent,
    correlationId: string
): Promise<void> {
    if (!processCommentEvent || !handleCommentDeleted || !handleCommentEdited) {
        throw new Error('Comment handlers not initialized');
    }

    const hasPullRequest = 'pull_request' in payload.issue && payload.issue.pull_request;

    if (isIssueCommentCreatedEvent(payload) && hasPullRequest) {
        await processCommentEvent(payload, 'issue_comment', correlationId);
    } else if (isIssueCommentDeletedEvent(payload) && hasPullRequest) {
        await handleCommentDeleted(payload, 'issue_comment', correlationId);
    } else if (isIssueCommentEditedEvent(payload) && hasPullRequest) {
        await handleCommentEdited(payload, 'issue_comment', correlationId);
    }
}

async function handlePullRequestReviewCommentEvent(
    payload: PullRequestReviewCommentEvent,
    correlationId: string
): Promise<void> {
    if (!processCommentEvent || !handleCommentDeleted || !handleCommentEdited) {
        throw new Error('Comment handlers not initialized');
    }

    if (isPullRequestReviewCommentCreatedEvent(payload)) {
        await processCommentEvent(payload, 'pull_request_review_comment', correlationId);
    } else if (isPullRequestReviewCommentDeletedEvent(payload)) {
        await handleCommentDeleted(payload, 'pull_request_review_comment', correlationId);
    } else if (isPullRequestReviewCommentEditedEvent(payload)) {
        await handleCommentEdited(payload, 'pull_request_review_comment', correlationId);
    }
}

export async function processWebhookEvent(
    payload: unknown,
    eventType: WebhookEventType,
    correlationId: string
): Promise<void> {
    const correlatedLogger = logger.withCorrelation(correlationId);

    // 1. Handle Processor Label Changes (Watch for 'preview-env' label on gitfix repo PRs)
    // This must run BEFORE routing decisions to ensure processor state is current.
    if (ENABLE_PREVIEW_ROUTING && eventType === 'pull_request' && isPullRequestEvent(payload)) {
        handleProcessorLabelChange(payload, correlationId);
    }

    // 2. Handle Infrastructure Events (Always run for PR events when preview routing is enabled)
    if (ENABLE_PREVIEW_ROUTING) {
        await handleInfrastructureEvents(payload, eventType, correlationId);
    }

    // 3. Routing Decision: Forward to preview instance if applicable
    // Note: processorPrNumber refers to a gitfix repo PR that has the 'preview-env' label.
    // When set, ALL webhooks (from any source repo) are routed to that PR's preview instance.
    // The source issues/PRs do NOT need any special labels - routing is based solely on
    // whether a gitfix PR is designated as the processor via the 'preview-env' label.
    if (ENABLE_PREVIEW_ROUTING && processorPrNumber) {
        correlatedLogger.info(
            { processorPrNumber },
            'Forwarding webhook to designated processor PR instance'
        );
        await forwardToProcessor(payload, processorPrNumber, correlationId);
        return;
    }

    // 4. Standard Local Processing
    if (!processDetectedIssue || !processCommentEvent || !handleCommentDeleted || !handleCommentEdited) {
        correlatedLogger.error('Webhook handler not properly initialized');
        throw new Error('Webhook handler not initialized');
    }

    switch (eventType) {
        case 'issues':
            if (isIssuesEvent(payload)) {
                await handleIssuesEvent(payload, correlationId);
            }
            break;

        case 'issue_comment':
            if (isIssueCommentEvent(payload)) {
                await handleIssueCommentEvent(payload, correlationId);
            }
            break;

        case 'pull_request':
            if (isPullRequestEvent(payload) && processPullRequest) {
                await processPullRequest(payload, correlationId);
            }
            break;

        case 'pull_request_review_comment':
            if (isPullRequestReviewCommentEvent(payload)) {
                await handlePullRequestReviewCommentEvent(payload, correlationId);
            }
            break;

        default:
            correlatedLogger.debug({ event: eventType }, 'Ignoring webhook event');
    }
}
