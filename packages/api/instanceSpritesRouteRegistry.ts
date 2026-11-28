import type { createInstanceSpritesRoutes } from './routes/instanceSpritesRoutes.js';
import { requireManageRuntime } from './permissionGuards.js';
import type { RouteEntry } from './routeRegistry.js';

/** Instance-admin listing and removal of this instance's Sprites (issue #3827 follow-up). */
export function createInstanceSpritesRouteEntries(routes: ReturnType<typeof createInstanceSpritesRoutes>): RouteEntry[] {
  return [
    ['get', '/api/admin/sprites', requireManageRuntime, routes.getSprites],
    ['post', '/api/admin/sprites/remove', requireManageRuntime, routes.removeSprites],
  ];
}
