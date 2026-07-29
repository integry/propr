import type { Request, Response } from 'express';
import { getAgentRegistry, loadAgents, type AgentConfig } from '@propr/core';
import {
  AgentLoginConflictError,
  AgentLoginInputError,
  AgentLoginSessionManager,
  AgentLoginSessionNotFoundError,
  agentLoginSessionManager,
} from '../services/agentLoginSessionManager.js';

interface AgentLoginRoutesDeps {
  sessionManager?: AgentLoginSessionManager;
  resolveAgent?: (agentId: string) => Promise<AgentConfig | undefined>;
}

async function defaultResolveAgent(agentId: string): Promise<AgentConfig | undefined> {
  const registry = getAgentRegistry();
  try {
    await registry.ensureInitialized();
    const registered = registry.getAgentById(agentId) ?? registry.getAgentByAlias(agentId);
    if (registered) return registered.config;
  } catch (error) {
    console.warn('Could not resolve agent login target from the live registry:', (error as Error).message);
  }
  return (await loadAgents()).find(agent => agent.id === agentId || agent.alias === agentId);
}

function username(req: Request, res: Response): string | undefined {
  const value = req.user?.username;
  if (value) return value;
  res.status(401).json({ error: 'Authentication required' });
  return undefined;
}

function sendRouteError(res: Response, error: unknown): void {
  if (error instanceof AgentLoginSessionNotFoundError) {
    res.status(404).json({ error: error.message });
    return;
  }
  if (error instanceof AgentLoginConflictError) {
    res.status(409).json({ error: error.message });
    return;
  }
  if (error instanceof AgentLoginInputError) {
    res.status(400).json({ error: error.message });
    return;
  }
  console.error('Agent login route failed:', error);
  res.status(500).json({ error: 'Agent login request failed' });
}

export function createAgentLoginRoutes(deps: AgentLoginRoutesDeps = {}) {
  const sessions = deps.sessionManager ?? agentLoginSessionManager;
  const resolveAgent = deps.resolveAgent ?? defaultResolveAgent;

  const matchesAgent = async (agentIdOrAlias: string, canonicalAgentId: string): Promise<boolean> => {
    if (agentIdOrAlias === canonicalAgentId) return true;
    const agent = await resolveAgent(agentIdOrAlias);
    return agent?.id === canonicalAgentId;
  };

  const startLogin = async (req: Request, res: Response): Promise<void> => {
    const owner = username(req, res);
    if (!owner) return;
    try {
      const agent = await resolveAgent(req.params.agentId);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      // Disabled agents may be authenticated intentionally before they are
      // enabled, so login resolution does not filter on agent.enabled.
      const session = await sessions.start(agent, owner);
      res.status(202).json(session);
    } catch (error) {
      sendRouteError(res, error);
    }
  };

  const getLogin = async (req: Request, res: Response): Promise<void> => {
    const owner = username(req, res);
    if (!owner) return;
    try {
      const session = sessions.get(req.params.sessionId, owner);
      if (!(await matchesAgent(req.params.agentId, session.agentId))) {
        res.status(404).json({ error: 'Agent login session not found' });
        return;
      }
      res.json(session);
    } catch (error) {
      sendRouteError(res, error);
    }
  };

  const sendInput = async (req: Request, res: Response): Promise<void> => {
    const owner = username(req, res);
    if (!owner) return;
    try {
      const input = req.body?.input;
      if (typeof input !== 'string') {
        res.status(400).json({ error: 'input must be a string' });
        return;
      }
      const current = sessions.get(req.params.sessionId, owner);
      if (!(await matchesAgent(req.params.agentId, current.agentId))) {
        res.status(404).json({ error: 'Agent login session not found' });
        return;
      }
      res.json(sessions.write(req.params.sessionId, owner, input));
    } catch (error) {
      sendRouteError(res, error);
    }
  };

  const cancelLogin = async (req: Request, res: Response): Promise<void> => {
    const owner = username(req, res);
    if (!owner) return;
    try {
      const current = sessions.get(req.params.sessionId, owner);
      if (!(await matchesAgent(req.params.agentId, current.agentId))) {
        res.status(404).json({ error: 'Agent login session not found' });
        return;
      }
      res.json(await sessions.cancel(req.params.sessionId, owner));
    } catch (error) {
      sendRouteError(res, error);
    }
  };

  return { startLogin, getLogin, sendInput, cancelLogin };
}
