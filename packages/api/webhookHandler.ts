import crypto from 'crypto';
import type { Request, Response } from 'express';

/** TTL for webhook delivery deduplication keys in Redis (seconds) */
export const WEBHOOK_DELIVERY_TTL_SECONDS = 300;

/**
 * Maximum age (in seconds) of a webhook request before it is considered stale.
 * Checked against the HTTP Date header when present. Uses a generous window
 * that accommodates legitimate network delays while rejecting old replays.
 */
export const WEBHOOK_MAX_AGE_SECONDS = 300;

export interface WebhookHandlerDeps {
  webhookSecret: string | undefined;
  redis: {
    set: (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => Promise<string | null>;
    del: (key: string) => Promise<number>;
  };
  processor: (payload: Record<string, unknown>, event: string, correlationId: string) => Promise<void>;
  correlationId: string;
  /** Override current time for testing (epoch seconds). */
  nowSeconds?: number;
}

/**
 * Core webhook request handler extracted for testability.
 * Validates signature, enforces delivery-ID deduplication via Redis,
 * rejects stale deliveries, validates required headers, parses the payload,
 * and delegates to the provided processor function.
 *
 * All failure paths after the Redis reservation clean up the key so that
 * GitHub retries are not permanently blocked.
 */
export async function handleWebhookRequest(
  req: Request,
  res: Response,
  deps: WebhookHandlerDeps,
): Promise<void> {
  const { webhookSecret, redis, processor, correlationId } = deps;

  // --- Signature verification ---
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
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
    console.warn('[webhook] Webhook secret not configured. Skipping signature verification.');
  }

  // --- Replay protection: reject duplicate or missing delivery IDs ---
  const rawDeliveryId = req.headers['x-github-delivery'];
  if (!rawDeliveryId || Array.isArray(rawDeliveryId)) {
    console.warn(`[webhook] ${Array.isArray(rawDeliveryId) ? 'Rejecting multi-valued' : 'Missing'} x-github-delivery header`);
    res.status(400).send(`${Array.isArray(rawDeliveryId) ? 'Invalid' : 'Missing'} x-github-delivery header.`);
    return;
  }

  // --- Stale delivery rejection ---
  // Check the HTTP Date header to reject requests that are too old.
  // This catches naïve replays of captured traffic. While a sophisticated
  // attacker could alter the Date header, the HMAC signature check above
  // ensures the payload body is authentic, and Redis dedup catches exact
  // replays within the TTL window.
  const nowSec = deps.nowSeconds ?? Math.floor(Date.now() / 1000);
  const dateHeader = req.headers['date'] as string | undefined;
  if (dateHeader) {
    const requestTimeSec = Math.floor(new Date(dateHeader).getTime() / 1000);
    if (!Number.isNaN(requestTimeSec)) {
      const ageSec = nowSec - requestTimeSec;
      if (ageSec > WEBHOOK_MAX_AGE_SECONDS) {
        console.warn(`[webhook] Stale request rejected: age=${ageSec}s, max=${WEBHOOK_MAX_AGE_SECONDS}s, delivery=${rawDeliveryId}`);
        res.status(400).send('Stale webhook request.');
        return;
      }
    }
  }

  // --- Replay protection: reject duplicate delivery IDs via Redis NX ---
  const deliveryKey = `webhook:delivery:${rawDeliveryId}`;
  const isNew = await redis.set(deliveryKey, String(nowSec), { NX: true, EX: WEBHOOK_DELIVERY_TTL_SECONDS });
  if (!isNew) {
    console.warn(`[webhook] Duplicate delivery rejected: ${rawDeliveryId}`);
    res.status(409).send('Duplicate webhook delivery.');
    return;
  }

  // --- Validate x-github-event header ---
  const rawEvent = req.headers['x-github-event'];
  if (!rawEvent || Array.isArray(rawEvent)) {
    // Clean up Redis key since we won't process this request
    await redis.del(deliveryKey).catch(() => {});
    console.warn(`[webhook] ${Array.isArray(rawEvent) ? 'Rejecting multi-valued' : 'Missing'} x-github-event header`);
    res.status(400).send(`${Array.isArray(rawEvent) ? 'Invalid' : 'Missing'} x-github-event header.`);
    return;
  }

  // Wrap post-reservation logic so failures clean up the Redis key for retries.
  // NOTE: Deleting the dedupe key on processor errors is an intentional tradeoff —
  // it allows GitHub to retry a delivery that failed due to a transient error.
  // If the processor performs partial side effects before throwing, this can lead
  // to duplicate processing. Downstream consumers should be idempotent.
  try {
    const payload = JSON.parse(req.body.toString()) as { action?: string; repository?: { full_name?: string }; [key: string]: unknown };
    console.log(`[webhook] Event received: ${rawEvent}, action: ${payload.action}, repo: ${payload.repository?.full_name}, delivery: ${rawDeliveryId}`);
    await processor(payload, rawEvent, correlationId);
  } catch (err) {
    // Clean up Redis key so GitHub can retry this delivery
    await redis.del(deliveryKey).catch(() => {});
    throw err;
  }

  res.status(200).send('Webhook processed.');
}
