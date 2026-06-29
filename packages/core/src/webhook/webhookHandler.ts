import logger from '../utils/logger.js';
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
    PullRequestUnlabeledEvent,
    CheckRunEvent,
    PushEvent
} from '@octokit/webhooks-types';
import type { Redis } from 'ioredis';

/** Runtime-accessible list of supported webhook event types — single source of truth. */
export const SUPPORTED_WEBHOOK_EVENTS = [
  'issues', 'issue_comment', 'pull_request_review_comment',
  'pull_request', 'check_run', 'push', 'status',
] as const;

/** Derived union type — always in sync with the runtime array. */
export type WebhookEventType = (typeof SUPPORTED_WEBHOOK_EVENTS)[number];
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
    // GitHub login of the actor that triggered processing. For webhooks: the
    // sender (label applier). For polling with a whitelist: the label applier
    // resolved from the issue timeline. For polling without a whitelist: the
    // issue author (informational only). When the actor cannot be determined
    // the issue is skipped (fail closed) — see resolveLabelApplier in
    // issueDetection.ts.
    triggeredBy?: string;
    // How this issue was detected: 'webhook' (label event) or 'polling'.
    source?: 'webhook' | 'polling';
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
            updatedAt: payload.issue.updated_at,
            // Fail closed: use only the webhook sender (the label applier).
            // Do NOT fall back to the issue author — see resolveLabelApplier
            // doc comment in issueDetection.ts for the threat model.
            triggeredBy: payload.sender?.login,
            source: 'webhook'
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

export async function processWebhookEvent(
    payload: unknown,
    eventType: WebhookEventType,
    correlationId: string,
): Promise<void> {
    const correlatedLogger = logger.withCorrelation(correlationId);

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
