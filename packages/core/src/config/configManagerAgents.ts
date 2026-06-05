import path from 'path';
import { AGENT_DEFAULTS, MODEL_INFO_MAP, VIBE_MODELS, type AgentType } from '@propr/shared';
import logger from '../utils/logger.js';
import { getConfig, saveConfig } from './configStore.js';
import { AGENT_DEFAULT_VERSIONS, AGENT_IMAGE_NAMES } from '../agents/version/types.js';
import { computeContentHash, generateImageTag } from '../agents/version/versionService.js';

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
    antigravity: '~/.antigravity',
    vibe: '~/.vibe'
};

/**
 * Resolves a config path, expanding ~ to the home directory.
 */
export function resolveConfigPath(configPath: string): string {
    if (configPath.startsWith('~')) {
        const homeDir = process.env.HOME || process.env.USERPROFILE || '/root';
        return path.join(homeDir, configPath.slice(1));
    }
    return configPath;
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
 * Saves agent configurations to the database.
 */
export async function saveAgents(agents: AgentConfig[]): Promise<boolean> {
    await saveConfig('agents', agents);
    logger.info({ agentCount: agents.length }, 'Successfully saved agents configuration');
    return true;
}

const DEFAULT_CLI_VERSIONS: Record<AgentConfig['type'], string> = {
    claude: AGENT_DEFAULT_VERSIONS.claude,
    codex: AGENT_DEFAULT_VERSIONS.codex,
    antigravity: AGENT_DEFAULT_VERSIONS.antigravity,
    vibe: AGENT_DEFAULT_VERSIONS.vibe
};

const CURRENT_DEFAULT_MODELS: Record<AgentConfig['type'], string[]> = {
    claude: AGENT_DEFAULTS.claude.defaultModels,
    codex: AGENT_DEFAULTS.codex.defaultModels,
    antigravity: AGENT_DEFAULTS.antigravity.defaultModels,
    vibe: AGENT_DEFAULTS.vibe.defaultModels
};
const VIBE_CURRENT_MODELS = VIBE_MODELS.map(model => model.id);
const LEGACY_AGENT_IMAGE_NAMES: Record<AgentConfig['type'], string[]> = {
    claude: ['propr-claude'],
    codex: ['propr-codex'],
    antigravity: ['propr-antigravity'],
    vibe: ['propr-vibe']
};

function migrateCliVersion(agent: AgentConfig): boolean {
    if (agent.cliVersionType) {
        return false;
    }

    agent.cliVersionType = 'default';
    agent.cliVersionResolved = DEFAULT_CLI_VERSIONS[agent.type];
    logger.info({ agentAlias: agent.alias, type: agent.type }, 'Migrated agent to default CLI version');
    return true;
}

function applyDefaultAgentFields(agent: AgentConfig): boolean {
    const defaults = AGENT_DEFAULTS[agent.type];
    let migrated = false;

    if (!defaults) {
        return false;
    }

    if (!agent.configPath) {
        agent.configPath = defaults.configPath;
        migrated = true;
        logger.info({ agentAlias: agent.alias, configPath: agent.configPath }, 'Added missing agent config path');
    }

    if (!agent.dockerImage) {
        agent.dockerImage = defaults.dockerImage;
        migrated = true;
        logger.info({ agentAlias: agent.alias, dockerImage: agent.dockerImage }, 'Added missing agent Docker image');
    }

    if (!agent.supportedModels || agent.supportedModels.length === 0) {
        agent.supportedModels = [...defaults.defaultModels];
        migrated = true;
        logger.info({ agentAlias: agent.alias, supportedModels: agent.supportedModels }, 'Added default agent models');
    }

    if (!agent.defaultModel && agent.supportedModels.length > 0) {
        agent.defaultModel = agent.supportedModels[0];
        migrated = true;
        logger.info({ agentAlias: agent.alias, defaultModel: agent.defaultModel }, 'Added default agent model');
    }

    return migrated;
}

function migrateLegacyAgentImageName(agent: AgentConfig): boolean {
    const legacyNames = LEGACY_AGENT_IMAGE_NAMES[agent.type];
    const currentName = AGENT_IMAGE_NAMES[agent.type];

    for (const legacyName of legacyNames) {
        if (agent.dockerImage?.startsWith(`${legacyName}:`)) {
            agent.dockerImage = `${currentName}:${agent.dockerImage.slice(legacyName.length + 1)}`;
            logger.info({ agentAlias: agent.alias, dockerImage: agent.dockerImage }, 'Migrated agent Docker image to registry namespace');
            return true;
        }
    }

    return false;
}

function addMissingModels(agent: AgentConfig, models: string[], logMessage: string): boolean {
    if (!agent.supportedModels) {
        return false;
    }

    const missingModels = models.filter(m => !agent.supportedModels.includes(m));
    if (missingModels.length === 0) {
        return false;
    }

    agent.supportedModels = [...missingModels, ...agent.supportedModels];
    logger.info({ agentAlias: agent.alias, addedModels: missingModels }, logMessage);
    return true;
}

function updateCodexDefaults(agent: AgentConfig): boolean {
    let migrated = false;

    if (agent.type !== 'codex') {
        return false;
    }

    if (!agent.defaultModel || agent.defaultModel === 'gpt-5.4') {
        agent.defaultModel = 'gpt-5.5';
        migrated = true;
        logger.info({ agentAlias: agent.alias, defaultModel: agent.defaultModel }, 'Updated Codex default model');
    }

    if (agent.cliVersionType === 'default' && agent.cliVersionResolved !== AGENT_DEFAULT_VERSIONS.codex) {
        agent.cliVersionResolved = AGENT_DEFAULT_VERSIONS.codex;
        agent.dockerImage = generateImageTag('codex', agent.cliVersionResolved, computeContentHash('codex'));
        migrated = true;
        logger.info({ agentAlias: agent.alias, cliVersion: agent.cliVersionResolved, dockerImage: agent.dockerImage }, 'Updated Codex default CLI version and Docker image');
    }

    return migrated;
}

function removeDeprecatedModels(agent: AgentConfig): boolean {
    if (!agent.supportedModels) {
        return false;
    }

    const validModels = agent.supportedModels.filter(m => MODEL_INFO_MAP[m]);
    const removedModels = agent.supportedModels.filter(m => !MODEL_INFO_MAP[m]);
    if (removedModels.length === 0) {
        return false;
    }

    agent.supportedModels = validModels;
    logger.info({ agentAlias: agent.alias, removedModels }, 'Removed deprecated models from agent');
    return true;
}

/**
 * Migrates agent configurations to include CLI version fields and new models.
 */
export async function migrateAgentConfigs(): Promise<boolean> {
    try {
        const agents = await getConfig<AgentConfig[]>('agents', []);
        let migrated = false;

        for (const agent of agents) {
            migrated = migrateCliVersion(agent) || migrated;
            migrated = applyDefaultAgentFields(agent) || migrated;
            migrated = migrateLegacyAgentImageName(agent) || migrated;
            migrated = addMissingModels(agent, CURRENT_DEFAULT_MODELS[agent.type], 'Added current default models to agent') || migrated;
            if (agent.type === 'vibe') {
                migrated = addMissingModels(agent, VIBE_CURRENT_MODELS, 'Added current Mistral Vibe models to agent') || migrated;
            }
            migrated = updateCodexDefaults(agent) || migrated;
            migrated = removeDeprecatedModels(agent) || migrated;
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
