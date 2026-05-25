import crypto from 'crypto';
import type { Request, Response } from 'express';
import { SUPPORTED_WEBHOOK_EVENTS, logger } from '@propr/core';
import {
  cancelMergedPullRequestTasks,
  isMergedPullRequestClose,
  type MergeTaskCancellationDeps,
} from './mergedPullRequestCancellation.js';

/**
 * Default TTL for webhook delivery deduplication keys in Redis (seconds).
 * Configurable via WEBHOOK_DELIVERY_TTL_SECONDS env var. Defaults to 300 (5 minutes).
 *
 * This controls how long delivery IDs are retained for duplicate detection.
 * Higher values increase Redis key retention — size the value according to
 * your Redis capacity and expected webhook volume.
 */
const DEFAULT_DELIVERY_TTL_SECONDS = 300;
const FAILED_CANCELLATION_RETRY_TTL_SECONDS = 30;

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
    logger.warn({ headerName }, `${logReason} webhook header`);
    res.status(400).send(`${reason} ${headerName} header.`);
    return null;
  }
  return value;
}

export interface WebhookHandlerDeps {
  webhookSecret: string | undefined;
  redis: {
    set: (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => Promise<string | null>;
    del: (key: string) => Promise<number>;
  };
  processor: (payload: Record<string, unknown>, event: string, correlationId: string, deliveryId: string) => Promise<void>;
  correlationId: string;
  mergeTaskCancellation?: MergeTaskCancellationDeps;
  supportedEvents?: Iterable<string>;
  isMergedPullRequestClose?: typeof isMergedPullRequestClose;
  cancelMergedPullRequestTasks?: typeof cancelMergedPullRequestTasks;
}

type ParsedWebhookPayload = {
  action?: string;
  repository?: { full_name?: string };
  pull_request?: { number?: number };
  [key: string]: unknown;
};

type WebhookRedisClient = WebhookHandlerDeps['redis'];

interface DeliveryReservationRetryReleaseResult {
  released: boolean;
  retryTtlShortened: boolean;
}

function toSupportedEventSet(supportedEvents: Iterable<string>): ReadonlySet<string> {
  return supportedEvents instanceof Set ? supportedEvents : new Set(supportedEvents);
}

async function verifyWebhookSignature(
  req: Request,
  res: Response,
  webhookSecret: string | undefined,
): Promise<boolean> {
  if (!Buffer.isBuffer(req.body)) {
    logger.error('Webhook req.body is not a Buffer; expected express.raw() middleware');
    res.status(500).send('Webhook middleware misconfiguration.');
    return false;
  }

  const rawSignature = req.headers['x-hub-signature-256'];
  if (Array.isArray(rawSignature)) {
    logger.error('Rejecting multi-valued webhook signature header');
    res.status(401).send('Invalid webhook signature header.');
    return false;
  }

  if (!webhookSecret) {
    logger.error('GH_WEBHOOK_SECRET is not configured; rejecting webhook request');
    res.status(500).send('Webhook secret not configured.');
    return false;
  }

  if (!rawSignature) {
    logger.error('No webhook signature provided');
    res.status(401).send('No webhook signature provided.');
    return false;
  }

  const hmac = crypto.createHmac('sha256', webhookSecret);
  hmac.update(req.body);
  const computedSignature = `sha256=${hmac.digest('hex')}`;
  const sigBuf = Buffer.from(rawSignature);
  const expectedBuf = Buffer.from(computedSignature);

  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    logger.error('Webhook signature mismatch');
    res.status(401).send('Webhook signature mismatch.');
    return false;
  }

  return true;
}

async function cancelMergedPullRequestTasksOrRetry(params: {
  payload: ParsedWebhookPayload;
  rawDeliveryId: string;
  rawEvent: string;
  correlationId: string;
  deliveryKey: string;
  redis: WebhookHandlerDeps['redis'];
  mergeTaskCancellation: MergeTaskCancellationDeps;
  cancelMergedPullRequestTasksFn: typeof cancelMergedPullRequestTasks;
}): Promise<void> {
  const {
    payload,
    rawDeliveryId,
    rawEvent,
    correlationId,
    deliveryKey,
    redis,
    mergeTaskCancellation,
    cancelMergedPullRequestTasksFn,
  } = params;
  const log = mergeTaskCancellation.log ?? logger;

  try {
    await cancelMergedPullRequestTasksFn(payload, correlationId, mergeTaskCancellation);
  } catch (error) {
    const deliveryReservationRetry = await releaseDeliveryReservationForRetry({
      redis,
      deliveryKey,
      payload,
      rawDeliveryId,
      rawEvent,
      correlationId,
      log,
      failureContext: 'merged PR cancellation failure',
    });

    log.error({
      correlationId,
      deliveryId: rawDeliveryId,
      event: rawEvent,
      repository: payload.repository?.full_name,
      prNumber: payload.pull_request?.number,
      deliveryReservationReleased: deliveryReservationRetry.released,
      deliveryReservationRetryTtlShortened: deliveryReservationRetry.retryTtlShortened,
      error: (error as Error).message,
    }, deliveryReservationRetry.released
      ? 'Merged PR task cancellation failed; released webhook delivery reservation for retry'
      : deliveryReservationRetry.retryTtlShortened
        ? 'Merged PR task cancellation failed; returning 500 after shortening webhook delivery reservation TTL for retry'
        : 'Merged PR task cancellation failed; returning 500 but delivery reservation release also failed');

    throw error;
  }
}

async function runWebhookProcessorOrRetry(params: {
  payload: ParsedWebhookPayload;
  rawDeliveryId: string;
  rawEvent: string;
  correlationId: string;
  processor: WebhookHandlerDeps['processor'];
  isMergedPrClose: boolean | undefined;
  res: Response;
}): Promise<boolean> {
  const {
    payload,
    rawDeliveryId,
    rawEvent,
    correlationId,
    processor,
    isMergedPrClose,
    res,
  } = params;

  try {
    await processor(payload, rawEvent, correlationId, rawDeliveryId);
    return true;
  } catch (error) {
    if (!isMergedPrClose) {
      throw error;
    }

    logger.error({
      correlationId,
      deliveryId: rawDeliveryId,
      event: rawEvent,
      repository: payload.repository?.full_name,
      prNumber: payload.pull_request?.number,
      error: (error as Error).message,
    }, 'Merged PR task cancellation succeeded but downstream webhook processing failed; keeping webhook delivery reservation to avoid replaying downstream side effects');
    res.status(500).send('Webhook processor failed after merged pull request task cancellation.');
    return false;
  }
}

async function releaseDeliveryReservationForRetry(params: {
  redis: WebhookRedisClient;
  deliveryKey: string;
  payload: ParsedWebhookPayload;
  rawDeliveryId: string;
  rawEvent: string;
  correlationId: string;
  log: Pick<typeof logger, 'error'>;
  failureContext: string;
}): Promise<DeliveryReservationRetryReleaseResult> {
  const {
    redis,
    deliveryKey,
    payload,
    rawDeliveryId,
    rawEvent,
    correlationId,
    log,
    failureContext,
  } = params;
  try {
    const deletedKeys = await redis.del(deliveryKey);
    if (deletedKeys > 0) {
      return { released: true, retryTtlShortened: false };
    }

    const retryTtlShortened = await shortenDeliveryReservationRetryTtl({
      redis,
      deliveryKey,
      payload,
      rawDeliveryId,
      rawEvent,
      correlationId,
      log,
      failureContext,
    });
    return { released: false, retryTtlShortened };
  } catch (releaseError) {
    const retryTtlShortened = await shortenDeliveryReservationRetryTtl({
      redis,
      deliveryKey,
      payload,
      rawDeliveryId,
      rawEvent,
      correlationId,
      log,
      failureContext,
    });
    log.error({
      correlationId,
      deliveryId: rawDeliveryId,
      event: rawEvent,
      repository: payload.repository?.full_name,
      prNumber: payload.pull_request?.number,
      error: (releaseError as Error).message,
      deliveryReservationRetryTtlShortened: retryTtlShortened,
    }, `Failed to release webhook delivery reservation after ${failureContext}`);
    return { released: false, retryTtlShortened };
  }
}

async function shortenDeliveryReservationRetryTtl(params: {
  redis: WebhookRedisClient;
  deliveryKey: string;
  payload: ParsedWebhookPayload;
  rawDeliveryId: string;
  rawEvent: string;
  correlationId: string;
  log: Pick<typeof logger, 'error'>;
  failureContext: string;
}): Promise<boolean> {
  const { redis, deliveryKey, payload, rawDeliveryId, rawEvent, correlationId, log, failureContext } = params;
  try {
    await redis.set(deliveryKey, '1', { EX: FAILED_CANCELLATION_RETRY_TTL_SECONDS });
    return true;
  } catch (ttlUpdateError) {
    log.error({
      correlationId,
      deliveryId: rawDeliveryId,
      event: rawEvent,
      repository: payload.repository?.full_name,
      prNumber: payload.pull_request?.number,
      error: (ttlUpdateError as Error).message,
    }, `Failed to shorten webhook delivery reservation TTL after ${failureContext}`);
    return false;
  }
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
 * Failure semantics:
 * 1. Delivery IDs are reserved before any merge-time cancellation side effects,
 *    so duplicate GitHub deliveries are rejected before they can cancel the
 *    same task twice.
 * 2. If merge-time task cancellation fails, the reservation is released and
 *    the request returns 500 so GitHub can retry the cancellation attempt.
 * 3. If downstream processing fails after merge-time cancellation succeeds,
 *    the reservation is kept so GitHub retries cannot replay downstream side
 *    effects that may have partially completed before the failure.
 */
export async function handleWebhookRequest(
  req: Request,
  res: Response,
  deps: WebhookHandlerDeps,
): Promise<void> {
  const {
    webhookSecret,
    redis,
    processor,
    correlationId,
    mergeTaskCancellation,
    supportedEvents = SUPPORTED_EVENTS,
    isMergedPullRequestClose: isMergedPullRequestCloseFn = isMergedPullRequestClose,
    cancelMergedPullRequestTasks: cancelMergedPullRequestTasksFn = cancelMergedPullRequestTasks,
  } = deps;
  const supportedEventSet = toSupportedEventSet(supportedEvents);

  if (!await verifyWebhookSignature(req, res, webhookSecret)) {
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
  if (!supportedEventSet.has(rawEvent)) {
    logger.info({ event: rawEvent, deliveryId: rawDeliveryId }, 'Ignoring unsupported webhook event type');
    res.status(200).send('Unsupported event type — ignored.');
    return;
  }

  // Keep JSON parsing before delivery reservation so malformed deliveries are
  // rejected without consuming dedupe TTL for a payload we cannot process.
  let payload: ParsedWebhookPayload;
  try {
    payload = JSON.parse(req.body.toString());
  } catch {
    logger.error({ deliveryId: rawDeliveryId }, 'Failed to parse webhook JSON body');
    res.status(400).send('Invalid JSON payload.');
    return;
  }

  logger.info({
    event: rawEvent,
    action: payload.action,
    repository: payload.repository?.full_name,
    deliveryId: rawDeliveryId,
  }, 'Webhook event received');

  // --- Replay protection: reject duplicate delivery IDs via Redis NX ---
  const deliveryKey = `webhook:delivery:${rawDeliveryId}`;
  const isNew = await redis.set(deliveryKey, '1', { NX: true, EX: WEBHOOK_DELIVERY_TTL_SECONDS });
  if (!isNew) {
    logger.warn({ deliveryId: rawDeliveryId, event: rawEvent }, 'Duplicate webhook delivery rejected');
    res.status(409).send('Duplicate webhook delivery.');
    return;
  }

  const isMergedPrClose = mergeTaskCancellation
    && rawEvent === 'pull_request'
    && isMergedPullRequestCloseFn(payload);

  if (isMergedPrClose) {
    try {
      await cancelMergedPullRequestTasksOrRetry({
        payload,
        rawDeliveryId,
        rawEvent,
        correlationId,
        deliveryKey,
        redis,
        mergeTaskCancellation,
        cancelMergedPullRequestTasksFn,
      });
    } catch {
      res.status(500).send('Merged pull request task cancellation failed.');
      return;
    }
  }

  const processorSucceeded = await runWebhookProcessorOrRetry({
    payload,
    rawDeliveryId,
    rawEvent,
    correlationId,
    processor,
    isMergedPrClose,
    res,
  });
  if (!processorSucceeded) {
    return;
  }

  res.status(200).send('Webhook processed.');
}

export { cancelMergedPullRequestTasks };
