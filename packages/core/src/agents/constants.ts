import type { AgentType } from './types.js';

export const AGENT_TYPES = ['claude', 'codex', 'antigravity', 'opencode', 'vibe'] as const satisfies readonly AgentType[];

/**
 * CLIs the unified agent image bundles before they have an agent type. Their
 * versions are part of the image's CLI matrix, labels and build args, but no
 * agent config selects them yet. Pi joins AgentType later; the Set keeps
 * AGENT_CLI_TYPES free of duplicates once it does.
 */
const IMAGE_ONLY_CLI_TYPES = ['pi'] as const;
export type AgentCliType = AgentType | (typeof IMAGE_ONLY_CLI_TYPES)[number];
/** Every CLI bundled in the unified agent image, in matrix order. */
export const AGENT_CLI_TYPES: readonly AgentCliType[] = [...new Set<AgentCliType>([...AGENT_TYPES, ...IMAGE_ONLY_CLI_TYPES])];
export const AGENT_IMAGE_NAME = 'propr/agent';
export const DEFAULT_AGENT_EXECUTION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

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
