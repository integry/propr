import type { RegisteredRoute } from './types.js';

/**
 * Routes registered directly on the Express app instead of through
 * `routeRegistry.ts`: health, webhook, authentication, desktop pairing, MCP and
 * the `/api/agents` router. `openapiRouteCoverage.test.ts` scans the files below
 * for `app.<method>(` and `router.<method>(` calls, so a new direct route fails
 * the test until it is listed here.
 *
 * Handlers mounted with `app.use` are listed too when they answer requests
 * themselves: the MCP OAuth endpoints come from the SDK's `mcpAuthRouter`
 * (`MCP_AUTH_PATHS` in `mcp/server.ts`). The test fails when an `app.use` path
 * or an `MCP_AUTH_PATHS` entry is not covered by a listed or registry route.
 */
export const DIRECT_ROUTE_REGISTRATIONS: readonly RegisteredRoute[] = [
  { method: 'get', path: '/health', auth: 'public', source: 'server.ts' },
  { method: 'post', path: '/webhook', auth: 'webhook', source: 'server.ts' },
  { method: 'get', path: '/api/compatibility', auth: 'public', source: 'server.ts' },
  // Agent run containers authenticate with a request signed by SYSTEM_TASK_SECRET.
  { method: 'post', path: '/api/internal/agent-runs/:runId/mcp-grants', auth: 'public', source: 'server.ts' },
  { method: 'post', path: '/api/internal/agent-runs/:runId/mcp-grants/revoke', auth: 'public', source: 'server.ts' },
  // Hosted Fleet control authenticates with PROPR_FLEET_CONTROL_SECRET and is only
  // registered when that secret is configured.
  { method: 'get', path: '/api/internal/hosted/bootstrap', auth: 'public', source: 'routes/hostedFleetRoutes.ts' },
  { method: 'get', path: '/api/internal/hosted/status', auth: 'public', source: 'routes/hostedFleetRoutes.ts' },
  { method: 'get', path: '/api/internal/hosted/queue', auth: 'public', source: 'routes/hostedFleetRoutes.ts' },

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
  // `mcpAuthRouter` (MCP SDK), mounted at the application root by mcp/server.ts.
  { method: 'get', path: '/.well-known/oauth-protected-resource/api/mcp', auth: 'public', source: 'mcp/server.ts' },
  { method: 'get', path: '/authorize', auth: 'public', source: 'mcp/server.ts' },
  { method: 'post', path: '/authorize', auth: 'public', source: 'mcp/server.ts' },
  { method: 'post', path: '/token', auth: 'public', source: 'mcp/server.ts' },
  { method: 'post', path: '/register', auth: 'public', source: 'mcp/server.ts' },
  { method: 'post', path: '/revoke', auth: 'public', source: 'mcp/server.ts' },
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

/**
 * Paths `server.ts` mounts `goalRoutes.requireGoalTaskOwnership` on with
 * `app.use`. The guard adds no route; the generator notes it, and its `404` and
 * `409` answers, on every route it can act on. `openapiRouteCoverage.test.ts`
 * keeps this list equal to the mount in `server.ts`.
 */
export const GOAL_TASK_GUARD_MOUNTS: readonly string[] = [
  '/api/task/:taskId',
  '/api/task/:taskId/*path',
  '/api/tasks/:taskId',
  '/api/execution/:sessionId',
  '/api/execution/:sessionId/*path',
  '/api/llm-metrics/:correlationId',
];
