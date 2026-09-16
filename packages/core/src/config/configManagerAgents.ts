/* eslint-disable max-lines -- host credential mapping for each agent runtime */
import fs from 'node:fs';
import path from 'node:path';
import {
    AGENT_DEFAULTS,
    MODEL_INFO_MAP,
    OPENCODE_MODELS,
    getManagedAgentConfigRelativePath,
    type AgentType,
    type ReasoningLevel
} from '@propr/shared';
import logger from '../utils/logger.js';
import { getConfig, saveConfig } from './configStore.js';
import { AGENT_DEFAULT_VERSIONS } from '../agents/version/types.js';
import { computeContentHash, generateAgentBundleImageTag, getAgentCliVersionMatrix } from '../agents/version/versionService.js';
import { toProprOpenCodeModelId } from '../agents/impl/openCodeModelIds.js';

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
    vibe: '~/.vibe',
    muse: '~/.config/muse'
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
// eslint-disable-next-line complexity
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
    if (configPath === DEFAULT_CONFIG_PATHS.muse) {
        const mapping = environment.MUSE_CONFIG_PATH?.trim()
            ? { source: 'MUSE_CONFIG_PATH', value: environment.MUSE_CONFIG_PATH }
            : environment.HOST_MUSE_DIR?.trim()
                ? { source: 'HOST_MUSE_DIR', value: environment.HOST_MUSE_DIR }
                : undefined;
        if (mapping) return validateCodexCredentialMapping(mapping.value, mapping.source);
        if (isContainerizedEnvironment(environment)) {
            throw new AgentConfigPathUnavailableError(
                'The existing ~/.config/muse credential path has no host mapping in this container; configure HOST_MUSE_DIR and restart ProPR'
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

const DEFAULT_CLI_VERSIONS: Record<AgentConfig['type'], string> = {
    claude: AGENT_DEFAULT_VERSIONS.claude,
    codex: AGENT_DEFAULT_VERSIONS.codex,
    antigravity: AGENT_DEFAULT_VERSIONS.antigravity,
    opencode: AGENT_DEFAULT_VERSIONS.opencode,
    vibe: AGENT_DEFAULT_VERSIONS.vibe,
    muse: AGENT_DEFAULT_VERSIONS.muse
};

const CURRENT_DEFAULT_MODELS: Partial<Record<AgentConfig['type'], string[]>> = {
    claude: AGENT_DEFAULTS.claude.defaultModels,
    codex: AGENT_DEFAULTS.codex.defaultModels,
    antigravity: AGENT_DEFAULTS.antigravity.defaultModels,
    opencode: AGENT_DEFAULTS.opencode.defaultModels,
    vibe: AGENT_DEFAULTS.vibe.defaultModels,
    muse: AGENT_DEFAULTS.muse.defaultModels
};
const OPENCODE_CURRENT_MODELS = OPENCODE_MODELS.map(model => model.id);
const RETIRED_OPENCODE_DEFAULT_MODELS = new Set([
    'opencode-minimax-m3-free',
    'opencode-deepseek-v4-flash-free',
    'opencode-laguna-s-2.1-free',
    'opencode-ling-3.0-flash-free',
    'opencode-north-mini-code-free'
]);
const MANAGED_AGENT_IMAGE_PREFIX = 'propr/agent:';

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

    if (!agent.dockerImage || (agent.dockerImage !== defaults.dockerImage && !agent.dockerImage.startsWith(MANAGED_AGENT_IMAGE_PREFIX))) {
        agent.dockerImage = defaults.dockerImage;
        migrated = true;
        logger.info({ agentAlias: agent.alias, dockerImage: agent.dockerImage }, 'Normalized agent Docker image');
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

    if (!agent.defaultModel || agent.defaultModel === 'gpt-5.6-sol' || agent.defaultModel === 'gpt-5.5' || agent.defaultModel === 'gpt-5.4') {
        agent.defaultModel = AGENT_DEFAULTS.codex.defaultModels[0];
        migrated = true;
        logger.info({ agentAlias: agent.alias, defaultModel: agent.defaultModel }, 'Updated Codex default model');
    }

    return migrated;
}

function updateDefaultCliVersion(agent: AgentConfig): boolean {
    if (agent.cliVersionType !== 'default') return false;
    const defaultVersion = AGENT_DEFAULT_VERSIONS[agent.type];
    let migrated = false;
    if (agent.cliVersionResolved !== defaultVersion) {
        agent.cliVersionResolved = defaultVersion;
        migrated = true;
    }
    if (agent.cliVersion !== undefined) {
        delete agent.cliVersion;
        migrated = true;
    }
    if (migrated) {
        logger.info({ agentAlias: agent.alias, type: agent.type, cliVersion: defaultVersion }, 'Updated default agent CLI version');
    }
    return migrated;
}

function updateAntigravityDefaults(agent: AgentConfig): boolean {
    let migrated = false;

    if (agent.type !== 'antigravity') {
        return false;
    }

    if (!agent.configPath || agent.configPath === '~/.antigravity' || agent.configPath.endsWith('/.antigravity')) {
        agent.configPath = '~/.gemini';
        migrated = true;
    }

    if (agent.cliVersionType === 'default' && agent.cliVersion !== undefined) {
        delete agent.cliVersion;
        migrated = true;
    } else if (agent.cliVersionType && agent.cliVersionType !== 'default' && agent.cliVersion !== 'latest') {
        agent.cliVersion = 'latest';
        migrated = true;
    }

    if (agent.cliVersionResolved !== AGENT_DEFAULT_VERSIONS.antigravity) {
        agent.cliVersionResolved = AGENT_DEFAULT_VERSIONS.antigravity;
        migrated = true;
    }

    if (migrated) {
        logger.info({ agentAlias: agent.alias, cliVersion: agent.cliVersionResolved }, 'Updated Antigravity CLI version to latest');
    }

    return migrated;
}

function normalizeOpenCodeModelIds(agent: AgentConfig): boolean {
    if (agent.type !== 'opencode' || !agent.supportedModels) {
        return false;
    }

    const normalizedModels = [...new Set(agent.supportedModels.map(toProprOpenCodeModelId))];
    const normalizedDefaultModel = agent.defaultModel ? toProprOpenCodeModelId(agent.defaultModel) : agent.defaultModel;
    const migrated = normalizedModels.length !== agent.supportedModels.length ||
        normalizedModels.some((model, index) => model !== agent.supportedModels[index]) ||
        normalizedDefaultModel !== agent.defaultModel;

    if (!migrated) {
        return false;
    }

    agent.supportedModels = normalizedModels;
    agent.defaultModel = normalizedDefaultModel;
    logger.info({ agentAlias: agent.alias, supportedModels: agent.supportedModels, defaultModel: agent.defaultModel }, 'Normalized OpenCode model IDs');
    return true;
}

function updateOpenCodeDefaultModels(agent: AgentConfig): boolean {
    if (agent.type !== 'opencode' || !agent.supportedModels) {
        return false;
    }

    const retiredModels = agent.supportedModels.filter(model => RETIRED_OPENCODE_DEFAULT_MODELS.has(model));
    const retainedModels = agent.supportedModels.filter(model => !RETIRED_OPENCODE_DEFAULT_MODELS.has(model));
    const missingModels = OPENCODE_CURRENT_MODELS.filter(model => !retainedModels.includes(model));
    const nextModels = [...missingModels, ...retainedModels];
    let migrated = retiredModels.length > 0 || missingModels.length > 0;

    if (migrated) {
        agent.supportedModels = nextModels;
    }

    if (!agent.defaultModel || RETIRED_OPENCODE_DEFAULT_MODELS.has(agent.defaultModel)) {
        agent.defaultModel = nextModels[0];
        migrated = true;
    }

    if (migrated) {
        logger.info(
            { agentAlias: agent.alias, addedModels: missingModels, removedModels: retiredModels, defaultModel: agent.defaultModel },
            'Updated built-in OpenCode models'
        );
    }

    return migrated;
}

function removeDeprecatedModels(agent: AgentConfig): boolean {
    if (!agent.supportedModels) {
        return false;
    }

    if (agent.type === 'opencode') {
        return false;
    }

    const validModels = agent.supportedModels.filter(m => MODEL_INFO_MAP[m]);
    const removedModels = agent.supportedModels.filter(m => !MODEL_INFO_MAP[m]);
    if (removedModels.length === 0) {
        return false;
    }

    agent.supportedModels = validModels;
    if (!agent.defaultModel || !validModels.includes(agent.defaultModel)) {
        agent.defaultModel = validModels[0];
    }
    logger.info({ agentAlias: agent.alias, removedModels, defaultModel: agent.defaultModel }, 'Removed deprecated models from agent');
    return true;
}

/**
 * Migrates agent configurations to include CLI version fields and new models.
 */
export function migrateAgentConfig(agent: AgentConfig): boolean {
    let migrated = false;
    migrated = migrateCliVersion(agent) || migrated;
    migrated = applyDefaultAgentFields(agent) || migrated;
    const currentDefaultModels = CURRENT_DEFAULT_MODELS[agent.type];
    if (agent.type !== 'opencode' && currentDefaultModels) {
        migrated = addMissingModels(agent, currentDefaultModels, 'Added current default models to agent') || migrated;
    }

    migrated = updateCodexDefaults(agent) || migrated;
    migrated = updateDefaultCliVersion(agent) || migrated;
    migrated = updateAntigravityDefaults(agent) || migrated;
    migrated = normalizeOpenCodeModelIds(agent) || migrated;
    migrated = updateOpenCodeDefaultModels(agent) || migrated;
    migrated = removeDeprecatedModels(agent) || migrated;
    return migrated;
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
