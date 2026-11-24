import { getAgentRuntime, runtimeSupportsMcpReachableUrl, type ProviderAgentRuntime } from './registry.js';
import type { AgentConfig } from '../types.js';
import type { AgentRunMcpTransport } from './types.js';

/**
 * How an agent run reaches the ProPR MCP endpoint its grant names, as a
 * runtime capability. The private network (the API-only Compose network) is
 * preferred wherever the runtime can join it; a runtime that cannot falls back
 * to a URL its default network reaches, authenticated by the run's grant token
 * alone (that token is per run, scoped and revoked when the phase ends).
 */
export type AgentRunMcpTransportPlan =
    | { transport: 'private-network'; reason: string }
    | { transport: 'reachable-url'; url: string; reason: string }
    | { transport: 'unavailable'; reason: string };

/**
 * A URL agent runs can reach without joining a private network:
 * `PROPR_AGENT_MCP_URL` when no private network is pinned with it, else the
 * API's public origin (`API_PUBLIC_URL`) plus `/api/mcp`.
 */
export function agentRunMcpReachableUrl(environment: NodeJS.ProcessEnv = process.env): string | undefined {
    const explicit = environment.PROPR_AGENT_MCP_URL?.trim();
    if (explicit && !environment.PROPR_AGENT_DOCKER_NETWORK?.trim()) return explicit;
    const origin = environment.API_PUBLIC_URL?.trim().replace(/\/+$/, '');
    return origin ? `${origin}/api/mcp` : undefined;
}

export function planAgentRunMcpTransport(
    runtime: Pick<ProviderAgentRuntime, 'kind' | 'capabilities'>,
    environment: NodeJS.ProcessEnv = process.env,
): AgentRunMcpTransportPlan {
    if (runtime.capabilities.supportsMcpPrivateNetwork) {
        return { transport: 'private-network', reason: `Agent runtime "${runtime.kind}" joins the private network that reaches the ProPR MCP endpoint when one is configured or discovered.` };
    }
    if (!runtimeSupportsMcpReachableUrl(runtime.capabilities)) {
        return { transport: 'unavailable', reason: `Agent runtime "${runtime.kind}" can neither join a private network nor reach the ProPR MCP endpoint at a reachable URL; runs that need ProPR MCP are refused.` };
    }
    const url = agentRunMcpReachableUrl(environment);
    if (!url) {
        return { transport: 'unavailable', reason: `Agent runtime "${runtime.kind}" cannot join a private network, and no reachable MCP URL is configured: set PROPR_AGENT_MCP_URL (without PROPR_AGENT_DOCKER_NETWORK) or API_PUBLIC_URL.` };
    }
    return { transport: 'reachable-url', url, reason: `Agent runtime "${runtime.kind}" cannot join a private network; runs reach ProPR MCP at a reachable URL with their per-run grant token.` };
}

/** The plan for the runtime an agent configuration selects (or the instance default). */
export function agentRunMcpTransportFor(
    config?: Pick<AgentConfig, 'runtime'> | null,
    environment: NodeJS.ProcessEnv = process.env,
): AgentRunMcpTransportPlan & { runtime: string } {
    const runtime = getAgentRuntime(config, environment);
    return { ...planAgentRunMcpTransport(runtime, environment), runtime: runtime.kind };
}

export type { AgentRunMcpTransport };
