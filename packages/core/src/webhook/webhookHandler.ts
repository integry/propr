/* eslint-disable max-lines */
import logger from '../utils/logger.js';
import crypto from 'crypto';
import { fetch } from 'undici';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getGitHubInstallationToken } from '../auth/githubAuth.js';
import {
    handlePlanIssueStatusUpdate,
    handlePlanPRUpdate,
    handlePlanPRCommentTracking,
    type CommentEventType
} from './planIssueTracking.js';
import { handleCheckRunEvent, handleStatusEvent, reevaluatePRAutoMerge, type StatusEventPayload } from './checkRunHandler.js';
import { clearUltrafixLoopState } from './checkRunHelpers.js';
import { handleEpicPRCreationOnMerge, handleEpicPRLabelCleanup } from './epicPRHandler.js';
import { handlePullRequestConflictDetection, handlePushConflictDetection } from './mergeConflictDetector.js';
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
    PullRequestUnlabeledEvent,
    CheckRunEvent,
    PushEvent
} from '@octokit/webhooks-types';
import type { Redis } from 'ioredis';

const execAsync = promisify(exec);

/** Runtime-accessible list of supported webhook event types — single source of truth. */
export const SUPPORTED_WEBHOOK_EVENTS = [
  'issues', 'issue_comment', 'pull_request_review_comment',
  'pull_request', 'check_run', 'push', 'status',
] as const;

/** Derived union type — always in sync with the runtime array. */
export type WebhookEventType = (typeof SUPPORTED_WEBHOOK_EVENTS)[number];

// --- PREVIEW ENVIRONMENT CONFIGURATION ---
// This implements the "Singleton Processor" pattern for webhook routing.
//
// The 'preview-env' label is applied to ProPR repo PRs (not source issues/PRs).
// When a ProPR PR has this label, it becomes the active processor for all webhooks.
// The routing logic is simple:
// - If an open PR is assigned the label, it becomes the processor (overriding any previous)
// - If the label is removed, the main instance becomes the processor again
// - If the PR is closed/merged, the main instance becomes the processor again
// - Source issues/comments do NOT need any special labels for processing
//
// ENABLE_PREVIEW_ROUTING: Set to 'true' to enable the preview environment feature.
const ENABLE_PREVIEW_ROUTING = process.env.ENABLE_PREVIEW_ROUTING === 'true';
// PROCESSOR_LABEL: The label that designates a ProPR PR as the active processor.
const PROCESSOR_LABEL = process.env.PROCESSOR_LABEL || 'preview-env';
// PROPR_REPO: The ProPR repository in 'owner/repo' format. Label events from this repo
// trigger processor assignment changes. Default to the renamed repository.
const PROPR_REPO = process.env.PROPR_REPO || 'integry/propr';
// processorPrNumber: Dynamically tracks which ProPR PR has the 'preview-env' label.
// When set, all webhooks are forwarded to that PR's preview instance.
// When null, webhooks are processed by the main instance.
let processorPrNumber: number | null = null;
const API_PORT_BASE = 20000;
const HOST_ADDRESS = process.env.HOST_GATEWAY_ADDRESS || 'http://host.docker.internal';

// Export getter for current processor PR number (useful for monitoring/debugging)
export function getProcessorPrNumber(): number | null {
    return processorPrNumber;
}
export type { CommentEventType };

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
export type CheckRunProcessor = (payload: CheckRunEvent, correlationId: string) => Promise<void>;

let processDetectedIssue: IssueProcessor | null = null;
let processCommentEvent: CommentProcessor | null = null;
let handleCommentDeleted: CommentDeletedHandler | null = null;
let handleCommentEdited: CommentEditedHandler | null = null;
let processPullRequest: PullRequestProcessor | null = null;
let processCheckRun: CheckRunProcessor | null = null;
let webhookRedisClient: Redis | null = null;

export interface WebhookHandlerOptions {
    issueProcessor: IssueProcessor;
    commentProcessor: CommentProcessor;
    commentDeletedHandler: CommentDeletedHandler;
    commentEditedHandler: CommentEditedHandler;
    pullRequestProcessor?: PullRequestProcessor;
    checkRunProcessor?: CheckRunProcessor;
    redisClient?: Redis;
}

export async function initializeWebhookHandler(options: WebhookHandlerOptions): Promise<void> {
    processDetectedIssue = options.issueProcessor;
    processCommentEvent = options.commentProcessor;
    handleCommentDeleted = options.commentDeletedHandler;
    handleCommentEdited = options.commentEditedHandler;
    processPullRequest = options.pullRequestProcessor || null;
    processCheckRun = options.checkRunProcessor || null;
    webhookRedisClient = options.redisClient || null;
    logger.info('Webhook handler initialized');
}

function isIssuesEvent(payload: unknown): payload is IssuesEvent {
    return typeof payload === 'object' && payload !== null && 'issue' in payload && 'action' in payload && !('comment' in payload);
}

const isIssuesLabeledEvent = (payload: IssuesEvent): payload is IssuesLabeledEvent => payload.action === 'labeled';

function isIssueCommentEvent(payload: unknown): payload is IssueCommentEvent {
    return typeof payload === 'object' && payload !== null && 'issue' in payload && 'comment' in payload && 'action' in payload;
}

const isIssueCommentCreatedEvent = (payload: IssueCommentEvent): payload is IssueCommentCreatedEvent => payload.action === 'created';
const isIssueCommentDeletedEvent = (payload: IssueCommentEvent): payload is IssueCommentDeletedEvent => payload.action === 'deleted';
const isIssueCommentEditedEvent = (payload: IssueCommentEvent): payload is IssueCommentEditedEvent => payload.action === 'edited';

function isPullRequestReviewCommentEvent(payload: unknown): payload is PullRequestReviewCommentEvent {
    return typeof payload === 'object' && payload !== null && 'pull_request' in payload && 'comment' in payload && 'action' in payload;
}

const isPullRequestReviewCommentCreatedEvent = (payload: PullRequestReviewCommentEvent): payload is PullRequestReviewCommentCreatedEvent => payload.action === 'created';
const isPullRequestReviewCommentDeletedEvent = (payload: PullRequestReviewCommentEvent): payload is PullRequestReviewCommentDeletedEvent => payload.action === 'deleted';
const isPullRequestReviewCommentEditedEvent = (payload: PullRequestReviewCommentEvent): payload is PullRequestReviewCommentEditedEvent => payload.action === 'edited';

function isPullRequestEvent(payload: unknown): payload is PullRequestEvent {
    return typeof payload === 'object' && payload !== null && 'pull_request' in payload && 'action' in payload && !('comment' in payload);
}

const isPullRequestLabeledEvent = (payload: PullRequestEvent): payload is PullRequestLabeledEvent => payload.action === 'labeled';
const isPullRequestUnlabeledEvent = (payload: PullRequestEvent): payload is PullRequestUnlabeledEvent => payload.action === 'unlabeled';

function isCheckRunEvent(payload: unknown): payload is CheckRunEvent {
    return typeof payload === 'object' && payload !== null && 'check_run' in payload && 'action' in payload;
}

function isPushEvent(payload: unknown): payload is PushEvent {
    return typeof payload === 'object' && payload !== null && 'ref' in payload && 'commits' in payload && !('action' in payload);
}

function isStatusEvent(payload: unknown): payload is StatusEventPayload {
    return typeof payload === 'object' && payload !== null && 'sha' in payload && 'state' in payload && !('action' in payload) && !('commits' in payload);
}

// --- PROCESSOR LABEL MANAGEMENT: Track 'preview-env' label on ProPR repo PRs ---
// This function handles label events from the ProPR repo itself to dynamically
// update which PR is the active processor for webhook routing.
function handleProcessorLabelChange(
    payload: PullRequestEvent,
    correlationId: string
): void {
    const log = logger.withCorrelation(correlationId);
    const repoFullName = payload.repository.full_name;

    // Only process label events from the ProPR repo
    if (repoFullName !== PROPR_REPO) {
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
                'Processor PR updated: ProPR PR labeled with preview-env'
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
            'Processor PR reset: ProPR PR closed/merged'
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

    // Only handle infrastructure events for ProPR repo PRs
    const repoFullName = prEvent.repository.full_name;
    if (repoFullName !== PROPR_REPO) {
        return;
    }

    const prNumber = prEvent.pull_request.number;
    const action = prEvent.action;
    const log = logger.withCorrelation(correlationId);

    try {
        if (['opened', 'reopened', 'synchronize'].includes(action)) {
            log.info({ prNumber, action }, 'Triggering Preview Deployment...');
            // Get GitHub App installation token for PR comments
            const githubToken = await getGitHubInstallationToken();
            const githubRepository = prEvent.repository.full_name;
            // Use absolute path - scripts are copied to /usr/src/app/scripts/ in the container
            await execAsync(`/usr/src/app/scripts/deploy-pr.sh ${prNumber}`, {
                env: {
                    ...process.env,
                    GITHUB_TOKEN: githubToken,
                    GITHUB_REPOSITORY: githubRepository
                }
            });
        } else if (action === 'closed') {
            log.info({ prNumber, action }, 'Triggering Preview Teardown...');
            await execAsync(`/usr/src/app/scripts/teardown-pr.sh ${prNumber}`);
        }
    } catch (err) {
        log.error({ err, prNumber }, 'Failed to execute infrastructure script');
    }
}

// --- EVENT ROUTING: Forward webhooks to specific PR preview instance ---
async function forwardToProcessor(
    payload: unknown,
    prNumber: number,
    eventType: WebhookEventType,
    ids: { deliveryId: string; correlationId: string },
): Promise<void> {
    const { deliveryId, correlationId } = ids;
    const targetPort = API_PORT_BASE + prNumber;
    const targetUrl = `${HOST_ADDRESS}:${targetPort}/webhook`;
    const log = logger.withCorrelation(correlationId);

    log.info({ prNumber, targetUrl }, 'Forwarding event to Preview Instance');

    const body = JSON.stringify(payload);
    const forwardedDeliveryId = `fwd-${deliveryId}`;

    // Compute HMAC signature over the forwarded body so the preview instance
    // can verify authenticity using the same webhook secret.
    const webhookSecret = process.env.GH_WEBHOOK_SECRET;
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-github-event': eventType,
        'x-github-delivery': forwardedDeliveryId,
    };
    if (webhookSecret) {
        const hmac = crypto.createHmac('sha256', webhookSecret);
        hmac.update(body);
        headers['x-hub-signature-256'] = `sha256=${hmac.digest('hex')}`;
    }

    try {
        const response = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body,
        });
        if (!response.ok) {
            const responseBody = await response.text().catch(() => '<unreadable>');
            log.error(
                { prNumber, targetUrl, status: response.status, responseBody },
                'Preview instance rejected forwarded webhook',
            );
            throw new Error(`Forwarded webhook rejected by preview instance: HTTP ${response.status}`);
        }
    } catch (err) {
        log.error({ err, targetUrl }, 'Failed to forward webhook');
        throw err;
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

async function handleUltrafixLabelRemoval(
    payload: unknown,
    eventType: WebhookEventType,
    correlationId: string,
): Promise<void> {
    const log = logger.withCorrelation(correlationId);

    if (eventType === 'pull_request' && isPullRequestEvent(payload) && isPullRequestUnlabeledEvent(payload)) {
        if (payload.label?.name !== 'ultrafix') return;
        const owner = payload.repository.owner.login;
        const repo = payload.repository.name;
        const prNumber = payload.pull_request.number;
        await clearUltrafixLoopState(owner, repo, prNumber);
        await reevaluatePRAutoMerge(owner, repo, prNumber, correlationId);
        log.info({ owner, repo, prNumber }, 'Cleared ultrafix loop state after PR ultrafix label removal');
        return;
    }

    if (eventType === 'issues' && isIssuesEvent(payload)) {
        const labelName = 'label' in payload ? payload.label?.name : undefined;
        const isPrIssue = 'pull_request' in payload.issue && !!payload.issue.pull_request;
        if (payload.action !== 'unlabeled' || labelName !== 'ultrafix' || !isPrIssue) return;
        const owner = payload.repository.owner.login;
        const repo = payload.repository.name;
        const prNumber = payload.issue.number;
        await clearUltrafixLoopState(owner, repo, prNumber);
        await reevaluatePRAutoMerge(owner, repo, prNumber, correlationId);
        log.info({ owner, repo, prNumber }, 'Cleared ultrafix loop state after issue ultrafix label removal');
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

/**
 * Handles plan issue tracking for various event types.
 * This tracks plan-related events and updates the plan_issues table.
 */
async function handlePlanIssueTracking(
    payload: unknown,
    eventType: WebhookEventType,
    correlationId: string,
    correlatedLogger: ReturnType<typeof logger.withCorrelation>
): Promise<void> {
    try {
        if (eventType === 'issues' && isIssuesEvent(payload)) {
            await handlePlanIssueStatusUpdate(payload, correlationId);
        } else if (eventType === 'pull_request' && isPullRequestEvent(payload)) {
            await handlePlanPRUpdate(payload, correlationId);
        } else if (eventType === 'issue_comment' && isIssueCommentEvent(payload)) {
            await handlePlanPRCommentTracking(payload, 'issue_comment', correlationId);
        } else if (eventType === 'pull_request_review_comment' && isPullRequestReviewCommentEvent(payload)) {
            await handlePlanPRCommentTracking(payload, 'pull_request_review_comment', correlationId);
        }
    } catch (planTrackingError) {
        correlatedLogger.warn({ error: planTrackingError }, 'Plan issue tracking failed, continuing with standard processing');
    }
}

/**
 * Processes standard webhook events locally.
 */
async function processStandardWebhookEvent(
    payload: unknown,
    eventType: WebhookEventType,
    correlationId: string,
    correlatedLogger: ReturnType<typeof logger.withCorrelation>
): Promise<void> {
    if (!processDetectedIssue || !processCommentEvent || !handleCommentDeleted || !handleCommentEdited) {
        correlatedLogger.error('Webhook handler not properly initialized');
        throw new Error('Webhook handler not initialized');
    }

    switch (eventType) {
        case 'issues':
            if (isIssuesEvent(payload)) await handleIssuesEvent(payload, correlationId);
            break;
        case 'issue_comment':
            if (isIssueCommentEvent(payload)) await handleIssueCommentEvent(payload, correlationId);
            break;
        case 'pull_request':
            if (isPullRequestEvent(payload) && processPullRequest) await processPullRequest(payload, correlationId);
            break;
        case 'pull_request_review_comment':
            if (isPullRequestReviewCommentEvent(payload)) await handlePullRequestReviewCommentEvent(payload, correlationId);
            break;
        case 'check_run':
            if (isCheckRunEvent(payload) && processCheckRun) await processCheckRun(payload, correlationId);
            break;
        default:
            correlatedLogger.debug({ event: eventType }, 'Ignoring webhook event');
    }
}

async function handlePreviewRouting(
    payload: unknown, eventType: WebhookEventType, correlationId: string, deliveryId: string | undefined,
): Promise<boolean> {
    if (!ENABLE_PREVIEW_ROUTING) return false;
    if (eventType === 'pull_request' && isPullRequestEvent(payload)) {
        handleProcessorLabelChange(payload, correlationId);
    }
    await handleInfrastructureEvents(payload, eventType, correlationId);
    if (processorPrNumber) {
        logger.withCorrelation(correlationId).info({ processorPrNumber }, 'Forwarding webhook to designated processor PR instance');
        await forwardToProcessor(payload, processorPrNumber, eventType, { deliveryId: deliveryId || correlationId, correlationId });
        return true;
    }
    return false;
}

export async function processWebhookEvent(
    payload: unknown,
    eventType: WebhookEventType,
    correlationId: string,
    deliveryId?: string,
): Promise<void> {
    const correlatedLogger = logger.withCorrelation(correlationId);

    if (await handlePreviewRouting(payload, eventType, correlationId, deliveryId)) return;

    await handleUltrafixLabelRemoval(payload, eventType, correlationId);

    // Plan Issue Tracking (runs before standard processing to update status)
    await handlePlanIssueTracking(payload, eventType, correlationId, correlatedLogger);

    // 5. Auto-merge: Handle check_run events to merge PRs when all checks pass
    if (eventType === 'check_run' && isCheckRunEvent(payload)) {
        try {
            await handleCheckRunEvent(payload, correlationId);
        } catch (checkRunError) {
            correlatedLogger.warn({ error: checkRunError }, 'Check run handler failed, continuing');
        }
    }

    // 5b. Handle legacy commit status events for ultrafix loop continuation
    if (eventType === 'status' && isStatusEvent(payload)) {
        try {
            await handleStatusEvent(payload, correlationId);
        } catch (statusError) {
            correlatedLogger.warn({ error: statusError }, 'Status event handler failed, continuing');
        }
    }

    // 6. Epic PR handling
    if (eventType === 'pull_request' && isPullRequestEvent(payload)) {
        await handleEpicPRCreationOnMerge(payload, correlationId, correlatedLogger);
        await handleEpicPRLabelCleanup(payload, correlationId, correlatedLogger);
    }

    // 7. Merge conflict detection: detect dirty PRs and enqueue auto-resolve work
    if (webhookRedisClient) {
        try {
            if (eventType === 'pull_request' && isPullRequestEvent(payload)) {
                await handlePullRequestConflictDetection(payload, webhookRedisClient, correlationId);
            } else if (eventType === 'push' && isPushEvent(payload)) {
                await handlePushConflictDetection(payload, webhookRedisClient, correlationId);
            }
        } catch (conflictDetectionError) {
            correlatedLogger.warn({ error: conflictDetectionError }, 'Merge conflict detection failed, continuing');
        }
    }

    // 8. Standard Local Processing
    await processStandardWebhookEvent(payload, eventType, correlationId, correlatedLogger);
}
