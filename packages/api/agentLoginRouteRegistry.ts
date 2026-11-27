import type { RequestHandler } from 'express';
import type { createAgentLoginRoutes } from './routes/index.js';

type RouteEntry = ['get' | 'post' | 'put' | 'delete', string, ...RequestHandler<never>[]];

/**
 * Agent credential setup: interactive login sessions (a local container, or a Sprite or
 * Fly Machine on Docker-less instances) and write-only pasted credentials.
 */
export function createAgentLoginRouteEntries(
  agentLoginRoutes: ReturnType<typeof createAgentLoginRoutes>,
  requireManageAgents: RequestHandler,
): RouteEntry[] {
  return [
    ['post', '/api/agents/:agentId/login-sessions', requireManageAgents, agentLoginRoutes.startLogin],
    ['get', '/api/agents/:agentId/login-sessions/:sessionId', requireManageAgents, agentLoginRoutes.getLogin],
    ['post', '/api/agents/:agentId/login-sessions/:sessionId/input', requireManageAgents, agentLoginRoutes.sendInput],
    ['delete', '/api/agents/:agentId/login-sessions/:sessionId', requireManageAgents, agentLoginRoutes.cancelLogin],
    ['get', '/api/agents/:agentId/credentials', requireManageAgents, agentLoginRoutes.getCredentials],
    ['put', '/api/agents/:agentId/credentials', requireManageAgents, agentLoginRoutes.putCredential],
    ['delete', '/api/agents/:agentId/credentials/:kind', requireManageAgents, agentLoginRoutes.deleteCredential],
  ];
}
