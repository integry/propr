import type { Logger } from 'pino';
import { signAgentRunGrantRequest } from '@propr/core';
import { mcpContainerNetwork } from './mcpNetwork.js';
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
    /** Docker network the agent container joins to reach the MCP URL; defaults to the worker's own Compose network. */
    resolveNetwork?: () => Promise<string | null>;
}

/** Outcome of ending a phase's grant: `calls` is what the MCP access log recorded for it, or null when that is unknown. */
export interface RevokedAgentRunMcpGrant {
    revoked: boolean;
    grantId: string | null;
    calls: number | null;
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
    body: { phase: AgentRunPhase; grantId?: string; expiredBy?: number },
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
    // The container must be able to resolve that URL: a Compose service name
    // such as `api` only exists on the Compose network, not the default bridge.
    const network = await (options.resolveNetwork ?? (() => mcpContainerNetwork({ environment })))();
    return { grantId, phase, url: mcpUrl, token, expiresAt, network };
}

/**
 * Revokes the grant a phase was issued; a grant that is already gone is not an
 * error. Without `grantId`, whatever grant the phase currently holds is
 * revoked; `expiredBy` then limits that to a grant that expired by that time.
 */
export async function revokeAgentRunMcpGrant(
    runId: string,
    grant: Pick<IssuedAgentRunMcpGrant, 'phase'> & { grantId?: string; expiredBy?: number },
    options: McpGrantClientOptions = {},
): Promise<RevokedAgentRunMcpGrant> {
    const payload = await postSigned('/mcp-grants/revoke', runId, { phase: grant.phase, grantId: grant.grantId, expiredBy: grant.expiredBy }, options);
    return {
        revoked: payload.revoked === true,
        grantId: typeof payload.grantId === 'string' ? payload.grantId : null,
        calls: typeof payload.calls === 'number' && Number.isFinite(payload.calls) ? payload.calls : null,
    };
}

/**
 * Revokes a phase's grant when the phase ends. Expiry is only a backstop; a
 * revoke that fails is logged and left to the terminal-run sweep. A grant that
 * ends without one recorded call is reported too: the agent most likely never
 * reached the MCP endpoint, which otherwise only shows up as the agent saying
 * the `propr` tools were unavailable.
 */
export async function revokeGrantQuietly(
    revoke: typeof revokeAgentRunMcpGrant,
    runId: string,
    grant: IssuedAgentRunMcpGrant | null,
    log: Pick<Logger, 'warn'>,
): Promise<void> {
    if (!grant) return;
    try {
        const result = await revoke(runId, grant) as RevokedAgentRunMcpGrant | undefined;
        if (result?.revoked && result.calls === 0) {
            log.warn(
                { runId, phase: grant.phase, grantId: grant.grantId, mcpUrl: grant.url, network: grant.network ?? 'bridge' },
                'Agent run MCP grant ended without a single recorded call: the agent container most likely could not reach the ProPR MCP endpoint (check PROPR_AGENT_MCP_URL and PROPR_AGENT_DOCKER_NETWORK)',
            );
        }
    } catch (error) {
        log.warn({ runId, grantId: grant.grantId, err: error instanceof Error ? error.message : String(error) }, 'Could not revoke agent run MCP grant');
    }
}
