import crypto from 'crypto';
import type { Request, Response } from 'express';
import { SUPPORTED_WEBHOOK_EVENTS, getActiveTasksForPR, logger } from '@propr/core';
import { stopTaskExecution, type StopTaskExecutionOptions } from './routes/dockerRoutes.js';

/**
 * Default TTL for webhook delivery deduplication keys in Redis (seconds).
 * Configurable via WEBHOOK_DELIVERY_TTL_SECONDS env var. Defaults to 300 (5 minutes).
 *
 * This controls how long delivery IDs are retained for duplicate detection.
 * Higher values increase Redis key retention — size the value according to
 * your Redis capacity and expected webhook volume.
 */
const DEFAULT_DELIVERY_TTL_SECONDS = 300;

export const WEBHOOK_DELIVERY_TTL_SECONDS: number = (() => {
  const env = process.env.WEBHOOK_DELIVERY_TTL_SECONDS;
  if (env) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_DELIVERY_TTL_SECONDS;
})();

/**
 * NOTE: Payload-timestamp–based staleness detection was intentionally removed.
 *
 * GitHub webhook payloads do not include a signed delivery timestamp. Fields
 * like `issue.updated_at`, `pull_request.updated_at`, and `head_commit.timestamp`
 * are resource/commit timestamps, NOT delivery timestamps. A valid webhook about
 * an older resource (e.g. pushing an older commit, or an event on a long-idle
 * issue) would be falsely rejected. Because GitHub does not expose a reliable
 * signed delivery-time signal, replay protection relies on:
 *
 * 1. HMAC signature verification (proves authenticity and body integrity).
 * 2. Redis-based delivery-ID deduplication with a configurable TTL window
 *    (prevents replays within the TTL).
 *
 * If a stronger replay window is needed, increase WEBHOOK_DELIVERY_TTL_SECONDS.
 */

/** Module-level allowlist derived from @propr/core — single source of truth. */
const SUPPORTED_EVENTS: ReadonlySet<string> = new Set(SUPPORTED_WEBHOOK_EVENTS);

/**
 * Extract and validate a single-valued header. Returns the string value,
 * or null after sending an appropriate error response.
 */
function requireSingleHeader(
  req: Request,
  res: Response,
  headerName: string,
): string | null {
  const value = req.headers[headerName];
  if (!value || Array.isArray(value)) {
    const reason = Array.isArray(value) ? 'Invalid' : 'Missing';
    const logReason = Array.isArray(value) ? 'Rejecting multi-valued' : 'Missing';
    console.warn(`[webhook] ${logReason} ${headerName} header`);
    res.status(400).send(`${reason} ${headerName} header.`);
    return null;
  }
  return value;
}

export interface WebhookHandlerDeps {
  webhookSecret: string | undefined;
  redis: {
    set: (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => Promise<string | null>;
  };
  processor: (payload: Record<string, unknown>, event: string, correlationId: string, deliveryId: string) => Promise<void>;
  correlationId: string;
  mergeTaskCancellation?: MergeTaskCancellationDeps;
}

interface MergedPullRequestPayload {
  action: 'closed';
  repository: { full_name: string };
  pull_request: { number: number; merged: true };
}

export interface MergeTaskCancellationDeps {
  redisClient: StopTaskExecutionOptions['redisClient'];
  getActiveTasksForPR?: typeof getActiveTasksForPR;
  stopTaskExecution?: typeof stopTaskExecution;
  log?: Pick<typeof logger, 'info' | 'warn'>;
}

/**
 * Core webhook request handler extracted for testability.
 *
 * Security layers:
 * 1. HMAC signature verification — proves the payload was sent by someone
 *    who knows the webhook secret and that the body has not been tampered with.
 * 2. Redis-based delivery-ID deduplication (NX + TTL) — rejects duplicate
 *    deliveries within the TTL window.
 *
 * Failure semantics: once a delivery ID is reserved in Redis, it is NOT
 * removed on downstream processing errors. This prevents a partially-
 * processed webhook from being re-accepted on a GitHub retry, which could
 * re-trigger side effects. Downstream consumers must be idempotent.
 */
export async function handleWebhookRequest(
  req: Request,
  res: Response,
  deps: WebhookHandlerDeps,
): Promise<void> {
  const { webhookSecret, redis, processor, correlationId, mergeTaskCancellation } = deps;

  // --- Fail closed if req.body is not a Buffer (middleware misconfiguration) ---
  if (!Buffer.isBuffer(req.body)) {
    console.error('[webhook] req.body is not a Buffer — expected express.raw() middleware');
    res.status(500).send('Webhook middleware misconfiguration.');
    return;
  }

  // --- Signature verification ---
  const rawSignature = req.headers['x-hub-signature-256'];
  if (Array.isArray(rawSignature)) {
    console.error('[webhook] Rejecting multi-valued x-hub-signature-256 header');
    res.status(401).send('Invalid webhook signature header.');
    return;
  }
  const signature: string | undefined = rawSignature;
  if (webhookSecret) {
    if (!signature) {
      console.error('[webhook] No signature provided');
      res.status(401).send('No webhook signature provided.');
      return;
    }
    const hmac = crypto.createHmac('sha256', webhookSecret);
    hmac.update(req.body);
    const computedSignature = `sha256=${hmac.digest('hex')}`;

    // Guard against length mismatch — timingSafeEqual throws if buffers differ in length
    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(computedSignature);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      console.error('[webhook] Signature mismatch');
      res.status(401).send('Webhook signature mismatch.');
      return;
    }
  } else {
    console.error('[webhook] GH_WEBHOOK_SECRET is not configured — rejecting request. Set GH_WEBHOOK_SECRET in the environment to accept webhooks. This is a security requirement: all webhook deliveries are rejected until a secret is provisioned.');
    res.status(500).send('Webhook secret not configured.');
    return;
  }

  // --- Validate required headers before any Redis writes ---
  const rawDeliveryId = requireSingleHeader(req, res, 'x-github-delivery');
  if (!rawDeliveryId) return;

  const rawEvent = requireSingleHeader(req, res, 'x-github-event');
  if (!rawEvent) return;

  // --- Ignore unsupported event types gracefully (before Redis write) ---
  // GitHub sends events like `ping` on webhook creation/update. Returning 200
  // avoids marking those deliveries as failed in GitHub's UI while still
  // preventing any downstream processing. Checked before Redis dedup to avoid
  // consuming dedupe keys for events that will never be processed.
  if (!SUPPORTED_EVENTS.has(rawEvent)) {
    console.log(`[webhook] Ignoring unsupported event type: ${rawEvent}`);
    res.status(200).send('Unsupported event type — ignored.');
    return;
  }

  // --- Replay protection: reject duplicate delivery IDs via Redis NX ---
  const deliveryKey = `webhook:delivery:${rawDeliveryId}`;
  const isNew = await redis.set(deliveryKey, '1', { NX: true, EX: WEBHOOK_DELIVERY_TTL_SECONDS });
  if (!isNew) {
    console.warn(`[webhook] Duplicate delivery rejected: ${rawDeliveryId}`);
    res.status(409).send('Duplicate webhook delivery.');
    return;
  }

  // The delivery ID remains reserved in Redis regardless of processing outcome.
  // This is intentional — see the JSDoc above for rationale.
  let payload: { action?: string; repository?: { full_name?: string }; [key: string]: unknown };
  try {
    payload = JSON.parse(req.body.toString());
  } catch {
    console.error(`[webhook] Failed to parse JSON body for delivery ${rawDeliveryId}`);
    res.status(400).send('Invalid JSON payload.');
    return;
  }

  console.log(`[webhook] Event received: ${rawEvent}, action: ${payload.action}, repo: ${payload.repository?.full_name}, delivery: ${rawDeliveryId}`);
  await cancelMergedPullRequestTasks(payload, correlationId, mergeTaskCancellation);
  await processor(payload, rawEvent, correlationId, rawDeliveryId);

  res.status(200).send('Webhook processed.');
}

export async function cancelMergedPullRequestTasks(
  payload: Record<string, unknown>,
  correlationId: string,
  deps?: MergeTaskCancellationDeps,
): Promise<void> {
  if (!deps || !isMergedPullRequestClose(payload)) {
    return;
  }

  const repository = payload.repository.full_name;
  const prNumber = payload.pull_request.number;
  const log = deps.log ?? logger;
  const loadActiveTasks = deps.getActiveTasksForPR ?? getActiveTasksForPR;
  const stopTask = deps.stopTaskExecution ?? stopTaskExecution;
  const cancellation = {
    code: 'pull_request_merged',
    message: `Task cancelled because pull request #${prNumber} was merged.`,
  };

  const activeTasks = await loadActiveTasks(repository, prNumber);
  if (activeTasks.length === 0) {
    log.info({ correlationId, repository, prNumber }, 'No active PR tasks to cancel after merge');
    return;
  }

  log.info({ correlationId, repository, prNumber, activeTaskCount: activeTasks.length }, 'Cancelling active PR tasks after merge');

  for (const task of activeTasks) {
    try {
      await stopTask(task.taskId, {
        redisClient: deps.redisClient,
        requestedBy: 'system',
        cancellation,
      });
    } catch (error) {
      log.warn({
        correlationId,
        repository,
        prNumber,
        taskId: task.taskId,
        error: (error as Error).message,
      }, 'Failed to cancel merged PR task');
    }
  }
}

function isMergedPullRequestClose(payload: unknown): payload is MergedPullRequestPayload {
  const prPayload = payload as Partial<MergedPullRequestPayload> & {
    repository?: { full_name?: string };
    pull_request?: { number?: number; merged?: boolean };
  };
  return prPayload.action === 'closed'
    && typeof prPayload.repository?.full_name === 'string'
    && typeof prPayload.pull_request?.number === 'number'
    && prPayload.pull_request?.merged === true;
}
