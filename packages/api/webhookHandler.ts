import crypto from 'crypto';
import type { Request, Response } from 'express';
import { SUPPORTED_WEBHOOK_EVENTS } from '@propr/core';

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

/** Module-level allowlist derived from @propr/core — single source of truth. */
const SUPPORTED_EVENTS: ReadonlySet<string> = new Set(SUPPORTED_WEBHOOK_EVENTS);

export interface WebhookHandlerDeps {
  webhookSecret: string | undefined;
  redis: {
    set: (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => Promise<string | null>;
  };
  processor: (payload: Record<string, unknown>, event: string, correlationId: string, deliveryId: string) => Promise<void>;
  correlationId: string;
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
 * Known limitation — no stale-request protection: GitHub does not include a
 * signed timestamp in webhook deliveries (the `Date` header is not covered by
 * the HMAC), so true clock-based staleness rejection is impossible. A captured
 * signed payload with a *new* delivery ID cannot be distinguished from a
 * legitimate delivery. The deduplication layer only prevents the *same*
 * delivery ID from being processed twice; it does not protect against replays
 * that use a different or expired delivery ID. Addressing this would require
 * an authenticated freshness signal from GitHub that does not currently exist.
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
    console.error('[webhook] GH_WEBHOOK_SECRET is not configured — rejecting request. Set GH_WEBHOOK_SECRET in the environment to accept webhooks. This is a security requirement: all webhook deliveries are rejected until a secret is provisioned.');
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
  await processor(payload, rawEvent, correlationId, rawDeliveryId);

  res.status(200).send('Webhook processed.');
}
