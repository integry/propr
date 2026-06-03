import type { AgentType } from './types.js';

export const AGENT_TYPES = ['claude', 'codex', 'gemini', 'opencode', 'vibe'] as const satisfies readonly AgentType[];

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

export const AGENT_IMAGE_NAMES: Record<AgentType, string> = {
    claude: 'propr/agent-claude',
    codex: 'propr/agent-codex',
    gemini: 'propr/agent-gemini',
    opencode: 'propr/agent-opencode',
    vibe: 'propr/agent-vibe'
};

export const VERSIONED_AGENT_IMAGE_NAMES: Record<AgentType, string> = {
    ...AGENT_IMAGE_NAMES,
    opencode: 'propr-opencode'
};

export const DEFAULT_AGENT_DOCKER_IMAGES: Record<AgentType, string> = {
    claude: `${AGENT_IMAGE_NAMES.claude}:latest`,
    codex: `${AGENT_IMAGE_NAMES.codex}:latest`,
    gemini: `${AGENT_IMAGE_NAMES.gemini}:latest`,
    opencode: `${AGENT_IMAGE_NAMES.opencode}:latest`,
    vibe: `${AGENT_IMAGE_NAMES.vibe}:latest`
};
