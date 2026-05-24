import crypto from 'crypto';
import { fetch } from 'undici';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getGitHubInstallationToken } from '../auth/githubAuth.js';
import logger from '../utils/logger.js';
import type {
  PullRequestEvent,
  PullRequestLabeledEvent,
  PullRequestUnlabeledEvent,
} from '@octokit/webhooks-types';

const execAsync = promisify(exec);
const ENABLE_PREVIEW_ROUTING = process.env.ENABLE_PREVIEW_ROUTING === 'true';
const PROCESSOR_LABEL = process.env.PROCESSOR_LABEL || 'preview-env';
const PROPR_REPO = process.env.PROPR_REPO || 'integry/propr';
const API_PORT_BASE = 20000;
const HOST_ADDRESS = process.env.HOST_GATEWAY_ADDRESS || 'http://host.docker.internal';

let processorPrNumber: number | null = null;

type WebhookEventType = 'issues' | 'issue_comment' | 'pull_request_review_comment' | 'pull_request' | 'check_run' | 'push' | 'status';

export function getProcessorPrNumber(): number | null {
  return processorPrNumber;
}

export async function handlePreviewRouting(
  payload: unknown,
  eventType: WebhookEventType,
  correlationId: string,
  deliveryId: string | undefined,
): Promise<boolean> {
  if (!ENABLE_PREVIEW_ROUTING) {
    return false;
  }

  if (eventType === 'pull_request' && isPullRequestEvent(payload)) {
    handleProcessorLabelChange(payload, correlationId);
  }

  await handleInfrastructureEvents(payload, eventType, correlationId);
  if (!processorPrNumber) {
    return false;
  }

  logger.withCorrelation(correlationId).info({ processorPrNumber }, 'Forwarding webhook to designated processor PR instance');
  await forwardToProcessor(payload, processorPrNumber, eventType, {
    deliveryId: deliveryId || correlationId,
    correlationId,
  });
  return true;
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

function handleProcessorLabelChange(payload: PullRequestEvent, correlationId: string): void {
  const log = logger.withCorrelation(correlationId);
  const repoFullName = payload.repository.full_name;

  if (repoFullName !== PROPR_REPO) {
    return;
  }

  const prNumber = payload.pull_request.number;
  const prState = payload.pull_request.state;

  if (isPullRequestLabeledEvent(payload)) {
    const labelName = payload.label?.name;
    if (labelName === PROCESSOR_LABEL && prState === 'open') {
      const previousProcessor = processorPrNumber;
      processorPrNumber = prNumber;
      log.info(
        { prNumber, previousProcessor, label: PROCESSOR_LABEL },
        'Processor PR updated: ProPR PR labeled with preview-env',
      );
    }
    return;
  }

  if (isPullRequestUnlabeledEvent(payload)) {
    const labelName = payload.label?.name;
    if (labelName === PROCESSOR_LABEL && processorPrNumber === prNumber) {
      log.info(
        { prNumber, label: PROCESSOR_LABEL },
        'Processor PR reset: preview-env label removed from current processor',
      );
      processorPrNumber = null;
    }
    return;
  }

  if (payload.action === 'closed' && processorPrNumber === prNumber) {
    log.info(
      { prNumber, merged: payload.pull_request.merged },
      'Processor PR reset: ProPR PR closed/merged',
    );
    processorPrNumber = null;
  }
}

async function handleInfrastructureEvents(
  payload: unknown,
  eventType: WebhookEventType,
  correlationId: string,
): Promise<void> {
  if (eventType !== 'pull_request' || !isPullRequestEvent(payload)) {
    return;
  }

  const repoFullName = payload.repository.full_name;
  if (repoFullName !== PROPR_REPO) {
    return;
  }

  const prNumber = payload.pull_request.number;
  const action = payload.action;
  const log = logger.withCorrelation(correlationId);

  try {
    if (['opened', 'reopened', 'synchronize'].includes(action)) {
      log.info({ prNumber, action }, 'Triggering Preview Deployment...');
      const githubToken = await getGitHubInstallationToken();
      await execAsync(`/usr/src/app/scripts/deploy-pr.sh ${prNumber}`, {
        env: {
          ...process.env,
          GITHUB_TOKEN: githubToken,
          GITHUB_REPOSITORY: payload.repository.full_name,
        },
      });
    } else if (action === 'closed') {
      log.info({ prNumber, action }, 'Triggering Preview Teardown...');
      await execAsync(`/usr/src/app/scripts/teardown-pr.sh ${prNumber}`);
    }
  } catch (err) {
    log.error({ err, prNumber }, 'Failed to execute infrastructure script');
  }
}

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
