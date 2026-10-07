import { SYSTEM_ROUTE_DOCS } from './routeDocsSystem.js';
import { TASK_ROUTE_DOCS } from './routeDocsTasks.js';
import type { RouteDoc } from './types.js';

/**
 * OpenAPI annotations keyed by `METHOD /express/path`, the sibling table of
 * `routeRegistry.ts`. Registered routes without an entry are still published,
 * marked `x-undocumented: true`; add entries here to drive that count to zero.
 */
export const ROUTE_DOCS: Readonly<Record<string, RouteDoc>> = {
  ...SYSTEM_ROUTE_DOCS,
  ...TASK_ROUTE_DOCS,
};
