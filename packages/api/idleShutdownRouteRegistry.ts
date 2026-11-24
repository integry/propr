import type { createIdleShutdownRoutes } from './routes/idleShutdownRoutes.js';
import { requireManageSettings } from './permissionGuards.js';
import type { RouteEntry } from './routeRegistry.js';

/** Instance-admin idle shutdown settings (issue #3770). */
export function createIdleShutdownRouteEntries(routes: ReturnType<typeof createIdleShutdownRoutes>): RouteEntry[] {
  return [
    ['get', '/api/admin/idle-shutdown', requireManageSettings, routes.getSettings],
    ['put', '/api/admin/idle-shutdown', requireManageSettings, routes.putSettings],
  ];
}
