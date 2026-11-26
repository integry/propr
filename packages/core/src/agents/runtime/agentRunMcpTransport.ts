import { flyMcpEndpoint } from './fly/config.js';
import type { AgentNetworkMode } from '../../network/networkPolicy.js';
import { restrictedSpriteMcpEndpoint } from './sprites/spritesNetwork.js';
import {
    SPRITES_MCP_FORWARD_ENV, SPRITES_MCP_TRANSPORT_ENV, spritesMcpForwardEnabled, spritesMcpForwardTarget, spritesMcpTransportPreference,
} from './sprites/spritesMcpForwardConfig.js';
import { getAgentRuntime, runtimeSupportsMcpReachableUrl, type ProviderAgentRuntime } from './registry.js';
import type { AgentConfig } from '../types.js';
import type { AgentRunMcpTransport } from './types.js';

/**
 * How an agent run reaches the ProPR MCP endpoint its grant names, as a
 * runtime capability. The private network (the API-only Compose network) is
 * preferred wherever the runtime can join it; a runtime that cannot falls back
 * to a URL its default network reaches, authenticated by the run's grant token
 * alone (that token is per run, scoped and revoked when the phase ends).
 * A runtime that can carry MCP over a per-run SSH reverse forward (Sprites)
 * uses it when it has no explicit or public HTTPS MCP URL, or always with
 * `PROPR_SPRITES_MCP_TRANSPORT=forward`.
 */
export type AgentRunMcpTransportPlan =
    | { transport: 'private-network'; reason: string }
    | { transport: 'reachable-url'; url: string; reason: string }
    | { transport: 'ssh-reverse-forward'; url: string; reason: string }
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

/** A runtime-specific endpoint reachable from the agent's network. */
export function agentRunMcpRuntimeEndpoint(kind: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
    if (kind === 'fly-machines') return flyMcpEndpoint(environment);
    return kind === 'sprites' ? environment.PROPR_SPRITES_MCP_URL?.trim() || undefined : undefined;
}

function selectAgentRunMcpTransport(
    runtime: Pick<ProviderAgentRuntime, 'kind' | 'capabilities'>,
    environment: NodeJS.ProcessEnv = process.env,
): AgentRunMcpTransportPlan {
    const own = agentRunMcpRuntimeEndpoint(runtime.kind, environment);
    if (own && runtimeSupportsMcpReachableUrl(runtime.capabilities)) {
        return { transport: 'reachable-url', url: own, reason: `Runs on agent runtime "${runtime.kind}" reach their runtime-specific ProPR MCP endpoint with their per-run grant token.` };
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

/**
 * Selection on a runtime that can carry MCP over an SSH reverse forward, with
 * `PROPR_SPRITES_MCP_TRANSPORT=auto` (the default):
 * 1. the runtime's explicit endpoint (`PROPR_SPRITES_MCP_URL`), or a public
 *    HTTPS URL (`PROPR_AGENT_MCP_URL` / `API_PUBLIC_URL`), used directly;
 * 2. otherwise the per-run SSH reverse forward to the internal API;
 * 3. otherwise the run is refused with what to configure.
 * With `PROPR_SPRITES_MCP_TRANSPORT=forward` the forward is used even when a
 * public URL exists, so ProPR MCP never needs to be reachable from the
 * internet; such runs are refused rather than falling back to a URL.
 * Returns undefined when the forward does not apply (another runtime, or the
 * forward disabled with `PROPR_SPRITES_MCP_FORWARD=0` under `auto`).
 */
function selectReverseForward(
    runtime: Pick<ProviderAgentRuntime, 'kind' | 'capabilities'>,
    plan: AgentRunMcpTransportPlan,
    environment: NodeJS.ProcessEnv,
): AgentRunMcpTransportPlan | undefined {
    if (!runtime.capabilities.supportsMcpReverseForward) return undefined;
    const preference = spritesMcpTransportPreference(environment);
    if (typeof preference !== 'string') {
        return { transport: 'unavailable', reason: `Agent runtime "${runtime.kind}" cannot plan its ProPR MCP transport: ${preference.reason}; runs that need ProPR MCP are refused.` };
    }
    const forced = preference === 'forward';
    if (!spritesMcpForwardEnabled(environment)) {
        if (!forced) return undefined;
        return { transport: 'unavailable', reason: `${SPRITES_MCP_TRANSPORT_ENV}=forward requires the SSH reverse forward, but ${SPRITES_MCP_FORWARD_ENV} turns it off; runs that need ProPR MCP are refused. Unset one of them.` };
    }
    if (!forced && plan.transport === 'reachable-url') {
        const explicit = agentRunMcpRuntimeEndpoint(runtime.kind, environment);
        if (plan.url === explicit || !('reason' in restrictedSpriteMcpEndpoint(plan.url))) return undefined;
    }
    const target = spritesMcpForwardTarget(environment);
    if ('reason' in target) {
        return forced
            ? { transport: 'unavailable', reason: `${SPRITES_MCP_TRANSPORT_ENV}=forward requires the SSH reverse forward, which cannot reach the internal API: ${target.reason}. Fix PROPR_INTERNAL_API_URL, or set ${SPRITES_MCP_TRANSPORT_ENV}=auto to use a public HTTPS URL.` }
            : { transport: 'unavailable', reason: `Agent runtime "${runtime.kind}" has no public HTTPS ProPR MCP URL, and the SSH reverse forward cannot reach the internal API: ${target.reason}. Set PROPR_SPRITES_MCP_URL (or API_PUBLIC_URL) to a public HTTPS URL, or fix PROPR_INTERNAL_API_URL.` };
    }
    const reason = forced
        ? `${SPRITES_MCP_TRANSPORT_ENV}=forward: runs on agent runtime "${runtime.kind}" reach ProPR MCP on a loopback address inside the run, carried to the internal API by a per-run SSH reverse forward from the worker, with their per-run grant token; no public MCP URL is used.`
        : `Agent runtime "${runtime.kind}" has no public HTTPS ProPR MCP URL; runs reach ProPR MCP on a loopback address inside the run, carried to the internal API by a per-run SSH reverse forward from the worker, with their per-run grant token (set ${SPRITES_MCP_FORWARD_ENV}=0 to require a public URL instead).`;
    return { transport: 'ssh-reverse-forward', url: target.url, reason };
}

export function planAgentRunMcpTransport(
    runtime: Pick<ProviderAgentRuntime, 'kind' | 'capabilities'>,
    environment: NodeJS.ProcessEnv = process.env,
    networkMode: AgentNetworkMode = 'open',
): AgentRunMcpTransportPlan {
    const selected = selectAgentRunMcpTransport(runtime, environment);
    const plan = selectReverseForward(runtime, selected, environment) ?? selected;
    if (runtime.kind === 'sprites' && networkMode === 'restricted' && plan.transport === 'reachable-url') {
        const endpoint = restrictedSpriteMcpEndpoint(plan.url);
        if ('reason' in endpoint) return { transport: 'unavailable', reason: endpoint.reason };
    }
    return plan;
}

/** The plan for the runtime an agent configuration selects (or the instance default). */
export function agentRunMcpTransportFor(
    config?: Pick<AgentConfig, 'runtime'> | null,
    environment: NodeJS.ProcessEnv = process.env,
    networkMode: AgentNetworkMode = 'open',
): AgentRunMcpTransportPlan & { runtime: string } {
    const runtime = getAgentRuntime(config, environment);
    return { ...planAgentRunMcpTransport(runtime, environment, networkMode), runtime: runtime.kind };
}

export type { AgentRunMcpTransport };
