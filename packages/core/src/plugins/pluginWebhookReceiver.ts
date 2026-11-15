import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Knex } from 'knex';
import { PLUGIN_WEBHOOK_LIMITS, type PluginWebhook, type PluginWebhookRequest, type PluginWebhookResponder, type PluginWebhookResponse } from '@propr/shared';
import logger from '../utils/logger.js';
import { officialPluginCatalog, type PluginCatalogSource } from './pluginCatalog.js';
import { officialPluginHandlers, type PluginHandlerSource } from './pluginHandlerRunner.js';
import { PluginStore } from './pluginStore.js';
import type { PluginWebhookRunner } from './pluginWebhookRunner.js';
import {
  handlerHeaders, recordPluginWebhookRejection, resolvePluginWebhook, senderDeliveryId, verifyPluginWebhook,
  type PluginWebhookRejection, type ResolvedPluginWebhook,
} from './pluginWebhooks.js';

/**
 * The inbound plugin webhook request, from `POST /api/plugins/<key>/hooks/<name>`
 * to the delivery queue. In order:
 *
 * 1. The key and name must address an enabled installation and a declared
 *    webhook: otherwise 404 and nothing runs.
 * 2. ProPR verifies the request with the webhook's scheme and signing secret:
 *    otherwise 401, counted on the installation, logged without the body or
 *    any header.
 * 3. The delivery id is derived (400 when the sender's is malformed) and
 *    reserved: one already recorded is a replay, 409, and no plugin code runs.
 * 4. A `respond` function may answer at once (a challenge echo): it gets the
 *    frozen request as its only argument, no `ctx`, and must return
 *    synchronously. Its answer keeps the delivery id taken; when it fails
 *    (500) the reservation is given back, so the sender may send it again.
 * 5. Otherwise the delivery is queued (202) and the handler runs from the
 *    queue. While deliveries are paused, or the queue is full, 503 (and the
 *    reservation is given back).
 *
 * The body size limit and the rate limiter are applied by the route before this.
 */
export interface PluginWebhookReceiverOptions {
  database: Knex;
  runner: PluginWebhookRunner;
  catalog?: PluginCatalogSource;
  handlers?: PluginHandlerSource;
  /** The stored value of a `signing_secret` connection; defaults to the plugin store's sealed connection secrets. */
  connectionSecret?: (pluginId: string, connection: string) => Promise<string | null>;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface PluginWebhookRequestInput { key: string; name: string; headers: IncomingHttpHeaders; body: Buffer }
export interface PluginWebhookReply { status: number; contentType: 'application/json' | 'text/plain'; body: string; retryAfterSeconds?: number }

const json = (status: number, value: Record<string, unknown>, extra: Partial<PluginWebhookReply> = {}): PluginWebhookReply => ({ status, contentType: 'application/json', body: JSON.stringify(value), ...extra });
const NOT_FOUND = json(404, { error: 'Not found' });
const BUSY = json(503, { error: 'Too many webhook deliveries are waiting' }, { retryAfterSeconds: 60 });

/** A respond function's answer, checked: a 2xx status, a short text body and a supported content type. */
function checkedResponse(value: unknown): PluginWebhookResponse | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || typeof (value as { then?: unknown }).then === 'function') throw new Error('A respond function must return a response synchronously');
  const { status = 200, contentType = 'text/plain', body } = value as PluginWebhookResponse;
  if (!Number.isInteger(status) || status < 200 || status > 299) throw new Error('A respond function answers with a 2xx status');
  if (contentType !== 'text/plain' && contentType !== 'application/json') throw new Error('A respond function answers text/plain or application/json');
  if (typeof body !== 'string' || Buffer.byteLength(body) > PLUGIN_WEBHOOK_LIMITS.responseBytes) throw new Error(`A respond function answers a text body of at most ${PLUGIN_WEBHOOK_LIMITS.responseBytes} bytes`);
  return { status, contentType, body };
}

export class PluginWebhookReceiver {
  private readonly now: () => number;
  constructor(private readonly options: PluginWebhookReceiverOptions) { this.now = options.now ?? Date.now; }

  private secret(pluginId: string, connection: string): Promise<string | null> {
    if (this.options.connectionSecret) return this.options.connectionSecret(pluginId, connection);
    return new PluginStore(this.options.database, this.options.environment).connectionSecret(pluginId, connection);
  }

  private async reject(resolved: ResolvedPluginWebhook, reason: PluginWebhookRejection): Promise<PluginWebhookReply> {
    await recordPluginWebhookRejection(this.options.database, resolved.target.pluginId, reason, this.now());
    // Never the body or a header: only who was addressed and why it was refused.
    logger.warn({ pluginId: resolved.target.pluginId, webhook: resolved.webhook.name, reason }, '[plugins] Rejected an unverified webhook request');
    return json(401, { error: 'The request could not be verified' });
  }

  /** Call the webhook's respond function with the frozen request only; never `ctx`. */
  private async respond(resolved: ResolvedPluginWebhook, request: PluginWebhookRequest): Promise<PluginWebhookReply | null> {
    const { webhook, target } = resolved;
    if (!webhook.respond) return null;
    try {
      const module = await (this.options.handlers ?? officialPluginHandlers)(target.pluginId);
      const responder = module && Object.hasOwn(module, webhook.respond) ? module[webhook.respond] as unknown as PluginWebhookResponder : undefined;
      if (typeof responder !== 'function') throw new Error(`Plugin ${target.pluginId} has no function ${webhook.respond}`);
      const response = checkedResponse(Reflect.apply(responder, undefined, [request]));
      return response ? { status: response.status!, contentType: response.contentType!, body: response.body } : null;
    } catch {
      // Nothing of the error: a respond function may throw (or name its error after) any part of the request.
      logger.warn({ pluginId: target.pluginId, webhook: webhook.name }, '[plugins] Webhook respond function failed');
      return json(500, { error: 'The webhook could not answer' });
    }
  }

  /**
   * `whk-<webhook>:<sender's id>`, or `whk-<webhook>/<ProPR id>` without one.
   * A webhook name has neither `:` nor `/`, so the character after it ends the
   * name unambiguously and tells a sender's id from ProPR's: distinct webhooks
   * and ids never share a delivery id (`a` with `b-c` and `a-b` with `c` differ).
   */
  private deliveryId(webhook: PluginWebhook, headers: IncomingHttpHeaders): { id: string; fromSender: boolean } | null {
    const sender = senderDeliveryId(headers, webhook);
    if (sender === null) return null;
    return sender === undefined ? { id: `whk-${webhook.name}/${randomUUID()}`, fromSender: false } : { id: `whk-${webhook.name}:${sender}`, fromSender: true };
  }

  async receive(request: PluginWebhookRequestInput): Promise<PluginWebhookReply> {
    const { database } = this.options;
    const resolved = await resolvePluginWebhook(database, request.key, request.name, await (this.options.catalog ?? officialPluginCatalog)());
    if (!resolved) return NOT_FOUND;
    const { target, webhook } = resolved;
    const receivedAt = this.now();
    const secret = await this.secret(target.pluginId, webhook.verification.connection).catch(() => null);
    if (!secret) return this.reject(resolved, 'no_secret');
    const verdict = verifyPluginWebhook({ verification: webhook.verification, secret, headers: request.headers, body: request.body, now: receivedAt });
    if (!verdict.ok) return this.reject(resolved, verdict.reason);

    // The delivery id is checked and taken before any plugin code runs (the respond function included): a replay runs nothing.
    const derived = this.deliveryId(webhook, request.headers);
    if (derived === null) return json(400, { error: `Invalid ${webhook.deliveryIdHeader} header` });
    const { runner } = this.options;
    const deliveryId = derived.id;
    const reserved = await runner.reserve({ target, handler: webhook.handler, deliveryId, webhook: webhook.name });
    if (!reserved.accepted) return reserved.reason === 'duplicate' ? json(409, { error: 'This delivery was already received' }) : BUSY;
    const { recordId } = reserved;
    try {
      const body = request.body.toString('utf8');
      const headers = Object.freeze(handlerHeaders(request.headers, webhook));
      const answer = await this.respond(resolved, Object.freeze({ webhook: webhook.name, headers, body, receivedAt }));
      if (answer) {
        // Answered: a sender's delivery id stays taken, so its replay is refused; ProPR's own id is never sent again. A failed respond function delivered nothing.
        if (answer.status < 300 && derived.fromSender) await runner.answered(recordId, webhook.respond!);
        else await runner.release(recordId);
        return answer;
      }
      const dispatch = await database('plugin_dispatch').where({ plugin_id: target.pluginId, installed_at: target.record.installedAt }).first('paused_at') as { paused_at: number | null } | undefined;
      if (dispatch && dispatch.paused_at !== null) {
        await runner.release(recordId);
        return json(503, { error: 'Deliveries of this plugin are paused' }, { retryAfterSeconds: 300 });
      }
      if (!await runner.start(recordId, { target, handler: webhook.handler, deliveryId, input: { kind: 'webhook', webhook: webhook.name, headers: { ...headers }, body, receivedAt } })) return BUSY;
      return json(202, { accepted: true, deliveryId });
    } catch (error) {
      await runner.release(recordId).catch(() => undefined);
      throw error;
    }
  }
}
