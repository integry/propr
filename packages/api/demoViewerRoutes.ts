import { refuseDemoViewer } from './permissionGuards.js';
import type { RouteEntry } from './routeRegistry.js';

/**
 * Management reads the demo viewer may make. Each is answered from the curated
 * demo database (or a synthetic feed); every other management route also
 * passes through refuseDemoViewer, so a new route stays closed to the demo
 * until it is reviewed and listed here.
 */
export const DEMO_VIEWER_MANAGEMENT_READS: ReadonlySet<string> = new Set([
  '/api/config/followup-keywords',
  '/api/config/followup-ignore-keywords',
  '/api/config/repos',
  '/api/config/settings',
  '/api/config/pr-label',
  '/api/config/ai-primary-tag',
  '/api/config/primary-processing-labels',
  '/api/config/agents',
  '/api/config/synthetic-agents',
  '/api/config/summarization',
  '/api/config/repos/indexing-status',
  '/api/config/agent-tank/usage',
  '/api/admin/members',
  '/api/admin/role-audit',
  '/api/admin/mcp',
  '/api/admin/mcp/logs',
  '/api/admin/mcp/logs/stats',
].map(path => `get ${path}`));

export function withDemoViewerBoundary([method, path, ...handlers]: RouteEntry): RouteEntry {
  if (DEMO_VIEWER_MANAGEMENT_READS.has(`${method} ${path}`)) return [method, path, ...handlers];
  // Insert after the permission guard so unauthorized callers keep their 403 code.
  const [guard, ...rest] = handlers;
  return [method, path, guard, refuseDemoViewer, ...rest];
}
