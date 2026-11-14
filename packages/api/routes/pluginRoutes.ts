import type { Request, RequestHandler } from 'express';
import { db } from '@propr/core';
import { PluginError, PluginStore } from '../../core/src/plugins/pluginStore.js';
import { isDemoViewer } from '../demoMode.js';
import { refuseDemoViewer } from '../permissionGuards.js';

/**
 * Plugin installation state under `/api/instance/plugins/v1`. Every route,
 * reads included, needs a current durable administrator with
 * `instance.manage_settings`; mutations additionally need the
 * preflight-protected JSON contract (`X-ProPR-Plugins: 1`). Connection
 * secrets are write-only: no response carries them.
 */
export function createPluginRoutes(store = new PluginStore(db)) {
  const handle = (run: (req: Request, actor: string) => Promise<unknown>): RequestHandler => async (req, res, next) => {
    // Plugins hold sealed per-installation secrets; the demo explains instead of reading them.
    if (isDemoViewer(req.authorization)) return refuseDemoViewer(req, res, next);
    try {
      if (!req.user?.id) throw new PluginError(401, 'Authentication required');
      if (req.authorization?.role !== 'admin' || !req.authorization.permissions.includes('instance.manage_settings')) throw new PluginError(403, 'Instance settings administration is required');
      if (req.method !== 'GET' && (req.get('X-ProPR-Plugins') !== '1' || !req.is('application/json'))) throw new PluginError(403, 'Plugin changes require the preflight-protected JSON contract');
      // Durable authority before any input is read; the store checks it again inside each write.
      await store.authorize(req.user.id);
      res.set('Cache-Control', 'no-store').json(await run(req, req.user.id));
    } catch (error) {
      res.status(error instanceof PluginError ? error.status : 400).json({ error: error instanceof PluginError ? error.message : 'Plugin operation unavailable or invalid' });
    }
  };
  const body = (req: Request, keys: string[], required: string[] = keys): Record<string, unknown> => {
    const value = req.body as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)) || required.some(k => !Object.hasOwn(value, k))) throw new PluginError(400, 'Invalid plugin request');
    return value as Record<string, unknown>;
  };
  const id = (req: Request) => String(req.params.pluginId);
  return {
    list: handle(async (_req, actor) => ({ plugins: await store.list(actor) })),
    get: handle(async (req, actor) => ({ plugin: await store.get(actor, id(req)) })),
    /** `acknowledgements` names the package servers whose secret variables the administrator confirmed are readable in the task container. */
    install: handle(async (req, actor) => ({ plugin: await store.install(actor, id(req), body(req, ['acknowledgements'], []).acknowledgements) })),
    updateSettings: handle(async (req, actor) => ({ plugin: await store.updateSettings(actor, id(req), body(req, ['settings']).settings) })),
    setRepositories: handle(async (req, actor) => ({ plugin: await store.setRepositories(actor, id(req), body(req, ['repositories']).repositories) })),
    /** `value` sets the secret; `null` clears it. */
    setConnection: handle(async (req, actor) => ({ plugin: await store.setConnection(actor, id(req), String(req.params.connectionName), body(req, ['value']).value) })),
    setEnabled: handle(async (req, actor) => ({ plugin: await store.setEnabled(actor, id(req), body(req, ['enabled']).enabled) })),
    approve: handle(async (req, actor) => ({ plugin: await store.approve(actor, id(req), body(req, ['acknowledgements'], []).acknowledgements) })),
    uninstall: handle(async (req, actor) => ({ plugin: await store.uninstall(actor, id(req), body(req, ['confirm']).confirm) })),
  };
}
