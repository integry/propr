import path from 'path';
import { MODEL_INFO_MAP } from '@propr/shared';
import logger from '../utils/logger.js';
import { getConfig, saveConfig } from './configStore.js';
import { AGENT_DEFAULT_VERSIONS } from '../agents/version/types.js';
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
    type: 'claude' | 'codex' | 'gemini';
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
    gemini: '~/.gemini'
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
    claude: '2.1.85',
    codex: AGENT_DEFAULT_VERSIONS.codex,
    gemini: '0.35.1'
};

const CLAUDE_46_MODELS = ['claude-opus-4-6', 'claude-sonnet-4-6'];
const CODEX_55_MODELS = ['gpt-5.5'];

function migrateCodexAgent(agent: AgentConfig): boolean {
    let migrated = false;

    if (agent.supportedModels) {
        const missingModels = CODEX_55_MODELS.filter(m => !agent.supportedModels!.includes(m));
        if (missingModels.length > 0) {
            agent.supportedModels = [...missingModels, ...agent.supportedModels];
            migrated = true;
            logger.info({ agentAlias: agent.alias, addedModels: missingModels }, 'Added GPT-5.5 models to Codex agent');
        }
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

/**
 * Migrates agent configurations to include CLI version fields and new models.
 */
export async function migrateAgentConfigs(): Promise<boolean> {
    try {
        const agents = await loadAgents();
        let migrated = false;

        for (const agent of agents) {
            if (!agent.cliVersionType) {
                agent.cliVersionType = 'default';
                agent.cliVersionResolved = DEFAULT_CLI_VERSIONS[agent.type];
                migrated = true;
                logger.info({ agentAlias: agent.alias, type: agent.type }, 'Migrated agent to default CLI version');
            }

            if (agent.type === 'claude' && agent.supportedModels) {
                const missingModels = CLAUDE_46_MODELS.filter(m => !agent.supportedModels.includes(m));
                if (missingModels.length > 0) {
                    agent.supportedModels = [...missingModels, ...agent.supportedModels];
                    migrated = true;
                    logger.info({ agentAlias: agent.alias, addedModels: missingModels }, 'Added Claude 4.6 models to agent');
                }
            }

            if (agent.type === 'codex') {
                if (migrateCodexAgent(agent)) migrated = true;
            }

            if (agent.supportedModels) {
                const validModels = agent.supportedModels.filter(m => MODEL_INFO_MAP[m]);
                const removedModels = agent.supportedModels.filter(m => !MODEL_INFO_MAP[m]);
                if (removedModels.length > 0) {
                    agent.supportedModels = validModels;
                    migrated = true;
                    logger.info({ agentAlias: agent.alias, removedModels }, 'Removed deprecated models from agent');
                }
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
