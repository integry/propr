import type { Request } from 'express';
import { db } from '@propr/core';
import { pluginIdSchema } from '@propr/shared';
import { PluginError, PluginStore } from '../../core/src/plugins/pluginStore.js';
import { listPluginActivity, resumePluginDeliveries, retryPluginDelivery } from '../../core/src/plugins/pluginDeliveries.js';
import { pluginRouteHandler } from './pluginRoutes.js';

/**
 * Plugin event delivery activity under `/api/instance/plugins/v1/:pluginId`:
 * the installation's delivery health and newest delivery records, retrying a
 * failed delivery and resuming paused deliveries. The same administrator and
 * preflight requirements as the installation routes apply. Records carry the
 * event id and type, never its payload or a credential.
 */
export function createPluginActivityRoutes(store = new PluginStore(db), database = db, environment: NodeJS.ProcessEnv = process.env) {
  const handle = pluginRouteHandler(store);
  const id = (req: Request) => {
    const parsed = pluginIdSchema.safeParse(req.params.pluginId);
    if (!parsed.success) throw new PluginError(404, 'Plugin not found');
    return parsed.data;
  };
  const empty = (req: Request) => {
    const value = req.body as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new PluginError(400, 'Invalid plugin request');
  };
  return {
    list: handle(async req => listPluginActivity(database, id(req), { environment })),
    retry: handle(async (req, actor) => { empty(req); return { delivery: await retryPluginDelivery(database, id(req), String(req.params.deliveryId), actor) }; }),
    resume: handle(async (req, actor) => { empty(req); return { health: await resumePluginDeliveries(database, id(req), actor, { environment }) }; }),
  };
}
