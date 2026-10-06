import { timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { Knex } from 'knex';
import { db, getAgentRunById, logger, signAgentRunGrantRequest, type StoredAgentRun } from '@propr/core';
import { McpError } from '../mcp/config.js';
import {
  AGENT_RUN_GRANT_PHASES,
  issueAgentRunGrant,
  revokeAgentRunPhaseGrant,
  type AgentRunGrantDependencies,
  type AgentRunGrantPhase,
} from '../mcp/agentRunGrants.js';

/**
 * Internal endpoints the worker uses to obtain and revoke run-scoped ProPR MCP
 * grants. They sit before the session guard and are authenticated by an HMAC
 * over the run id, phase and timestamp signed with `SYSTEM_TASK_SECRET`, the
 * trust root already shared by the API and the worker. The owner and the
 * repositories always come from the run snapshot, never from the request.
 */

export const AGENT_RUN_GRANT_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

/** States in which each phase may obtain a grant. */
const PHASE_RUN_STATE: Readonly<Record<AgentRunGrantPhase, StoredAgentRun['state']>> = {
  report: 'running',
  action: 'acting',
};

export interface AgentRunInternalRouteDependencies extends AgentRunGrantDependencies {
  database?: Knex;
  getRun?: (runId: string) => Promise<StoredAgentRun | undefined>;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Absolute URL of the MCP endpoint as reached from agent containers. */
  mcpUrl?: () => string;
}

export function agentContainerMcpUrl(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.PROPR_AGENT_MCP_URL) return environment.PROPR_AGENT_MCP_URL;
  const base = (environment.PROPR_INTERNAL_API_URL || 'http://api:4000').replace(/\/+$/, '');
  return `${base}/api/mcp`;
}

type SignedBody = { phase: AgentRunGrantPhase; grantId?: string };

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: code, message });
}

export function createAgentRunInternalRoutes(deps: AgentRunInternalRouteDependencies = {}) {
  const database = deps.database ?? db;
  const getRun = deps.getRun ?? (runId => getAgentRunById(runId, { database }));
  const environment = deps.environment ?? process.env;
  const now = deps.now ?? Date.now;
  const mcpUrl = deps.mcpUrl ?? (() => agentContainerMcpUrl(environment));
  const grantDeps: AgentRunGrantDependencies = { database, resolveConfig: deps.resolveConfig, userGrants: deps.userGrants };

  /** Verifies the signed body; responds and returns null when it is not acceptable. */
  function verify(req: Request, res: Response): SignedBody | null {
    const secret = environment.SYSTEM_TASK_SECRET;
    if (!secret) {
      sendError(res, 503, 'SYSTEM_TASK_SECRET_MISSING', 'SYSTEM_TASK_SECRET is not configured on the API service.');
      return null;
    }
    const runId = req.params.runId;
    const { phase, ts, signature, grantId } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof runId !== 'string' || !runId || typeof phase !== 'string' || !AGENT_RUN_GRANT_PHASES.includes(phase as AgentRunGrantPhase)
      || typeof ts !== 'number' || !Number.isSafeInteger(ts) || typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)
      || (grantId !== undefined && typeof grantId !== 'string')) {
      sendError(res, 400, 'INVALID_REQUEST', 'phase, ts and signature are required.');
      return null;
    }
    const expected = Buffer.from(signAgentRunGrantRequest(secret, runId, phase, ts), 'hex');
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
      sendError(res, 401, 'INVALID_SIGNATURE', 'The request signature is invalid.');
      return null;
    }
    if (Math.abs(now() - ts) >= AGENT_RUN_GRANT_SIGNATURE_WINDOW_MS) {
      sendError(res, 401, 'SIGNATURE_EXPIRED', 'The request signature has expired.');
      return null;
    }
    return { phase: phase as AgentRunGrantPhase, ...(typeof grantId === 'string' ? { grantId } : {}) };
  }

  function sendGrantError(res: Response, error: unknown, action: string, runId: string): void {
    if (error instanceof McpError) {
      sendError(res, error.status, error.code, error.message);
      return;
    }
    logger.error({ runId, err: error instanceof Error ? error.message : String(error) }, `[agent-runs] Could not ${action} MCP grant`);
    sendError(res, 500, 'GRANT_UNAVAILABLE', `Could not ${action} the MCP grant.`);
  }

  const issueGrant: RequestHandler = async (req, res) => {
    const body = verify(req, res);
    if (!body) return;
    const runId = req.params.runId as string;
    try {
      const run = await getRun(runId);
      if (!run) { sendError(res, 404, 'NOT_FOUND', 'Agent run not found.'); return; }
      if (run.state !== PHASE_RUN_STATE[body.phase]) {
        sendError(res, 409, 'INVALID_RUN_STATE', `A ${body.phase} grant requires a ${PHASE_RUN_STATE[body.phase]} run; this run is ${run.state}.`);
        return;
      }
      const definition = run.definitionSnapshot;
      if (!definition) { sendError(res, 409, 'INVALID_RUN_STATE', 'The agent definition snapshot is unreadable.'); return; }
      const grant = await issueAgentRunGrant({
        ownerId: run.ownerId, definitionName: definition.name, runId, phase: body.phase, repositories: definition.repositories,
      }, grantDeps);
      res.set('Cache-Control', 'no-store').json({ grantId: grant.grantId, url: mcpUrl(), token: grant.accessToken, expiresAt: grant.expiresAt });
    } catch (error) {
      sendGrantError(res, error, 'issue', runId);
    }
  };

  // Revocation is accepted in every run state: it is how a phase, a crash
  // recovery or the sweep ends a grant.
  const revokeGrant: RequestHandler = async (req, res) => {
    const body = verify(req, res);
    if (!body) return;
    const runId = req.params.runId as string;
    try {
      const revoked = await revokeAgentRunPhaseGrant(runId, body.phase, { ...grantDeps, grantId: body.grantId });
      res.json({ revoked: revoked !== null, grantId: revoked });
    } catch (error) {
      sendGrantError(res, error, 'revoke', runId);
    }
  };

  return { issueGrant, revokeGrant };
}
