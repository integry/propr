import crypto from 'crypto';
import type { Request, Response } from 'express';

/** TTL for webhook delivery deduplication keys in Redis (seconds) */
export const WEBHOOK_DELIVERY_TTL_SECONDS = 300;

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
 * Stale-request limitation: GitHub does not include a signed timestamp in
 * webhook deliveries. The `Date` header is not covered by the HMAC, so an
 * attacker who captures a valid signed payload can replay it at any point
 * within the dedup TTL window. True time-based staleness rejection would
 * require a trusted, authenticated timestamp from GitHub. Until that exists,
 * replay resistance relies entirely on the delivery-ID dedup window
 * ({@link WEBHOOK_DELIVERY_TTL_SECONDS}).
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
  const SUPPORTED_EVENTS: ReadonlySet<string> = new Set([
    'issues', 'issue_comment', 'pull_request_review_comment',
    'pull_request', 'check_run', 'push',
  ]);
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
