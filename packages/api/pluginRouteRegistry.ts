import type { createPluginRoutes } from './routes/pluginRoutes.js';
import type { createPluginActivityRoutes } from './routes/pluginActivityRoutes.js';
import { requireManageSettings } from './permissionGuards.js';
import type { RouteEntry } from './routeRegistry.js';
import { PLUGIN_API_BASE } from '@propr/shared';

/** Plugin installation and delivery activity routes; kept out of `routeRegistry.ts`, which is at its size limit. */
export function createPluginRouteEntries(plugins: ReturnType<typeof createPluginRoutes>, activity: ReturnType<typeof createPluginActivityRoutes>): RouteEntry[] {
  const base = PLUGIN_API_BASE;
  return [
    ['get', base, requireManageSettings, plugins.list],
    ['get', `${base}/:pluginId`, requireManageSettings, plugins.get],
    ['post', `${base}/:pluginId/install`, requireManageSettings, plugins.install],
    ['put', `${base}/:pluginId/settings`, requireManageSettings, plugins.updateSettings],
    ['put', `${base}/:pluginId/repositories`, requireManageSettings, plugins.setRepositories],
    ['put', `${base}/:pluginId/connections/:connectionName`, requireManageSettings, plugins.setConnection],
    ['put', `${base}/:pluginId/enabled`, requireManageSettings, plugins.setEnabled],
    ['post', `${base}/:pluginId/approve`, requireManageSettings, plugins.approve],
    ['post', `${base}/:pluginId/uninstall`, requireManageSettings, plugins.uninstall],
    ['put', `${base}/:pluginId/connections/:connectionName/oauth/client`, requireManageSettings, plugins.setOAuthClient],
    ['post', `${base}/:pluginId/connections/:connectionName/oauth/start`, requireManageSettings, plugins.startOAuth],
    ['post', `${base}/:pluginId/connections/:connectionName/oauth/complete`, requireManageSettings, plugins.completeOAuth],
    ['post', `${base}/:pluginId/connections/:connectionName/oauth/disconnect`, requireManageSettings, plugins.disconnectOAuth],
    ['get', `${base}/:pluginId/activity`, requireManageSettings, activity.list],
    ['post', `${base}/:pluginId/activity/:deliveryId/retry`, requireManageSettings, activity.retry],
    ['post', `${base}/:pluginId/resume`, requireManageSettings, activity.resume],
  ];
}
