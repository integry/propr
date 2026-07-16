/**
 * Version management types and constants for agent CLI tools.
 */

import { AGENT_IMAGE_NAME } from '../constants.js';
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
    antigravity: 'https://antigravity.google/cli/install.sh',
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
    antigravity: ['latest'],
    opencode: ['latest', 'beta', 'dev'],
    vibe: ['latest']
};

/**
 * Default CLI versions for each agent type.
 * These are used when cliVersionType is 'default'.
 */
export const AGENT_DEFAULT_VERSIONS: Record<AgentType, string> = {
    claude: '2.1.211',
    codex: '0.144.5',
    antigravity: 'latest',
    opencode: '1.18.2',
    vibe: '2.20.0'
};

/** The single repository used for every managed agent execution. */
export { AGENT_IMAGE_NAME };

/**
 * Files that contribute to the Docker image content hash.
 * When any of these files change, a new image should be built.
 */
export const AGENT_BUNDLE_CONTENT_FILES = [
    'Dockerfile.agent',
    'scripts/agent-entrypoint.sh',
    'scripts/claude-entrypoint.sh',
    'scripts/codex-entrypoint.sh',
    'scripts/antigravity-entrypoint.sh',
    'scripts/opencode-entrypoint.sh',
    'scripts/opencode-run.sh',
    'scripts/vibe-entrypoint.sh',
    'scripts/vibe-prompt-file-runner.py',
    'scripts/init-firewall.sh',
    'scripts/gh-wrapper.sh',
    'NOTICE',
    'THIRD_PARTY_LICENSES.md'
] as const;

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
