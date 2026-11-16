import {
  PLUGIN_DELIVERY_RETENTION_DAYS, PluginDeliveryError, PluginSdkError, definePluginHandler, parsePluginRetryAfter,
  type PluginContext, type PluginEventInput, type RepositoryEvent,
} from '@propr/shared';
import { eventName, matchingDestinations } from '../_shared/eventSelection.js';
import {
  WEBHOOK_ENVELOPE_VERSION, WEBHOOK_HEADERS, WEBHOOK_SIGNATURE_PREFIX, webhookDeliveryId, webhookEnvelope, webhookTargets, type Json, type WebhookTarget,
} from './envelope.js';

/**
 * Outbound webhooks: every subscribed ProPR event is sent as a signed JSON
 * POST (the envelope of `envelope.ts`) to each configured target whose event
 * and repository selection takes it. Only `deliver` is exported: every
 * exported function of this module is a handler.
 */

const USER_AGENT = 'ProPR-Webhooks/1';
/**
 * Progress of a delivery whose targets did not all succeed, kept across
 * attempts (automatic retries and a manual Retry of the failed delivery) so a
 * retry sends only to the targets still owed.
 */
const PROGRESS_PREFIX = 'progress:';
/** Progress not updated for this long is dropped: Activity no longer offers Retry for its delivery. */
const PROGRESS_TTL_MS = PLUGIN_DELIVERY_RETENTION_DAYS * 24 * 60 * 60_000;

/** A failed send: `permanent` when retrying cannot help, with the target's `Retry-After` when it gave one. */
interface SendFailure { message: string; permanent: boolean; retryAfterMs: number | null }

/** `ctx.http` refusals that are configuration problems: retrying cannot help. */
const PERMANENT_SDK_CODES = new Set(['host_not_allowed', 'insecure_url', 'private_address', 'invalid_input', 'connection_unavailable', 'permission_denied']);
/** Statuses that may succeed later: timeouts, rate limits and server errors. Every other non-2xx status is permanent. */
const transientStatus = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500;

const label = (target: WebhookTarget) => `${target.name.replace('target-', 'Target ')} (${target.host})`;

async function send(ctx: PluginContext, target: WebhookTarget, event: RepositoryEvent, id: string): Promise<SendFailure | null> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify(webhookEnvelope(event, id));
  let status: number; let retryAfter: string | undefined;
  try {
    const response = await ctx.http(target.connection)(target.url, {
      method: 'POST', body,
      headers: {
        'content-type': 'application/json', 'user-agent': USER_AGENT,
        [WEBHOOK_HEADERS.event]: eventName(event), [WEBHOOK_HEADERS.delivery]: id, [WEBHOOK_HEADERS.timestamp]: timestamp,
        [WEBHOOK_HEADERS.version]: String(WEBHOOK_ENVELOPE_VERSION),
      },
      signature: { header: WEBHOOK_HEADERS.signature, prefix: WEBHOOK_SIGNATURE_PREFIX, timestampHeader: WEBHOOK_HEADERS.timestamp },
    });
    status = response.status; retryAfter = response.headers['retry-after'];
  } catch (error) {
    const sdk = error instanceof PluginSdkError ? error : null;
    const reason = sdk ? sdk.message : 'the request failed';
    if (sdk && PERMANENT_SDK_CODES.has(sdk.code)) return { message: `${label(target)} was not sent the delivery: ${reason}. Check the target's settings and signing secret`, permanent: true, retryAfterMs: null };
    return { message: `${label(target)} could not be reached: ${reason}`, permanent: false, retryAfterMs: null };
  }
  if (status >= 200 && status < 300) {
    ctx.log.info(`Delivered ${eventName(event)} to ${label(target)}`, { target: target.name, host: target.host, status, delivery: id });
    return null;
  }
  if (transientStatus(status)) {
    const retryAfterMs = parsePluginRetryAfter(retryAfter);
    const wait = retryAfterMs === null ? '' : `; it asked to retry after ${Math.ceil(retryAfterMs / 1000)} s`;
    return { message: `${label(target)} answered HTTP ${status}${wait}`, permanent: false, retryAfterMs };
  }
  return { message: `${label(target)} refused the delivery with HTTP ${status}; it is not retried. Check the target URL and the endpoint's configuration`, permanent: true, retryAfterMs: null };
}

interface Progress { at: number; sent: string[]; refused: Record<string, string> }

const progressKeys = async (ctx: PluginContext) => ctx.state.keys(PROGRESS_PREFIX);

/** Drop progress records of deliveries long finished (a delivery that finally failed while a target still owed it). */
async function pruneProgress(ctx: PluginContext, now: number): Promise<void> {
  for (const key of await progressKeys(ctx)) {
    const progress = await ctx.state.get<Progress & Json>(key);
    if (!progress || typeof progress.at !== 'number' || now - progress.at > PROGRESS_TTL_MS) await ctx.state.delete(key);
  }
}

/**
 * Keep a delivery's progress. When the plugin's state is full, the oldest
 * other progress record makes room; if it still cannot be kept, a retry may
 * send the event again to a target that has it (with the same delivery id,
 * which receivers de-duplicate on), so the delivery's own outcome stands.
 */
async function saveProgress(ctx: PluginContext, key: string, progress: Progress): Promise<void> {
  try {
    await ctx.state.set(key, progress as unknown as Json);
    return;
  } catch (error) {
    if (!(error instanceof PluginSdkError) || error.code !== 'state_limit') throw error;
  }
  let oldest: { key: string; at: number } | null = null;
  for (const other of await progressKeys(ctx)) {
    if (other === key) continue;
    const at = (await ctx.state.get<Progress & Json>(other))?.at;
    const time = typeof at === 'number' ? at : 0;
    if (!oldest || time < oldest.at) oldest = { key: other, at: time };
  }
  try {
    if (!oldest) throw new PluginSdkError('state_limit', 'No progress record to replace');
    await ctx.state.delete(oldest.key);
    await ctx.state.set(key, progress as unknown as Json);
  } catch {
    ctx.log.warn('Could not keep which targets have the delivery; a retry sends it to every target still matching', { delivery: key.slice(PROGRESS_PREFIX.length) });
  }
}

export interface WebhookDeliveryResult extends Json { event: string; delivered: string[] }

/**
 * The handler of every subscribed event: one POST to each target whose
 * selection takes the event. A retry sends only to the targets that did not
 * succeed yet. A rate limit or server error is retried (after the target's
 * `Retry-After` when it gave one); a refusal (another 4xx, or a target the
 * settings no longer allow) marks the delivery failed with its reason once
 * the other targets are done. An automatic retry does not ask a refusing
 * target again; a manual Retry (`input.manual`, after an administrator fixed
 * the target) does, and still skips the targets that have the event.
 */
export const deliver = definePluginHandler<PluginEventInput, WebhookDeliveryResult>(async (input, ctx) => {
  const { event } = input;
  const name = eventName(event);
  const targets = matchingDestinations(webhookTargets(ctx.settings), event);
  if (!targets.length) return { event: name, delivered: [] };
  const key = `${PROGRESS_PREFIX}${input.deliveryId}`;
  const now = Date.now();
  if (input.attempt === 1) await pruneProgress(ctx, now);
  const saved = await ctx.state.get<Progress & Json>(key);
  const progress: Progress = { at: now, sent: saved ? [...saved.sent] : [], refused: saved && !input.manual ? { ...saved.refused } : {} };
  const transient: SendFailure[] = [];
  for (const target of targets) {
    if (progress.sent.includes(target.name) || Object.hasOwn(progress.refused, target.name)) continue;
    const failure = await send(ctx, target, event, webhookDeliveryId(input.deliveryId, target));
    if (!failure) progress.sent.push(target.name);
    else if (failure.permanent) progress.refused[target.name] = failure.message;
    else transient.push(failure);
  }
  const delivered = targets.filter(t => progress.sent.includes(t.name)).map(t => t.name);
  const refused = targets.flatMap(t => (Object.hasOwn(progress.refused, t.name) ? [progress.refused[t.name]] : []));
  if (!transient.length && !refused.length) {
    if (saved) await ctx.state.delete(key);
    return { event: name, delivered };
  }
  // Not every target has it: an automatic retry, or a manual Retry of the failed delivery, needs what was sent (and refused).
  if (transient.length || delivered.length) await saveProgress(ctx, key, progress);
  else if (saved) await ctx.state.delete(key);
  if (transient.length) {
    const delays = transient.map(f => f.retryAfterMs).filter((ms): ms is number => ms !== null);
    throw new PluginDeliveryError([...transient.map(f => f.message), ...refused].join('; '), { retryAfterMs: delays.length ? Math.max(...delays) : null });
  }
  throw new PluginDeliveryError(refused.join('; '), { permanent: true });
});
