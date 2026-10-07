import type { AgentCapability } from '@propr/shared';
import { PROPR_MCP_BEARER_TOKEN_ENV, PROPR_MCP_SERVER_NAME, type AgentToolPolicy } from '@propr/core';

/** Run-scoped ProPR MCP credential issued for one agent run (issue 9). */
export interface AgentRunMcpGrant {
    url: string;
    token: string;
}

export type AgentRunPhase = 'report' | 'action';

function proprMcpServer(grant: AgentRunMcpGrant): NonNullable<AgentToolPolicy['mcpServers']>[number] {
    return { name: PROPR_MCP_SERVER_NAME, url: grant.url, bearerTokenEnv: PROPR_MCP_BEARER_TOKEN_ENV, bearerToken: grant.token };
}

/**
 * Maps a definition's capabilities to the enforced tool policy for one phase.
 * Report phase: web follows the `web` capability; the ProPR MCP is mounted
 * only when `propr_mcp` is enabled and a grant was issued. Action phase: the
 * ProPR MCP is always mounted (given its grant); web still follows the definition.
 */
export function agentRunToolPolicy(input: {
    phase: AgentRunPhase;
    capabilities: readonly AgentCapability[];
    mcpGrant?: AgentRunMcpGrant | null;
}): AgentToolPolicy {
    const { phase, capabilities, mcpGrant } = input;
    const allowWeb = capabilities.includes('web');
    const wantsMcp = phase === 'action' || capabilities.includes('propr_mcp');
    return wantsMcp && mcpGrant ? { allowWeb, mcpServers: [proprMcpServer(mcpGrant)] } : { allowWeb };
}
