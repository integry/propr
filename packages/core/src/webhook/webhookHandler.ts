import { cancelWithdrawnIntent } from '../services/taskIntent.js';
import { resolveIssueTriggerLabels } from './issueTriggerRestoration.js';
import { loadPrimaryProcessingLabels } from '../config/configManager.js';
import logger from '../utils/logger.js';
import { handlePlanIssueStatusUpdate, handlePlanPRUpdate, handlePlanPRCommentTracking, handlePlanPRCommentActivity, type CommentEventType } from './planIssueTracking.js';
import { handleCheckRunEvent, handleCheckSuiteEvent, handleStatusEvent, reevaluatePRAutoMerge } from './checkRunHandler.js';
import { clearUltrafixLoopState, getUltrafixStateRedis } from './checkRunHelpers.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { retryConfigs, withRetry } from '../utils/retryHandler.js';
import { clearUltrafixStateForLabelRemoval } from '../utils/ultrafixLabelTransition.js';
import { handleEpicPRCreationOnMerge, handleEpicPRLabelCleanup } from './epicPRHandler.js';
import { getClosedPullRequestCiRedis, recordClosedPullRequestForCiCancellation } from './closedPullRequestCi.js';
import { handlePullRequestConflictDetection, handlePushConflictDetection } from './mergeConflictDetector.js';
import { handleAutoMergePolicyPullRequestEvent } from '../services/autoMergeGate.js';
import type { IssuesEvent, IssueCommentEvent, PullRequestReviewCommentEvent, PullRequestEvent, CheckRunEvent } from '@octokit/webhooks-types';
import {
    getRepositoryFullName, isIssuesEvent, isIssuesLabeledEvent, isIssueCommentEvent, isIssueCommentCreatedEvent,
    isIssueCommentDeletedEvent, isIssueCommentEditedEvent, isPullRequestReviewCommentEvent,
    isPullRequestReviewCommentCreatedEvent, isPullRequestReviewCommentDeletedEvent,
    isPullRequestReviewCommentEditedEvent, isPullRequestEvent, isCheckRunEvent, isCheckSuiteEvent, isPushEvent, isStatusEvent,
} from './webhookPayloadGuards.js';
import { buildDeliveryInterest, type DeliveryInterest } from '../intake/routingDeliveryInterest.js';
import type { Redis } from 'ioredis';
import { ACCEPTED_NO_SEAT_DISPOSITION, ROUTING_HUB_PROTOCOL_VERSION, normalizeDisposition, type DeliveryDisposition } from '../intake/routingWebSocketProtocol.js';

import { SUPPORTED_WEBHOOK_EVENTS } from '@propr/shared';
export { SUPPORTED_WEBHOOK_EVENTS } from '@propr/shared';

// Share the merged-PR canceller's delivery budget. The cancellation promise
// remains observed after timeout so durable recording and container stops finish.
const configuredCancellationWait = Number.parseInt(process.env.MERGED_PR_CANCELLATION_WAIT_MS ?? '', 10);
export const INTENT_WITHDRAWAL_CANCELLATION_WAIT_MS = Number.isFinite(configuredCancellationWait) && configuredCancellationWait > 0
    ? configuredCancellationWait : 8_000;

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
    // the issue is skipped (fail closed) — see readTriggerApplicationEvidence in
    // triggerApplicationEvidence.ts.
    triggeredBy?: string;
    // Stable GitHub ID for the verified trigger actor. Jobs omit ownership when
    // this cannot be established, so user-scoped queue views fail closed.
    triggeredById?: string;
    // How this issue was detected: 'webhook' (label event) or 'polling'.
    source?: 'webhook' | 'polling';
    // Set only when the producer saw the trigger applied after any stale
    // `-cancelled`/`<trigger>-processing` marker. Without it, the issue stays excluded.
    triggerReapplied?: boolean;
    // The trigger whose verified application produced this detection. Admission
    // records it instead of the first configured trigger present, so removing
    // it withdraws the work it requested.
    renewedTrigger?: string;
}

export type IssueProcessor = (issue: DetectedIssue, correlationId: string) => Promise<void | DeliveryDisposition>;
export type CommentProcessor = (payload: IssueCommentEvent | PullRequestReviewCommentEvent, eventType: CommentEventType, correlationId: string) => Promise<void | DeliveryDisposition>;
export type CommentDeletedHandler = (payload: IssueCommentEvent | PullRequestReviewCommentEvent, eventType: CommentEventType, correlationId: string) => Promise<void>;
export type CommentEditedHandler = (payload: IssueCommentEvent | PullRequestReviewCommentEvent, eventType: CommentEventType, correlationId: string) => Promise<void>;
export type PullRequestProcessor = (payload: PullRequestEvent, correlationId: string) => Promise<void>;
export type CheckRunProcessor = (payload: CheckRunEvent, correlationId: string) => Promise<void>;
/**
 * Decides which repositories' events are processed. A filter that also lists the
 * normalized names it accepts lets the routing relay drop other repositories'
 * deliveries (see getWebhookDeliveryInterest); an opaque filter declares `"*"`.
 */
export type RepositoryFilter = ((repository: string) => boolean | Promise<boolean>) & {
    readonly monitoredRepositories?: () => readonly string[];
};

let processDetectedIssue: IssueProcessor | null = null;
let processCommentEvent: CommentProcessor | null = null;
let handleCommentDeleted: CommentDeletedHandler | null = null;
let handleCommentEdited: CommentEditedHandler | null = null;
let processPullRequest: PullRequestProcessor | null = null;
let processCheckRun: CheckRunProcessor | null = null;
let webhookRedisClient: Redis | null = null;
let repositoryFilter: RepositoryFilter | null = null;

export interface WebhookHandlerOptions {
    issueProcessor: IssueProcessor;
    commentProcessor: CommentProcessor;
    commentDeletedHandler: CommentDeletedHandler;
    commentEditedHandler: CommentEditedHandler;
    pullRequestProcessor?: PullRequestProcessor;
    checkRunProcessor?: CheckRunProcessor;
    redisClient?: Redis;
    repositoryFilter?: RepositoryFilter;
}

export async function initializeWebhookHandler(options: WebhookHandlerOptions): Promise<void> {
    processDetectedIssue = options.issueProcessor;
    processCommentEvent = options.commentProcessor;
    handleCommentDeleted = options.commentDeletedHandler;
    handleCommentEdited = options.commentEditedHandler;
    processPullRequest = options.pullRequestProcessor || null;
    processCheckRun = options.checkRunProcessor || null;
    webhookRedisClient = options.redisClient || null;
    repositoryFilter = options.repositoryFilter || null;
    logger.info('Webhook handler initialized');
}

/** The relay delivery-interest declaration matching the handler as currently registered. */
export function getWebhookDeliveryInterest(): DeliveryInterest {
    return buildDeliveryInterest({
        repositories: repositoryFilter?.monitoredRepositories?.() ?? '*',
        checkRunProcessorRegistered: processCheckRun !== null,
    }, ROUTING_HUB_PROTOCOL_VERSION);
}

async function handleIssuesEvent(
    payload: IssuesEvent,
    correlationId: string
): Promise<DeliveryDisposition> {
    if (!processDetectedIssue) {
        throw new Error('Issue processor not initialized');
    }

    if (isIssuesLabeledEvent(payload) && payload.issue.state !== 'closed') {
        const [owner, repo] = payload.repository.full_name.split('/');

        const resolved = await resolveIssueTriggerLabels(payload, owner, repo);
        if ('status' in resolved) return resolved;
        const { labels, triggerReapplied, renewedTrigger } = resolved;
        const issue: DetectedIssue = {
            id: payload.issue.id,
            number: payload.issue.number,
            title: payload.issue.title,
            url: payload.issue.html_url,
            repoOwner: owner,
            repoName: repo,
            labels,
            createdAt: payload.issue.created_at,
            updatedAt: payload.issue.updated_at,
            // Fail closed: use only the webhook sender (the label applier).
            // Do NOT fall back to the issue author — see readTriggerApplicationEvidence
            // doc comment in triggerApplicationEvidence.ts for the threat model.
            triggeredBy: payload.sender?.login,
            ...(payload.sender?.id === undefined ? {} : { triggeredById: String(payload.sender.id) }),
            source: 'webhook',
            ...(triggerReapplied ? { triggerReapplied: true } : {}),
            ...(renewedTrigger ? { renewedTrigger } : {})
        };

        return normalizeDisposition(await processDetectedIssue(issue, correlationId));
    }

    return { status: 'ignored', reason: 'unsupported_issue_action' };
}

async function handleUltrafixLabelRemoval(payload: unknown, eventType: WebhookEventType, correlationId: string): Promise<void> {
    const event = eventType === 'pull_request' && isPullRequestEvent(payload) ? payload
        : eventType === 'issues' && isIssuesEvent(payload) && payload.issue.pull_request ? payload : null;
    if (!event || event.action !== 'unlabeled' || event.label?.name !== 'ultrafix') return;
    const owner = event.repository.owner.login;
    const repo = event.repository.name;
    const prNumber = 'pull_request' in event ? event.pull_request.number : event.issue.number;
    const log = logger.withCorrelation(correlationId);
    if (await clearStateForCurrentUltrafixLabelRemoval(owner, repo, prNumber, log)) {
        await reevaluatePRAutoMerge(owner, repo, prNumber, { correlationId });
        log.info({ owner, repo, prNumber }, `Cleared ultrafix loop state after ${eventType === 'pull_request' ? 'PR' : 'issue'} ultrafix label removal`);
    }
}

async function clearStateForCurrentUltrafixLabelRemoval(
    owner: string,
    repo: string,
    prNumber: number,
    log: ReturnType<typeof logger.withCorrelation>,
): Promise<boolean> {
    let verificationError: unknown;
    const result = await clearUltrafixStateForLabelRemoval(
        webhookRedisClient ?? getUltrafixStateRedis(),
        { owner, repo, pr: prNumber },
        async () => {
            try {
                const octokit = await getAuthenticatedOctokit();
                const response = await withRetry(
                    () => octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
                        owner,
                        repo,
                        issue_number: prNumber,
                    }),
                    retryConfigs.githubApi,
                    'verify_ultrafix_label_removal',
                );
                const labels = response.data.labels as Array<string | { name?: string }>;
                const labelPresent = labels.some(label =>
                    (typeof label === 'string' ? label : label.name) === 'ultrafix',
                );
                return labelPresent;
            } catch (error) {
                verificationError = error;
                throw error;
            }
        },
        () => clearUltrafixLoopState(owner, repo, prNumber),
    );
    if (result === 'label_present') {
        log.info(
            { owner, repo, prNumber },
            'Ignoring stale Ultrafix label-removal event after label was re-added',
        );
    } else if (result === 'unverified') {
        log.warn(
            { owner, repo, prNumber, error: (verificationError as Error | undefined)?.message },
            'Failed to verify current Ultrafix label state; preserving loop state',
        );
        throw verificationError ?? new Error('Failed to verify current Ultrafix label state');
    }
    return result === 'cleared';
}

async function handleIssueCommentEvent(
    payload: IssueCommentEvent,
    correlationId: string
): Promise<DeliveryDisposition> {
    if (!processCommentEvent || !handleCommentDeleted || !handleCommentEdited) {
        throw new Error('Comment handlers not initialized');
    }

    const hasPullRequest = 'pull_request' in payload.issue && payload.issue.pull_request;

    if (isIssueCommentCreatedEvent(payload) && hasPullRequest) {
        return normalizeDisposition(await processCommentEvent(payload, 'issue_comment', correlationId));
    } else if (isIssueCommentDeletedEvent(payload) && hasPullRequest) {
        await handleCommentDeleted(payload, 'issue_comment', correlationId);
        return ACCEPTED_NO_SEAT_DISPOSITION;
    } else if (isIssueCommentEditedEvent(payload) && hasPullRequest) {
        await handleCommentEdited(payload, 'issue_comment', correlationId);
        return ACCEPTED_NO_SEAT_DISPOSITION;
    }

    return { status: 'ignored', reason: hasPullRequest ? 'unsupported_comment_action' : 'not_pull_request_comment' };
}

async function handlePullRequestReviewCommentEvent(
    payload: PullRequestReviewCommentEvent,
    correlationId: string
): Promise<DeliveryDisposition> {
    if (!processCommentEvent || !handleCommentDeleted || !handleCommentEdited) {
        throw new Error('Comment handlers not initialized');
    }

    if (isPullRequestReviewCommentCreatedEvent(payload)) {
        return normalizeDisposition(await processCommentEvent(payload, 'pull_request_review_comment', correlationId));
    } else if (isPullRequestReviewCommentDeletedEvent(payload)) {
        await handleCommentDeleted(payload, 'pull_request_review_comment', correlationId);
        return ACCEPTED_NO_SEAT_DISPOSITION;
    } else if (isPullRequestReviewCommentEditedEvent(payload)) {
        await handleCommentEdited(payload, 'pull_request_review_comment', correlationId);
        return ACCEPTED_NO_SEAT_DISPOSITION;
    }

    return { status: 'ignored', reason: 'unsupported_review_comment_action' };
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
 * Ensures the webhook handler dependencies have been initialized.
 */
function assertWebhookHandlerInitialized(
    correlatedLogger: ReturnType<typeof logger.withCorrelation>
): void {
    if (!processDetectedIssue || !processCommentEvent || !handleCommentDeleted || !handleCommentEdited) {
        correlatedLogger.error('Webhook handler not properly initialized');
        throw new Error('Webhook handler not initialized');
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
): Promise<DeliveryDisposition> {
    assertWebhookHandlerInitialized(correlatedLogger);

    switch (eventType) {
        case 'issues':
            if (isIssuesEvent(payload)) return await handleIssuesEvent(payload, correlationId);
            break;
        case 'issue_comment':
            if (isIssueCommentEvent(payload)) return await handleIssueCommentEvent(payload, correlationId);
            break;
        case 'pull_request':
            if (isPullRequestEvent(payload)) {
                if (processPullRequest) await processPullRequest(payload, correlationId);
                return ACCEPTED_NO_SEAT_DISPOSITION;
            }
            break;
        case 'pull_request_review_comment':
            if (isPullRequestReviewCommentEvent(payload)) return await handlePullRequestReviewCommentEvent(payload, correlationId);
            break;
        case 'check_run':
            if (isCheckRunEvent(payload)) {
                if (processCheckRun) await processCheckRun(payload, correlationId);
                return ACCEPTED_NO_SEAT_DISPOSITION;
            }
            break;
        case 'check_suite':
            if (isCheckSuiteEvent(payload)) return ACCEPTED_NO_SEAT_DISPOSITION;
            break;
        case 'push':
            if (isPushEvent(payload)) return ACCEPTED_NO_SEAT_DISPOSITION;
            break;
        case 'status':
            if (isStatusEvent(payload)) return ACCEPTED_NO_SEAT_DISPOSITION;
            break;
        default:
            correlatedLogger.debug({ event: eventType }, 'Ignoring webhook event');
    }

    return { status: 'ignored', reason: 'unsupported_event' };
}

async function handleIntentWithdrawal(payload: unknown, eventType: WebhookEventType): Promise<void> {
    if (eventType === 'issues' && isIssuesEvent(payload) && !payload.issue.pull_request) {
        const removedLabel = payload.action === 'unlabeled' ? payload.label?.name : undefined;
        const triggerRemoved = removedLabel !== undefined && (await loadPrimaryProcessingLabels()).includes(removedLabel);
        if (payload.action === 'closed' || triggerRemoved) {
            const [repoOwner, repoName] = payload.repository.full_name.split('/');
            await cancelWithdrawnIntent({ repoOwner, repoName, number: payload.issue.number, kind: 'issue', triggeringLabel: removedLabel },
                payload.action === 'closed' ? 'cancelled_issue_closed' : 'cancelled_label_removed', webhookRedisClient ?? getUltrafixStateRedis());
        }
    }
    if (eventType === 'pull_request' && isPullRequestEvent(payload) && payload.action === 'closed' && !payload.pull_request.merged) {
        const [repoOwner, repoName] = payload.repository.full_name.split('/');
        await cancelWithdrawnIntent({ repoOwner, repoName, number: payload.pull_request.number, kind: 'pr' }, 'cancelled_pr_closed', webhookRedisClient ?? getUltrafixStateRedis());
    }
}

async function handleCiEvent(payload: unknown, eventType: WebhookEventType, correlationId: string,
    correlatedLogger: ReturnType<typeof logger.withCorrelation>): Promise<void> {
    try {
        if (eventType === 'check_run' && isCheckRunEvent(payload)) await handleCheckRunEvent(payload, correlationId);
        else if (eventType === 'check_suite' && isCheckSuiteEvent(payload)) await handleCheckSuiteEvent(payload, correlationId);
        else if (eventType === 'status' && isStatusEvent(payload)) await handleStatusEvent(payload, correlationId);
    } catch (error) {
        correlatedLogger.warn({ error, event: eventType }, 'CI event handler failed, continuing');
    }
}

/**
 * Neither the daemon nor the API used to register a Redis client with the
 * handler, so detection must not depend on one being injected (it silently
 * never ran). Mergeability polling can take tens of seconds, so detection runs
 * outside the delivery instead of holding the acknowledgement.
 */
function startConflictDetection(payload: unknown, eventType: WebhookEventType, correlationId: string, correlatedLogger: ReturnType<typeof logger.withCorrelation>): void {
    let conflictDetection: Promise<unknown> | null = null;
    if (eventType === 'pull_request' && isPullRequestEvent(payload)) {
        conflictDetection = handlePullRequestConflictDetection(payload, webhookRedisClient ?? getUltrafixStateRedis(), correlationId);
    } else if (eventType === 'push' && isPushEvent(payload)) {
        conflictDetection = handlePushConflictDetection(payload, webhookRedisClient ?? getUltrafixStateRedis(), correlationId);
    }
    void conflictDetection?.catch(conflictDetectionError => {
        correlatedLogger.warn({ error: conflictDetectionError }, 'Merge conflict detection failed, continuing');
    });
}

export async function processWebhookEvent(
    payload: unknown,
    eventType: WebhookEventType,
    correlationId: string,
): Promise<DeliveryDisposition> {
    const correlatedLogger = logger.withCorrelation(correlationId);

    const repository = getRepositoryFullName(payload);
    if (repositoryFilter) {
        if (!repository) {
            correlatedLogger.warn({ event: eventType }, 'Ignoring event without a repository identity');
            return { status: 'ignored', reason: 'repository_missing' };
        }
        if (!await repositoryFilter(repository)) {
            correlatedLogger.debug({ repository, event: eventType }, 'Ignoring event for an unmonitored repository');
            return { status: 'ignored', reason: 'repository_not_monitored' };
        }
    }

    const cancellation = handleIntentWithdrawal(payload, eventType).catch(error => {
        correlatedLogger.warn({ error }, 'Intent withdrawal failed; continuing webhook handlers, polling will retry cancellation');
    });
    let waitTimer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
        cancellation.then(() => false),
        new Promise<boolean>(resolve => { waitTimer = setTimeout(() => resolve(true), INTENT_WITHDRAWAL_CANCELLATION_WAIT_MS); }),
    ]);
    clearTimeout(waitTimer);
    if (timedOut) {
        correlatedLogger.warn({ repository, waitMs: INTENT_WITHDRAWAL_CANCELLATION_WAIT_MS },
            'Intent withdrawal exceeded delivery budget; remaining cancellation work continues in the background');
    }

    await handleUltrafixLabelRemoval(payload, eventType, correlationId);

    // Plan Issue Tracking (runs before standard processing to update status)
    await handlePlanIssueTracking(payload, eventType, correlationId, correlatedLogger);

    // 5. CI events (check_run, check_suite, legacy status) drive auto-merge and Ultrafix continuation
    await handleCiEvent(payload, eventType, correlationId, correlatedLogger);

    // 6. Epic PR handling
    if (eventType === 'pull_request' && isPullRequestEvent(payload)) {
        await handleEpicPRCreationOnMerge(payload, correlationId, correlatedLogger);
        await handleEpicPRLabelCleanup(payload, correlationId, correlatedLogger);
        // A new head (or base) may add protected changes after auto-merge was armed.
        await handleAutoMergePolicyPullRequestEvent(payload, correlatedLogger);
        // A closed pull request's validation is as obsolete as one a follow-up replaces.
        if (payload.action === 'closed') await recordClosedPullRequestForCiCancellation(payload, getClosedPullRequestCiRedis());
    }

    // 7. Merge conflict detection: detect dirty PRs and enqueue auto-resolve work.
    startConflictDetection(payload, eventType, correlationId, correlatedLogger);

    // 8. Standard Local Processing; 9. then a plan issue refines only while a PR comment left follow-up work
    return await processStandardWebhookEvent(payload, eventType, correlationId, correlatedLogger).finally(() => handlePlanPRCommentActivity(payload, eventType, correlationId));
}
