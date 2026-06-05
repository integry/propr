/**
 * Version management types and constants for agent CLI tools.
 */

import type { AgentType } from '../types.js';

// Re-export CliVersionType from configManager for convenience
// (it's the canonical definition there since it's part of AgentConfig)
export type { CliVersionType } from '../../config/configManager.js';

/**
 * Package names for each agent CLI.
 */
export const AGENT_CLI_PACKAGES: Record<AgentType, string> = {
    claude: '@anthropic-ai/claude-code',
    codex: '@openai/codex',
    gemini: '@google/gemini-cli',
    opencode: 'opencode-ai',
    vibe: 'mistral-vibe'
} as const;

/**
 * Available package tags for each agent type.
 * These are the common tags that can be selected in the UI.
 */
export const AGENT_CLI_TAGS: Record<AgentType, string[]> = {
    claude: ['stable', 'latest', 'next'],
    codex: ['latest', 'alpha'],
    gemini: ['latest', 'preview'],
    opencode: ['latest', 'beta', 'dev'],
    vibe: ['latest']
};

/**
 * Default CLI versions for each agent type.
 * These are used when cliVersionType is 'default'.
 */
export const AGENT_DEFAULT_VERSIONS: Record<AgentType, string> = {
    claude: '2.1.165',
    codex: '0.137.0',
    gemini: '0.45.1',
    opencode: '1.15.12',
    vibe: '2.12.1'
};

/**
 * Docker repositories used for versioned agent images.
 */
export const AGENT_IMAGE_NAMES: Record<AgentType, string> = {
    claude: 'propr/agent-claude',
    codex: 'propr/agent-codex',
    gemini: 'propr/agent-gemini',
    opencode: 'propr/agent-opencode',
    vibe: 'propr/agent-vibe'
};

/**
 * Files that contribute to the Docker image content hash.
 * When any of these files change, a new image should be built.
 */
export const DOCKER_CONTENT_FILES: Record<AgentType, string[]> = {
    claude: [
        'Dockerfile.claude',
        'scripts/claude-entrypoint.sh',
        'scripts/init-firewall.sh',
        'scripts/gh-wrapper.sh'
    ],
    codex: [
        'Dockerfile.codex',
        'scripts/codex-entrypoint.sh',
        'scripts/init-firewall.sh',
        'scripts/gh-wrapper.sh'
    ],
    gemini: [
        'Dockerfile.gemini',
        'scripts/gemini-entrypoint.sh',
        'scripts/init-firewall.sh',
        'scripts/gh-wrapper.sh'
    ],
    opencode: [
        'Dockerfile.opencode',
        'scripts/opencode-entrypoint.sh',
        'scripts/opencode-run.sh',
        'scripts/init-firewall.sh',
        'scripts/gh-wrapper.sh'
    ],
    vibe: [
        'Dockerfile.vibe',
        'scripts/vibe-entrypoint.sh',
        'scripts/init-firewall.sh',
        'scripts/gh-wrapper.sh'
    ]
};

/**
 * NPM package info response from registry.
 */
export interface NpmPackageInfo {
    name: string;
    'dist-tags': Record<string, string>;
    versions: Record<string, NpmVersionInfo>;
    time: Record<string, string>;
}

/**
 * NPM version info from registry.
 */
export interface NpmVersionInfo {
    version: string;
    name: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
}

/**
 * Available versions response for the API.
 */
export interface AvailableVersionsResponse {
    agentType: AgentType;
    packageName: string;
    defaultVersion: string;
    availableTags: Array<{ tag: string; version: string }>;
    recentVersions: Array<{ version: string; publishedAt: string }>;
}

/**
 * Result from building a versioned Docker image.
 */
export interface VersionedImageBuildResult {
    success: boolean;
    imageTag: string;
    error?: string;
}
