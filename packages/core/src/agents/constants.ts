import type { AgentType } from './types.js';

export const AGENT_TYPES = ['claude', 'codex', 'gemini', 'opencode'] as const satisfies readonly AgentType[];

export const AGENT_IMAGE_NAMES: Record<AgentType, string> = {
    claude: 'propr-claude',
    codex: 'propr-codex',
    gemini: 'propr-gemini',
    opencode: 'propr-opencode'
};

export const DEFAULT_AGENT_DOCKER_IMAGES: Record<AgentType, string> = {
    claude: `${AGENT_IMAGE_NAMES.claude}:latest`,
    codex: `${AGENT_IMAGE_NAMES.codex}:latest`,
    gemini: `${AGENT_IMAGE_NAMES.gemini}:latest`,
    opencode: `${AGENT_IMAGE_NAMES.opencode}:latest`
};
