import type { AgentType } from './types.js';

export const AGENT_TYPES = ['claude', 'codex', 'antigravity', 'opencode', 'vibe'] as const satisfies readonly AgentType[];
export const AGENT_IMAGE_NAME = 'propr/agent';

const VALID_AGENT_TYPES_SET = new Set<string>(AGENT_TYPES);

export type AgentTypeValidationResult = { ok: true; agentType: AgentType } | { ok: false; error: string };

export function validateAgentType(agentType: unknown): AgentTypeValidationResult {
    if (typeof agentType === 'string' && VALID_AGENT_TYPES_SET.has(agentType)) {
        return { ok: true, agentType: agentType as AgentType };
    }
    return {
        ok: false,
        error: `Invalid agent type '${String(agentType)}'. Must be one of: ${[...AGENT_TYPES].sort().join(', ')}`
    };
}

export const DEFAULT_AGENT_DOCKER_IMAGES: Record<AgentType, string> = {
    claude: `${AGENT_IMAGE_NAME}:latest`,
    codex: `${AGENT_IMAGE_NAME}:latest`,
    antigravity: `${AGENT_IMAGE_NAME}:latest`,
    opencode: `${AGENT_IMAGE_NAME}:latest`,
    vibe: `${AGENT_IMAGE_NAME}:latest`
};
