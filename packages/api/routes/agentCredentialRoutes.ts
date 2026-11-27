import type { Response } from 'express';
import type { AgentConfig } from '@propr/core';
import type { FlatRequest } from '../requestTypes.js';
import {
  AgentCredentialInputError,
  clearAgentPastedCredential,
  readAgentCredentialStatus,
  setAgentPastedCredential,
} from '../services/agentCredentialStore.js';

interface AgentCredentialRoutesDeps {
  resolveAgent: (agentId: string) => Promise<AgentConfig | undefined>;
  read?: typeof readAgentCredentialStatus;
  set?: typeof setAgentPastedCredential;
  clear?: typeof clearAgentPastedCredential;
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof AgentCredentialInputError) {
    res.status(400).json({ error: error.message });
    return;
  }
  // Never echo a pasted value: the error is logged by name only.
  console.error('Agent credential route failed:', (error as Error)?.name ?? 'Error');
  res.status(500).json({ error: 'Agent credential request failed' });
}

/**
 * Write-only credentials for an agent's credential store. Responses report
 * whether each kind is set and its last four characters, never the value.
 */
export function createAgentCredentialRoutes(deps: AgentCredentialRoutesDeps) {
  const resolveAgent = deps.resolveAgent;
  const read = deps.read ?? readAgentCredentialStatus;
  const set = deps.set ?? setAgentPastedCredential;
  const clear = deps.clear ?? clearAgentPastedCredential;

  const withAgent = (handler: (agent: AgentConfig, req: FlatRequest, res: Response) => Promise<void>) =>
    async (req: FlatRequest, res: Response): Promise<void> => {
      try {
        const agent = await resolveAgent(req.params.agentId);
        if (!agent) {
          res.status(404).json({ error: 'Agent not found' });
          return;
        }
        res.setHeader('Cache-Control', 'no-store');
        await handler(agent, req, res);
      } catch (error) {
        sendError(res, error);
      }
    };

  const getCredentials = withAgent(async (agent, _req, res) => {
    res.json(read(agent));
  });

  const putCredential = withAgent(async (agent, req, res) => {
    const body = (req.body ?? {}) as { kind?: unknown; value?: unknown };
    res.json(await set(agent, body.kind, body.value));
  });

  const deleteCredential = withAgent(async (agent, req, res) => {
    res.json(await clear(agent, req.params.kind));
  });

  return { getCredentials, putCredential, deleteCredential };
}
