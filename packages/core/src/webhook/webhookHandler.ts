import logger from '../utils/logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetch } from 'undici';
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
    PullRequestEvent
} from '@octokit/webhooks-types';

const execAsync = promisify(exec);

// --- CONFIGURATION ---
const PROCESSOR_LABEL = 'preview-env';
const ENABLE_PREVIEW_ROUTING = process.env.ENABLE_PREVIEW_ROUTING === 'true';
const PR_API_TEMPLATE = process.env.PR_API_URL_TEMPLATE || 'http://gitfix-dashboard-api-pr-{number}:4000/webhook';

export type WebhookEventType = 'issues' | 'issue_comment' | 'pull_request_review_comment' | 'pull_request';
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

let processDetectedIssue: IssueProcessor | null = null;
let processCommentEvent: CommentProcessor | null = null;
let handleCommentDeleted: CommentDeletedHandler | null = null;
let handleCommentEdited: CommentEditedHandler | null = null;

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

// Helper: Extract Routing Context from any payload
function getRoutingContext(payload: unknown): { prNumber?: number; labels: string[] } {
    let prNumber: number | undefined;
    let labels: string[] = [];

    const p = payload as Record<string, unknown>;

    if (p.issue && typeof p.issue === 'object') {
        const issue = p.issue as Record<string, unknown>;
        prNumber = issue.number as number | undefined;
        const issueLabels = issue.labels as Array<{ name?: string } | string> | undefined;
        labels = issueLabels?.map((l) => typeof l === 'string' ? l : l.name || '') || [];
    } else if (p.pull_request && typeof p.pull_request === 'object') {
        const pr = p.pull_request as Record<string, unknown>;
        prNumber = pr.number as number | undefined;
        const prLabels = pr.labels as Array<{ name?: string } | string> | undefined;
        labels = prLabels?.map((l) => typeof l === 'string' ? l : l.name || '') || [];
    }

    return { prNumber, labels: labels.filter(Boolean) };
}

// Get the scripts directory path
function getScriptsDir(): string {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    // Navigate from packages/core/src/webhook to project root/scripts
    return path.resolve(__dirname, '../../../../scripts');
}

// 1. INFRASTRUCTURE MANAGEMENT (Universal) - Triggers for ALL PRs
async function handleInfrastructureEvents(
    payload: unknown,
    eventType: WebhookEventType,
    correlationId: string
): Promise<void> {
    if (eventType !== 'pull_request') return;
    if (!isPullRequestEvent(payload)) return;

    const prEvent = payload as PullRequestEvent;
    const prNumber = prEvent.pull_request.number;
    const action = prEvent.action;
    const log = logger.withCorrelation(correlationId);
    const scriptsDir = getScriptsDir();

    try {
        if (['opened', 'reopened', 'synchronize'].includes(action)) {
            log.info({ prNumber, action }, 'Triggering Preview Deployment...');
            const deployScript = path.join(scriptsDir, 'deploy-pr.sh');
            await execAsync(`bash "${deployScript}" ${prNumber}`);
            log.info({ prNumber }, 'Preview Deployment completed');
        } else if (action === 'closed') {
            log.info({ prNumber, action }, 'Triggering Preview Teardown...');
            const teardownScript = path.join(scriptsDir, 'teardown-pr.sh');
            await execAsync(`bash "${teardownScript}" ${prNumber}`);
            log.info({ prNumber }, 'Preview Teardown completed');
        }
    } catch (err) {
        log.error({ err, prNumber }, 'Failed to execute infrastructure script');
    }
}

// 2. ROUTING LOGIC (Conditional) - Forwards to Processor Instance
async function forwardToProcessor(
    payload: unknown,
    prNumber: number,
    correlationId: string
): Promise<void> {
    const targetUrl = PR_API_TEMPLATE.replace('{number}', prNumber.toString());
    const log = logger.withCorrelation(correlationId);

    log.info({ prNumber, targetUrl }, 'Forwarding event to Processor Instance');

    try {
        await fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        log.info({ prNumber, targetUrl }, 'Successfully forwarded webhook');
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

    // A. INFRASTRUCTURE HOOK (Always runs for PR events)
    // We run this *before* routing decisions so the env is kept up to date.
    await handleInfrastructureEvents(payload, eventType, correlationId);

    // B. ROUTING CHECK
    if (ENABLE_PREVIEW_ROUTING) {
        const { prNumber, labels } = getRoutingContext(payload);

        // If this PR has the processor label, forward everything to it
        if (prNumber && labels.includes(PROCESSOR_LABEL)) {
            await forwardToProcessor(payload, prNumber, correlationId);
            return; // STOP local processing
        }
    }

    // C. STANDARD PROCESSING (Main Instance)
    // If we didn't forward, we process it here.

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

        case 'pull_request_review_comment':
            if (isPullRequestReviewCommentEvent(payload)) {
                await handlePullRequestReviewCommentEvent(payload, correlationId);
            }
            break;

        case 'pull_request':
            // PR events are handled by infrastructure hook above
            // Local processing can be added here if needed
            correlatedLogger.debug({ event: eventType }, 'Pull request event processed by infrastructure hook');
            break;

        default:
            correlatedLogger.debug({ event: eventType }, 'Ignoring webhook event');
    }
}
