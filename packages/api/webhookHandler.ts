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

/** Reads a positive-integer env var, falling back when unset or invalid. */
function parsePositiveIntEnv(name: string, fallback: number): number {
  const env = process.env[name];
  if (env) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

export const WEBHOOK_DELIVERY_TTL_SECONDS: number = parsePositiveIntEnv('WEBHOOK_DELIVERY_TTL_SECONDS', DEFAULT_DELIVERY_TTL_SECONDS);

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
  /** When provided, active PR tasks are automatically cancelled on merged PR close events. */
  mergedPRTaskCanceller?: MergedPRTaskCancellerDeps;
}

/** Machine-readable cancellation reason recorded when tasks are stopped because their PR merged. */
export const PR_MERGED_CANCELLATION_REASON = 'pr_merged';

export interface MergedPRStopContext {
  requestedBy: string;
  reason: string;
  cancellationReason: string;
  /** Marks the task cancelled even when only an abort signal could be set (see stopTaskExecution). */
  ensureCancelled: boolean;
}

export interface MergedPRTaskCancellerDeps {
  /** Loads active tasks and queued jobs for a PR (see getActiveTasksForPR in @propr/core). */
  getActiveTasksForPR: (repository: string, prNumber: number) => Promise<{
    activeTasks: Array<{ taskId: string; state: string }>;
    queuedJobs: Array<{ jobId: string; state: string }>;
  }>;
  /** Stops a single task or queued job (see stopTaskExecution in routes/dockerRoutes). */
  stopTask: (taskIdOrJobId: string, context: MergedPRStopContext) => Promise<{ success: boolean; cancellationRecorded?: boolean } | void>;
}

/** Returns true for a pull_request webhook where the PR was closed by merging. */
export function isMergedPullRequestClose(event: string, payload: Record<string, unknown>): boolean {
  if (event !== 'pull_request' || payload.action !== 'closed') return false;
  const pullRequest = payload.pull_request as { merged?: unknown } | undefined;
  return pullRequest?.merged === true;
}

export interface MergedPRCancellationSummary {
  attempted: number;
  /** Tasks that were stopped AND had the cancellation durably recorded in task state. */
  cancelled: number;
  /**
   * Tasks that were stopped (job removed or abort signal set) but whose
   * cancellation could not be durably recorded — e.g. an unrecognized queue
   * payload left nothing to attach the reason to, or the state write failed.
   * The abort signal (which carries the machine-readable reason) remains in
   * place, so a live worker still terminates and records the cancellation.
   */
  cancellationPending: number;
  failed: number;
  /** Tasks that were no longer active by the time the stop ran (finished or vanished). */
  skipped: number;
}

/**
 * Bounded concurrency for merge-triggered task stops. Each container stop can
 * take up to ~10s, so cancelling sequentially could push the GitHub webhook
 * delivery toward its timeout when a PR has several active tasks.
 * Configurable via the MERGED_PR_STOP_CONCURRENCY env var for deployments
 * with slower Docker stops or larger PR task fanout.
 */
const MERGED_PR_STOP_CONCURRENCY = parsePositiveIntEnv('MERGED_PR_STOP_CONCURRENCY', 4);

/**
 * Maximum time the webhook response waits for merge-triggered cancellation
 * before continuing with normal processing. GitHub fails deliveries after
 * ~10s, and even with bounded stop concurrency a PR with many active tasks
 * (or slow container stops) can exceed that. When the budget is exhausted the
 * remaining stops keep running in the background — a bounded version of the
 * cancel-before-processing ordering, preferred over a timed-out delivery:
 * GitHub's retry of a timed-out delivery would be rejected as a duplicate, so
 * the close-event processor would never run at all.
 * Configurable via the MERGED_PR_CANCELLATION_WAIT_MS env var (must stay
 * comfortably under GitHub's ~10s delivery timeout).
 */
export const MERGED_PR_CANCELLATION_WAIT_MS = parsePositiveIntEnv('MERGED_PR_CANCELLATION_WAIT_MS', 8_000);

/**
 * Cancels all still-active tasks and queued jobs associated with a merged PR.
 * Stops run concurrently (bounded); a failure to cancel one task is logged and
 * does not block the remaining cancellations (nor the webhook delivery).
 */
export async function cancelActiveTasksForMergedPR(
  repository: string,
  prNumber: number,
  deps: MergedPRTaskCancellerDeps,
): Promise<MergedPRCancellationSummary> {
  const { activeTasks, queuedJobs } = await deps.getActiveTasksForPR(repository, prNumber);

  const idsToStop = new Set<string>();
  for (const task of activeTasks) idsToStop.add(task.taskId);
  for (const job of queuedJobs) idsToStop.add(job.jobId);

  if (idsToStop.size === 0) return { attempted: 0, cancelled: 0, cancellationPending: 0, failed: 0, skipped: 0 };

  const context: MergedPRStopContext = {
    requestedBy: 'system',
    reason: `Pull request ${repository}#${prNumber} was merged. Task cancelled automatically.`,
    cancellationReason: PR_MERGED_CANCELLATION_REASON,
    ensureCancelled: true,
  };

  let cancelled = 0;
  let cancellationPending = 0;
  let failed = 0;
  let skipped = 0;
  const pending = [...idsToStop];
  const stopNext = async (): Promise<void> => {
    for (let id = pending.shift(); id !== undefined; id = pending.shift()) {
      try {
        const result = await deps.stopTask(id, context);
        if (result && result.success === false) {
          // The task finished (or vanished) between lookup and stop — nothing to cancel.
          skipped++;
          console.log(`[webhook] Task ${id} for merged PR ${repository}#${prNumber} was no longer active`);
        } else if (result && result.cancellationRecorded === false) {
          // Merge-triggered stops request durable cancellation marking
          // (ensureCancelled), so an unrecorded cancellation means there was no
          // task state to attach the reason to. Surface it separately instead
          // of counting it as a fully recorded cancellation.
          cancellationPending++;
          console.warn(`[webhook] Task ${id} for merged PR ${repository}#${prNumber} was stopped but the cancellation was not durably recorded; the abort signal remains for the worker to observe`);
        } else {
          cancelled++;
        }
      } catch (error) {
        failed++;
        console.error(`[webhook] Failed to cancel task ${id} for merged PR ${repository}#${prNumber}:`, error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MERGED_PR_STOP_CONCURRENCY, pending.length) }, () => stopNext()));

  console.log(`[webhook] Merged PR ${repository}#${prNumber}: cancelled ${cancelled}/${idsToStop.size} active task(s)${cancellationPending > 0 ? `, ${cancellationPending} stopped without a durable record` : ''}${skipped > 0 ? `, ${skipped} no longer active` : ''}${failed > 0 ? `, ${failed} failed` : ''}`);
  return { attempted: idsToStop.size, cancelled, cancellationPending, failed, skipped };
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

  // Merged PR close → auto-cancel any still-active PR tasks. This deliberately
  // runs BEFORE the regular webhook processor: stale in-flight work must stop
  // before close-processing side effects run (label/loop-state cleanup, branch
  // deletion), so a cancelled task cannot race them by pushing to the merged
  // branch or posting stale comments mid-cleanup. Nothing in the cancellation
  // path reads anything the processor writes, so there is no reverse dependency.
  // The wait is bounded by MERGED_PR_CANCELLATION_WAIT_MS so a PR with many
  // active tasks cannot push the delivery past GitHub's webhook timeout. The
  // cancel-before-processing ordering is therefore guaranteed only within that
  // budget: when it is exhausted, close processing runs while the remaining
  // stops finish in the background, and a slow stop can in principle still
  // race the cleanup. That residual race is accepted — the alternative (a
  // timed-out delivery whose GitHub retry is rejected as a duplicate) would
  // skip close processing entirely. Raise MERGED_PR_CANCELLATION_WAIT_MS in
  // deployments where container stops are slow and stricter ordering matters.
  // Failures here are logged but must never fail the webhook delivery.
  if (deps.mergedPRTaskCanceller && isMergedPullRequestClose(rawEvent, payload)) {
    const repository = payload.repository?.full_name;
    const prNumber = (payload.pull_request as { number?: number } | undefined)?.number;
    if (repository && typeof prNumber === 'number') {
      const cancellation = cancelActiveTasksForMergedPR(repository, prNumber, deps.mergedPRTaskCanceller)
        .catch(error => {
          console.error(`[webhook] Merge-triggered task cancellation failed for ${repository}#${prNumber}:`, error);
        });
      let waitTimer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        cancellation.then(() => false),
        new Promise<boolean>(resolve => { waitTimer = setTimeout(() => resolve(true), MERGED_PR_CANCELLATION_WAIT_MS); }),
      ]);
      clearTimeout(waitTimer);
      if (timedOut) {
        console.warn(`[webhook] Merge-triggered cancellation for ${repository}#${prNumber} exceeded ${MERGED_PR_CANCELLATION_WAIT_MS}ms; continuing webhook processing while the remaining stops finish in the background`);
      }
    }
  }

  await processor(payload, rawEvent, correlationId, rawDeliveryId);

  res.status(200).send('Webhook processed.');
}
