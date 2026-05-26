import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fetch } from 'undici';
import { getGitHubInstallationToken } from '../auth/githubAuth.js';
import logger from '../utils/logger.js';
import type {
    PullRequestEvent,
    PullRequestLabeledEvent,
    PullRequestUnlabeledEvent
} from '@octokit/webhooks-types';
import type { WebhookEventType } from './webhookHandler.js';

const execFileAsync = promisify(execFile);

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

function isPullRequestEvent(payload: unknown): payload is PullRequestEvent {
    return typeof payload === 'object' && payload !== null && 'pull_request' in payload && 'action' in payload && !('comment' in payload);
}

const isPullRequestLabeledEvent = (payload: PullRequestEvent): payload is PullRequestLabeledEvent => payload.action === 'labeled';
const isPullRequestUnlabeledEvent = (payload: PullRequestEvent): payload is PullRequestUnlabeledEvent => payload.action === 'unlabeled';

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
            await execFileAsync('/usr/src/app/scripts/deploy-pr.sh', [String(prNumber)], {
                env: {
                    ...process.env,
                    GITHUB_TOKEN: githubToken,
                    GITHUB_REPOSITORY: githubRepository
                }
            });
        } else if (action === 'closed') {
            log.info({ prNumber, action }, 'Triggering Preview Teardown...');
            await execFileAsync('/usr/src/app/scripts/teardown-pr.sh', [String(prNumber)]);
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

export async function handlePreviewRouting(
    payload: unknown,
    eventType: WebhookEventType,
    correlationId: string,
    deliveryId: string | undefined,
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
