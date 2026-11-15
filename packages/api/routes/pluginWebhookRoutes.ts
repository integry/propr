import express, { type Request, type RequestHandler } from 'express';
import type { Knex } from 'knex';
import { db } from '@propr/core';
import { PLUGIN_WEBHOOK_LIMITS, pluginIdSchema } from '@propr/shared';
import { PluginError, PluginStore } from '../../core/src/plugins/pluginStore.js';
import { officialPluginCatalog, type PluginCatalogSource } from '../../core/src/plugins/pluginCatalog.js';
import { pluginWebhookEndpoints, regeneratePluginWebhookKey } from '../../core/src/plugins/pluginWebhooks.js';
import type { PluginWebhookReceiver, PluginWebhookReply } from '../../core/src/plugins/pluginWebhookReceiver.js';
import { derivePublicOrigin } from '../mcp/configResolver.js';
import { createWebhookRequestRateLimiter } from '../requestRateLimits.js';
import { pluginRouteHandler } from './pluginRoutes.js';

/**
 * Inbound plugin webhooks, `POST /api/plugins/:installationKey/hooks/:webhookName`.
 * Public: the request is authenticated by the unguessable installation key and
 * then by the webhook's verification scheme, both checked before any plugin
 * code runs. The webhook rate limiter applies, the raw body is read exactly as
 * transmitted (never inflated: a signature covers the sent bytes) up to
 * `PLUGIN_WEBHOOK_LIMITS.bodyBytes` (413 beyond), and nothing here logs the
 * body or a header.
 */
export function createPluginWebhookHandlers(receiver: () => PluginWebhookReceiver | null, environment: NodeJS.ProcessEnv = process.env): RequestHandler[] {
  const raw = express.raw({ type: () => true, limit: PLUGIN_WEBHOOK_LIMITS.bodyBytes });
  // The signature covers the bytes as transmitted, so the body is read without inflation: the
  // parser (which reads the header synchronously) sees no Content-Encoding, and the receiver
  // decodes the body only after verifying it. The limit applies to the transmitted bytes here.
  const readBody: RequestHandler = (req, res, next) => {
    const encoding = req.headers['content-encoding'];
    delete req.headers['content-encoding'];
    raw(req, res, error => {
      if (encoding !== undefined) req.headers['content-encoding'] = encoding;
      if (!error) return next();
      const status = (error as { status?: number }).status;
      // The body is not echoed or logged, whatever was wrong with it.
      res.status(status === 413 ? 413 : 400).set('Cache-Control', 'no-store').json({ error: status === 413 ? `The request body is larger than ${PLUGIN_WEBHOOK_LIMITS.bodyBytes} bytes` : 'The request body could not be read' });
    });
  };
  const send = (res: express.Response, reply: PluginWebhookReply) => {
    res.status(reply.status).set({ 'Cache-Control': 'no-store', 'Content-Type': reply.contentType, 'X-Content-Type-Options': 'nosniff' });
    if (reply.retryAfterSeconds) res.set('Retry-After', String(reply.retryAfterSeconds));
    res.send(reply.body);
  };
  const handle: RequestHandler = async (req, res) => {
    const target = receiver();
    if (!target) return send(res, { status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not found' }) });
    try {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      send(res, await target.receive({ key: String(req.params.installationKey), name: String(req.params.webhookName), headers: req.headers, body }));
    } catch (error) {
      // Only the error's name: its message could quote the request.
      console.error('[plugins] Webhook request failed:', error instanceof Error ? error.name : 'Error');
      if (!res.headersSent) send(res, { status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Webhook processing failed' }) });
    }
  };
  return [createWebhookRequestRateLimiter(environment), readBody, handle];
}

/**
 * The installed plugin's webhook URLs, under `/api/instance/plugins/v1/:pluginId/webhooks`,
 * and regenerating its installation key (every old URL stops working). The same
 * administrator and preflight requirements as the installation routes apply.
 */
export function createPluginWebhookAdminRoutes(store = new PluginStore(db), database: Knex = db, environment: NodeJS.ProcessEnv = process.env, catalog: PluginCatalogSource = store.catalog ?? officialPluginCatalog) {
  const handle = pluginRouteHandler(store);
  const id = (req: Request) => {
    const parsed = pluginIdSchema.safeParse(req.params.pluginId);
    if (!parsed.success) throw new PluginError(404, 'Plugin not found');
    return parsed.data;
  };
  const options = async (pluginId: string) => ({ manifest: (await catalog()).find(m => m.id === pluginId), origin: derivePublicOrigin(environment) ?? null });
  return {
    list: handle(async req => { const pluginId = id(req); return pluginWebhookEndpoints(database, pluginId, await options(pluginId)); }),
    regenerate: handle(async (req, actor) => {
      const value = req.body as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new PluginError(400, 'Invalid plugin request');
      const pluginId = id(req);
      return regeneratePluginWebhookKey(database, pluginId, actor, await options(pluginId));
    }),
  };
}
