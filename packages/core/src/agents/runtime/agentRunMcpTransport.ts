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
    const explicit = agentRunMcpUnpinnedEndpoint(environment);
    if (explicit) return explicit;
    const origin = environment.API_PUBLIC_URL?.trim();
    if (!origin) return undefined;
    let end = origin.length;
    while (end > 0 && origin[end - 1] === '/') end--;
    return end > 0 ? `${origin.slice(0, end)}/api/mcp` : undefined;
}

/**
 * An explicit `PROPR_AGENT_MCP_URL` with no `PROPR_AGENT_DOCKER_NETWORK`
 * pinned beside it: a custom endpoint that authorizes joining no private
 * network, so runs reach it at that URL whatever networks the runtime can join.
 */
export function agentRunMcpUnpinnedEndpoint(environment: NodeJS.ProcessEnv = process.env): string | undefined {
    const explicit = environment.PROPR_AGENT_MCP_URL?.trim();
    return explicit && !environment.PROPR_AGENT_DOCKER_NETWORK?.trim() ? explicit : undefined;
}

/**
 * A runtime's own public MCP endpoint: `PROPR_SPRITES_MCP_URL` for Sprites,
 * which can never reach a private address (for example a public ProPR origin
 * or a Sprites Connect gateway in front of the API).
 */
export function agentRunMcpRuntimeEndpoint(kind: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
    return kind === 'sprites' ? environment.PROPR_SPRITES_MCP_URL?.trim() || undefined : undefined;
}

export function planAgentRunMcpTransport(
    runtime: Pick<ProviderAgentRuntime, 'kind' | 'capabilities'>,
    environment: NodeJS.ProcessEnv = process.env,
): AgentRunMcpTransportPlan {
    const own = agentRunMcpRuntimeEndpoint(runtime.kind, environment);
    if (own && runtimeSupportsMcpReachableUrl(runtime.capabilities)) {
        return { transport: 'reachable-url', url: own, reason: `PROPR_SPRITES_MCP_URL is set; runs on agent runtime "${runtime.kind}" reach ProPR MCP at that URL with their per-run grant token.` };
    }
    // The configured endpoint decides before the private-network preference:
    // an unpinned custom URL never joins a private network, even on a runtime that could.
    const unpinned = agentRunMcpUnpinnedEndpoint(environment);
    if (unpinned) {
        if (!runtimeSupportsMcpReachableUrl(runtime.capabilities)) {
            return { transport: 'unavailable', reason: `PROPR_AGENT_MCP_URL is set without PROPR_AGENT_DOCKER_NETWORK, so runs reach ProPR MCP at that URL, but agent runtime "${runtime.kind}" cannot reach a reachable URL; runs that need ProPR MCP are refused.` };
        }
        return { transport: 'reachable-url', url: unpinned, reason: `PROPR_AGENT_MCP_URL is set without PROPR_AGENT_DOCKER_NETWORK; runs on agent runtime "${runtime.kind}" reach ProPR MCP at that URL with their per-run grant token and join no private network.` };
    }
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
