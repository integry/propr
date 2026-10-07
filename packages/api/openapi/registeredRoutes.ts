import type { RequestHandler } from 'express';
import type { InstancePermission } from '@propr/shared';
import {
  createManagementRouteEntries,
  createMemberCatalogRouteEntries,
  createOperationalRouteEntries,
  type RouteEntry,
} from '../routeRegistry.js';
import {
  requireAgentTankUsageAccess,
  requireManageAgents,
  requireManageMembers,
  requireManageRuntime,
  requireManageSettings,
} from '../permissionGuards.js';
import { DIRECT_ROUTE_REGISTRATIONS } from './directRoutes.js';
import type { RegisteredRoute } from './types.js';

const PERMISSION_GUARDS = new Map<unknown, InstancePermission>([
  [requireManageSettings, 'instance.manage_settings'],
  [requireManageAgents, 'instance.manage_agents'],
  [requireManageMembers, 'instance.manage_members'],
  [requireManageRuntime, 'instance.manage_runtime'],
  // Real installations require agent management; the read-only demo user is allowed.
  [requireAgentTankUsageAccess, 'instance.manage_agents'],
]);

const placeholderHandler: RequestHandler = (_req, res) => { res.status(501).end(); };

/** Any property of any route collection resolves to a placeholder handler. */
function placeholderDeps(): never {
  const collection = new Proxy({}, { get: () => placeholderHandler });
  return new Proxy({}, { get: () => collection }) as never;
}

/**
 * The route tables exactly as `server.ts` registers them, built with
 * placeholder handlers so no database, Redis or queue is needed.
 */
export function listRegistryRouteEntries(): RouteEntry[] {
  return [
    ...createOperationalRouteEntries(placeholderDeps()),
    ...createMemberCatalogRouteEntries(placeholderDeps()),
    ...createManagementRouteEntries(placeholderDeps()),
  ];
}

/** Every HTTP route the dashboard API server registers. */
export function listRegisteredRoutes(): RegisteredRoute[] {
  const registry = listRegistryRouteEntries().map(([method, path, ...handlers]): RegisteredRoute => {
    const permission = handlers.map(handler => PERMISSION_GUARDS.get(handler)).find(Boolean);
    return { method, path, auth: 'member', ...(permission ? { permission } : {}), source: 'routeRegistry.ts' };
  });
  return [...registry, ...DIRECT_ROUTE_REGISTRATIONS];
}

export function routeKey(route: { method: string; path: string }): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}
