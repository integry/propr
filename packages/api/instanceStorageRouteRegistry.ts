import type { createInstanceStorageRoutes } from './routes/instanceStorageRoutes.js';
import { requireManageSettings } from './permissionGuards.js';
import type { RouteEntry } from './routeRegistry.js';

export function createStorageRouteEntries(storage: ReturnType<typeof createInstanceStorageRoutes>): RouteEntry[] {
  const base = '/api/instance/storage/v1';
  return [
    ['get', `${base}/usage`, requireManageSettings, storage.usage],
    ['get', `${base}/policy`, requireManageSettings, storage.policy],
    ['put', `${base}/policy`, requireManageSettings, storage.updatePolicy],
    ['post', `${base}/cleanup/preview`, requireManageSettings, storage.preview],
    ['post', `${base}/cleanup/execute`, requireManageSettings, storage.execute],
    ['get', `${base}/cleanup/operations/:operationId`, requireManageSettings, storage.result],
  ];
}
