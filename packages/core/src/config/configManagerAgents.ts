import fs from 'node:fs';
import path from 'node:path';
import {
    getManagedAgentConfigRelativePath,
    type AgentType,
    type ReasoningLevel
} from '@propr/shared';
import logger from '../utils/logger.js';
import { getConfig, saveConfig } from './configStore.js';
import { computeContentHash, generateAgentBundleImageTag, getAgentCliVersionMatrix } from '../agents/version/versionService.js';
import { migrateAgentConfig } from './configManagerAgentMigrations.js';

export { migrateAgentConfig } from './configManagerAgentMigrations.js';

/**
 * CLI version type - how the version is specified.
 */
export type CliVersionType = 'default' | 'tag' | 'specific' | 'custom';

/**
 * Configuration for a specific agent instance.
 * Stored in system_configs table under 'agents' key.
 */
export interface AgentConfig {
    id: string;
    type: AgentType;
    alias: string;
    enabled: boolean;
    dockerImage: string;
    configPath: string;
    supportedModels: string[];
    defaultModel?: string;
    envVars?: Record<string, string>;
    modelCustomLabels?: Record<string, string>;
    /** Per-model reasoning levels. Values override the system setting for this agent/model. */
    modelReasoningLevels?: Record<string, ReasoningLevel>;
    cliVersionType?: CliVersionType;
    cliVersion?: string;
    cliVersionResolved?: string;
}

/**
 * Default config paths for different agent types.
 */
export const DEFAULT_CONFIG_PATHS: Record<AgentConfig['type'], string> = {
    claude: '~/.claude',
    codex: '~/.codex',
    antigravity: '~/.gemini',
    opencode: '~/.config/opencode',
    vibe: '~/.vibe'
};

export class AgentConfigPathUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AgentConfigPathUnavailableError';
    }
}

type ConfigPathEnvironment = Record<string, string | undefined>;

function isContainerizedEnvironment(environment: ConfigPathEnvironment): boolean {
    return environment.PROPR_CONTAINERIZED === '1'
        || environment.PROPR_CONTAINERIZED === 'true'
        || (environment === process.env && fs.existsSync('/.dockerenv'));
}

function validateCodexCredentialMapping(value: string, source: string): string {
    const normalized = path.normalize(value.trim());
    if (!normalized || !path.isAbsolute(normalized) || normalized.includes(':') || /[\0\r\n]/.test(normalized)) {
        throw new AgentConfigPathUnavailableError(
            `${source} must name an absolute Linux directory mounted into this container`
        );
    }
    if (normalized === path.parse(normalized).root) {
        throw new AgentConfigPathUnavailableError(`${source} cannot be the filesystem root`);
    }
    return normalized;
}

/**
 * Resolves a config path, expanding ~ to the home directory.
 */
export function resolveConfigPath(
    configPath: string,
    environment: ConfigPathEnvironment = process.env
): string {
    const managedRelativePath = getManagedAgentConfigRelativePath(configPath);
    if (managedRelativePath) {
        const homeDir = environment.HOME || environment.USERPROFILE || '/root';
        const managedRoot = environment.PROPR_MANAGED_CREDENTIALS_DIR
            || path.join(homeDir, '.propr', 'agent-credentials');
        return path.join(managedRoot, managedRelativePath);
    }
    if (configPath === DEFAULT_CONFIG_PATHS.codex) {
        const mapping = environment.CODEX_CONFIG_PATH?.trim()
            ? { source: 'CODEX_CONFIG_PATH', value: environment.CODEX_CONFIG_PATH }
            : environment.HOST_CODEX_DIR?.trim()
                ? { source: 'HOST_CODEX_DIR', value: environment.HOST_CODEX_DIR }
                : undefined;
        if (mapping) return validateCodexCredentialMapping(mapping.value, mapping.source);
        if (isContainerizedEnvironment(environment)) {
            throw new AgentConfigPathUnavailableError(
                'The existing ~/.codex credential path has no host mapping in this container; ' +
                'configure HOST_CODEX_DIR and restart ProPR, or use a ProPR-managed Codex login'
            );
        }
    }
    if (configPath.startsWith('~')) {
        const homeDir = environment.HOME || environment.USERPROFILE || '/root';
        return path.join(homeDir, configPath.slice(1));
    }
    return configPath;
}

/**
 * Resolve Codex's saved config path to the bind source visible to the backend.
 *
 * The portable default represents "this installation's existing host account",
 * so a containerized backend must use the launcher-provided host mapping instead
 * of expanding it against the backend user's HOME. Explicit custom and managed
 * paths retain their existing per-agent meaning and are never replaced by the
 * provider-wide mapping.
 */
export function resolveCodexConfigPath(
    configPath: string,
    environment: ConfigPathEnvironment = process.env
): string {
    const configured = configPath || DEFAULT_CONFIG_PATHS.codex;
    const managed = getManagedAgentConfigRelativePath(configured);
    if (!managed
        && configured !== DEFAULT_CONFIG_PATHS.codex
        && (configured === '~' || configured.startsWith('~/'))
        && isContainerizedEnvironment(environment)) {
        throw new AgentConfigPathUnavailableError(
            'Custom Codex credential paths must be absolute in a containerized ProPR installation; ' +
            'update this agent config path to the mounted host directory'
        );
    }
    return resolveConfigPath(configured, environment);
}

/**
 * Fail before Docker can create an empty bind source and start Codex without
 * the account the operator selected. This checks path metadata only; credential
 * files are never read or copied into diagnostics.
 */
export function assertCodexConfigPathAvailable(configPath: string): void {
    try {
        if (fs.statSync(configPath).isDirectory()) return;
    } catch {
        // Use the same bounded, actionable error for missing and inaccessible paths.
    }
    throw new AgentConfigPathUnavailableError(
        `The configured Codex credential directory is unavailable at ${configPath}; ` +
        'ensure HOST_CODEX_DIR points to an existing mounted directory and restart ProPR, ' +
        'or use a ProPR-managed Codex login'
    );
}

/**
 * Gets the default config path for a given agent type.
 */
export function getDefaultConfigPath(agentType: AgentConfig['type']): string {
    return resolveConfigPath(DEFAULT_CONFIG_PATHS[agentType]);
}

/**
 * Loads agent configurations from the database.
 * Returns an empty array if no agents are configured.
 */
export async function loadAgents(): Promise<AgentConfig[]> {
    const agents = await getConfig<AgentConfig[]>('agents', []);
    logger.info({ agentCount: agents.length }, 'Successfully loaded agents configuration');
    return agents;
}

/**
 * Computes the unified agent base image(s) the registry will actually run.
 *
 * Saved agent configs may carry a stale dockerImage (the registry recomputes
 * and rewrites the bundle tag on every refresh), so runtime package
 * validation and builds must target the freshly computed tag rather than the
 * persisted values.
 */
export async function loadEffectiveAgentBaseImages(): Promise<string[]> {
    const agents = await getConfig<AgentConfig[]>('agents', []);
    if (agents.length === 0 && process.env.AGENT_DOCKER_IMAGE) {
        // With no configured agents the registry registers the default agent
        // on AGENT_DOCKER_IMAGE when set.
        return [process.env.AGENT_DOCKER_IMAGE];
    }
    return [generateAgentBundleImageTag(getAgentCliVersionMatrix(agents), computeContentHash())];
}

/**
 * Saves agent configurations to the database.
 */
export async function saveAgents(agents: AgentConfig[]): Promise<boolean> {
    await saveConfig('agents', agents);
    logger.info({ agentCount: agents.length }, 'Successfully saved agents configuration');
    return true;
}

export async function migrateAgentConfigs(): Promise<boolean> {
    try {
        const agents = await getConfig<AgentConfig[]>('agents', []);
        let migrated = false;

        for (const agent of agents) {
            migrated = migrateAgentConfig(agent) || migrated;
        }

        const bundleImage = generateAgentBundleImageTag(getAgentCliVersionMatrix(agents), computeContentHash());
        for (const agent of agents) {
            if (agent.dockerImage !== bundleImage) {
                agent.dockerImage = bundleImage;
                migrated = true;
            }
        }

        if (migrated) {
            await saveAgents(agents);
            logger.info({ agentCount: agents.length }, 'Agent configuration migration completed');
        }

        return migrated;
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message }, 'Failed to migrate agent configurations');
        return false;
    }
}

/**
 * Settings for Agent Tank integration (LLM usage monitoring).
 */
export interface AgentTankSettings {
    enabled: boolean;
    url: string;
}

const DEFAULT_AGENT_TANK_SETTINGS: AgentTankSettings = {
    enabled: false,
    url: 'http://0.0.0.0:3456'
};

/**
 * Loads Agent Tank settings from the database.
 */
export async function loadAgentTankSettings(): Promise<AgentTankSettings> {
    const settings = await getConfig<AgentTankSettings>('agent_tank', DEFAULT_AGENT_TANK_SETTINGS);
    logger.info({ agentTank: settings }, 'Successfully loaded Agent Tank settings');
    return settings;
}

/**
 * Saves Agent Tank settings to the database.
 */
export async function saveAgentTankSettings(settings: AgentTankSettings): Promise<boolean> {
    await saveConfig('agent_tank', settings);
    logger.info({ agentTank: settings }, 'Successfully saved Agent Tank settings');
    return true;
}
