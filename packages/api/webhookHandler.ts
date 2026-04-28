import crypto from 'crypto';
import type { Request, Response } from 'express';
import { SUPPORTED_WEBHOOK_EVENTS } from '@propr/core';

/**
 * TTL for webhook delivery deduplication keys in Redis (seconds).
 * Set to 24 hours to provide a wide replay-protection window. GitHub retries
 * deliveries for up to 24 hours, so this window ensures that both genuine
 * retries and malicious replays within that period are caught.
 */
export const WEBHOOK_DELIVERY_TTL_SECONDS = 86_400;

/** Module-level allowlist derived from @propr/core — single source of truth. */
const SUPPORTED_EVENTS: ReadonlySet<string> = new Set(SUPPORTED_WEBHOOK_EVENTS);

export interface WebhookHandlerDeps {
  webhookSecret: string | undefined;
  redis: {
    set: (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => Promise<string | null>;
  };
  processor: (payload: Record<string, unknown>, event: string, correlationId: string) => Promise<void>;
  correlationId: string;
}

/**
 * Core webhook request handler extracted for testability.
 *
 * Security layers:
 * 1. HMAC signature verification — proves the payload was sent by someone
 *    who knows the webhook secret and that the body has not been tampered with.
 * 2. Redis-based delivery-ID deduplication (NX + TTL) — rejects exact replays
 *    within the TTL window. This is the primary replay-protection mechanism.
 *
 * Stale-request protection: GitHub does not include a signed timestamp in
 * webhook deliveries — the `Date` header is not covered by the HMAC. This
 * means true clock-based staleness rejection is impossible without a trusted,
 * authenticated timestamp from GitHub. Instead, we set a 24-hour TTL on the
 * delivery-ID dedup key ({@link WEBHOOK_DELIVERY_TTL_SECONDS}), which matches
 * GitHub's own retry window. Any captured signed payload replayed within 24
 * hours is rejected by the NX guard; after 24 hours the delivery ID expires,
 * but the practical replay risk at that point is minimal because GitHub will
 * have already stopped retrying and the delivery is considered stale by the
 * platform itself.
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
  const { webhookSecret, redis, processor, correlationId } = deps;

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
    console.error('[webhook] GH_WEBHOOK_SECRET is not configured — rejecting request. Set the environment variable to accept webhooks.');
    res.status(500).send('Webhook secret not configured.');
    return;
  }

  // --- Validate required headers before any Redis writes ---
  const rawDeliveryId = req.headers['x-github-delivery'];
  if (!rawDeliveryId || Array.isArray(rawDeliveryId)) {
    console.warn(`[webhook] ${Array.isArray(rawDeliveryId) ? 'Rejecting multi-valued' : 'Missing'} x-github-delivery header`);
    res.status(400).send(`${Array.isArray(rawDeliveryId) ? 'Invalid' : 'Missing'} x-github-delivery header.`);
    return;
  }

  const rawEvent = req.headers['x-github-event'];
  if (!rawEvent || Array.isArray(rawEvent)) {
    console.warn(`[webhook] ${Array.isArray(rawEvent) ? 'Rejecting multi-valued' : 'Missing'} x-github-event header`);
    res.status(400).send(`${Array.isArray(rawEvent) ? 'Invalid' : 'Missing'} x-github-event header.`);
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

  // --- Validate event type against known allowlist ---
  if (!SUPPORTED_EVENTS.has(rawEvent)) {
    console.warn(`[webhook] Unsupported event type: ${rawEvent}`);
    res.status(400).send('Unsupported webhook event type.');
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
  await processor(payload, rawEvent, correlationId);

  res.status(200).send('Webhook processed.');
}
