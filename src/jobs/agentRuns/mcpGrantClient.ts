import type { Logger } from 'pino';
import { signAgentRunGrantRequest } from '@propr/core';
import type { AgentRunMcpGrant, AgentRunPhase } from './toolPolicy.js';

/**
 * Worker side of the run-scoped ProPR MCP grants (issue 9). The worker cannot
 * import the API package, so it asks the API's internal endpoints, signing
 * each request with `SYSTEM_TASK_SECRET`. The token is returned to the caller
 * only to be handed to the agent container; it is never logged or stored.
 */

const REQUEST_TIMEOUT_MS = 15_000;

/** A grant issued for one phase of one run. */
export interface IssuedAgentRunMcpGrant extends AgentRunMcpGrant {
    grantId: string;
    phase: AgentRunPhase;
    expiresAt: number;
}

export class AgentRunMcpGrantError extends Error {
    constructor(message: string, readonly status: number | null, readonly code: string | null) {
        super(message);
        this.name = 'AgentRunMcpGrantError';
    }
}

export interface McpGrantClientOptions {
    environment?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    now?: () => number;
}

export function internalApiUrl(environment: NodeJS.ProcessEnv = process.env): string {
    return (environment.PROPR_INTERNAL_API_URL || 'http://api:4000').replace(/\/+$/, '');
}

/** Agent containers reach the API over the Docker network, not the public origin. */
export function agentContainerMcpUrl(environment: NodeJS.ProcessEnv = process.env): string {
    return environment.PROPR_AGENT_MCP_URL || `${internalApiUrl(environment)}/api/mcp`;
}

async function postSigned(
    path: string,
    runId: string,
    body: { phase: AgentRunPhase; grantId?: string },
    { environment = process.env, fetchImpl = fetch, now = Date.now }: McpGrantClientOptions,
): Promise<Record<string, unknown>> {
    const secret = environment.SYSTEM_TASK_SECRET;
    if (!secret) throw new AgentRunMcpGrantError('SYSTEM_TASK_SECRET is not configured on the worker', null, 'SYSTEM_TASK_SECRET_MISSING');
    const ts = now();
    const signature = signAgentRunGrantRequest(secret, runId, body.phase, ts);
    let response: Response;
    try {
        response = await fetchImpl(`${internalApiUrl(environment)}/api/internal/agent-runs/${encodeURIComponent(runId)}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ ...body, ts, signature }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch (error) {
        throw new AgentRunMcpGrantError(`ProPR API unreachable: ${error instanceof Error ? error.message : String(error)}`, null, 'API_UNREACHABLE');
    }
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
        const code = typeof payload.error === 'string' ? payload.error : null;
        const message = typeof payload.message === 'string' ? payload.message : `HTTP ${response.status}`;
        throw new AgentRunMcpGrantError(`ProPR MCP grant request failed (${code ?? response.status}): ${message}`, response.status, code);
    }
    return payload;
}

/** Requests a grant for one phase; the run must be `running` (report) or `acting` (action). */
export async function requestAgentRunMcpGrant(runId: string, phase: AgentRunPhase, options: McpGrantClientOptions = {}): Promise<IssuedAgentRunMcpGrant> {
    const payload = await postSigned('/mcp-grants', runId, { phase }, options);
    const { grantId, url, token, expiresAt } = payload;
    if (typeof grantId !== 'string' || typeof token !== 'string' || typeof expiresAt !== 'number') {
        throw new AgentRunMcpGrantError('ProPR MCP grant response is malformed', null, 'INVALID_RESPONSE');
    }
    const environment = options.environment ?? process.env;
    // An explicit worker-side URL wins: it describes the network the worker launches containers on.
    const mcpUrl = environment.PROPR_AGENT_MCP_URL || (typeof url === 'string' && url ? url : agentContainerMcpUrl(environment));
    return { grantId, phase, url: mcpUrl, token, expiresAt };
}

/** Revokes the grant a phase was issued; a grant that is already gone is not an error. */
export async function revokeAgentRunMcpGrant(
    runId: string,
    grant: Pick<IssuedAgentRunMcpGrant, 'grantId' | 'phase'>,
    options: McpGrantClientOptions = {},
): Promise<void> {
    await postSigned('/mcp-grants/revoke', runId, { phase: grant.phase, grantId: grant.grantId }, options);
}

/**
 * Revokes a phase's grant when the phase ends. Expiry is only a backstop; a
 * revoke that fails is logged and left to the terminal-run sweep.
 */
export async function revokeGrantQuietly(
    revoke: typeof revokeAgentRunMcpGrant,
    runId: string,
    grant: IssuedAgentRunMcpGrant | null,
    log: Pick<Logger, 'warn'>,
): Promise<void> {
    if (!grant) return;
    try {
        await revoke(runId, grant);
    } catch (error) {
        log.warn({ runId, grantId: grant.grantId, err: error instanceof Error ? error.message : String(error) }, 'Could not revoke agent run MCP grant');
    }
}
