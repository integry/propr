import type { RegisteredRoute } from './types.js';

/**
 * Routes registered directly on the Express app instead of through
 * `routeRegistry.ts`: health, webhook, authentication, desktop pairing, MCP and
 * the `/api/agents` router. `openapiRouteCoverage.test.ts` scans the files below
 * for `app.<method>(` and `router.<method>(` calls, so a new direct route fails
 * the test until it is listed here.
 */
export const DIRECT_ROUTE_REGISTRATIONS: readonly RegisteredRoute[] = [
  { method: 'get', path: '/health', auth: 'public', source: 'server.ts' },
  { method: 'post', path: '/webhook', auth: 'webhook', source: 'server.ts' },
  { method: 'get', path: '/api/compatibility', auth: 'public', source: 'server.ts' },

  { method: 'get', path: '/api/auth/github', auth: 'public', source: 'auth.ts' },
  { method: 'get', path: '/api/auth/github/callback', auth: 'public', source: 'auth.ts' },
  { method: 'get', path: '/api/auth/logout', auth: 'public', source: 'auth.ts' },
  { method: 'get', path: '/api/auth/user', auth: 'member', source: 'auth.ts' },
  { method: 'get', path: '/api/auth/demo-mode', auth: 'public', source: 'auth.ts' },

  { method: 'get', path: '/api/desktop/discovery', auth: 'public', source: 'desktopApiBoundary.ts' },
  { method: 'post', path: '/api/desktop/pairings', auth: 'public', source: 'desktopApiBoundary.ts' },
  { method: 'post', path: '/api/desktop/pairings/:pairingId/poll', auth: 'public', source: 'desktopApiBoundary.ts' },
  { method: 'post', path: '/api/desktop/pairings/:pairingId/activate', auth: 'public', source: 'desktopApiBoundary.ts' },
  { method: 'post', path: '/api/desktop/pairings/:pairingId/cancel', auth: 'public', source: 'desktopApiBoundary.ts' },
  { method: 'get', path: '/api/desktop/pairings/:pairingId/browser', auth: 'public', source: 'desktopApiBoundary.ts' },
  { method: 'delete', path: '/api/desktop/tokens/current', auth: 'instanceToken', source: 'desktopApiBoundary.ts' },
  { method: 'get', path: '/api/desktop/pairings/:pairingId/approval', auth: 'browserSession', source: 'server.ts' },
  { method: 'post', path: '/api/desktop/pairings/:pairingId/approve', auth: 'browserSession', source: 'server.ts' },
  { method: 'get', path: '/api/desktop/tokens', auth: 'member', source: 'server.ts' },
  { method: 'delete', path: '/api/desktop/tokens/:tokenId', auth: 'member', source: 'server.ts' },

  { method: 'get', path: '/.well-known/oauth-authorization-server', auth: 'public', source: 'mcp/server.ts' },
  // `app.all('/api/mcp')`: Streamable HTTP uses POST for requests, GET for the
  // server stream and DELETE to end a session.
  { method: 'post', path: '/api/mcp', auth: 'mcp', source: 'mcp/server.ts' },
  { method: 'get', path: '/api/mcp', auth: 'mcp', source: 'mcp/server.ts' },
  { method: 'delete', path: '/api/mcp', auth: 'mcp', source: 'mcp/server.ts' },
  { method: 'get', path: '/mcp/consent', auth: 'browserSession', source: 'mcp/browser.ts' },
  { method: 'post', path: '/mcp/consent', auth: 'browserSession', source: 'mcp/browser.ts' },
  { method: 'get', path: '/mcp/apps', auth: 'browserSession', source: 'mcp/browser.ts' },
  { method: 'post', path: '/mcp/apps/revoke', auth: 'browserSession', source: 'mcp/browser.ts' },
  { method: 'get', path: '/mcp/artifacts/:id', auth: 'browserSession', source: 'mcp/browser.ts' },

  { method: 'post', path: '/api/agents/:agentId/health', auth: 'member', permission: 'instance.manage_agents', source: 'routes/agentRoutes.ts' },
  { method: 'get', path: '/api/agents/opencode/models', auth: 'member', permission: 'instance.manage_agents', source: 'routes/agentRoutes.ts' },
  { method: 'post', path: '/api/agents/chat', auth: 'member', source: 'routes/agentRoutes.ts' },
];
