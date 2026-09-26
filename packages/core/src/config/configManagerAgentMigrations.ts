/**
 * Forward migrations applied to saved agent configs on load.
 *
 * These grow with every CLI and model catalog update, so they live apart from
 * the agent config store itself.
 */
import {
    AGENT_DEFAULTS,
    MODEL_INFO_MAP,
    OPENCODE_MODELS
} from '@propr/shared';
import logger from '../utils/logger.js';
import { AGENT_DEFAULT_VERSIONS } from '../agents/version/types.js';
import { toProprOpenCodeModelId } from '../agents/impl/openCodeModelIds.js';
import type { AgentConfig } from './configManagerAgents.js';

const DEFAULT_CLI_VERSIONS: Record<AgentConfig['type'], string> = {
    claude: AGENT_DEFAULT_VERSIONS.claude,
    codex: AGENT_DEFAULT_VERSIONS.codex,
    antigravity: AGENT_DEFAULT_VERSIONS.antigravity,
    opencode: AGENT_DEFAULT_VERSIONS.opencode,
    vibe: AGENT_DEFAULT_VERSIONS.vibe
};

const CURRENT_DEFAULT_MODELS: Partial<Record<AgentConfig['type'], string[]>> = {
    claude: AGENT_DEFAULTS.claude.defaultModels,
    codex: AGENT_DEFAULTS.codex.defaultModels,
    antigravity: AGENT_DEFAULTS.antigravity.defaultModels,
    opencode: AGENT_DEFAULTS.opencode.defaultModels,
    vibe: AGENT_DEFAULTS.vibe.defaultModels
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

/**
 * Moves Claude agents still pinned to the previous canonical "opus" model onto
 * the current default Claude model. Deliberate picks in other tiers (Fable,
 * Sonnet, Haiku) are left untouched.
 */
function updateClaudeDefaults(agent: AgentConfig): boolean {
    if (agent.type !== 'claude') {
        return false;
    }

    if (agent.defaultModel && agent.defaultModel !== 'claude-opus-5') {
        return false;
    }

    const defaultModel = AGENT_DEFAULTS.claude.defaultModels[0];
    if (agent.defaultModel === defaultModel) {
        return false;
    }

    agent.defaultModel = defaultModel;
    logger.info({ agentAlias: agent.alias, defaultModel }, 'Updated Claude default model');
    return true;
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
    migrated = updateClaudeDefaults(agent) || migrated;
    migrated = updateDefaultCliVersion(agent) || migrated;
    migrated = updateAntigravityDefaults(agent) || migrated;
    migrated = normalizeOpenCodeModelIds(agent) || migrated;
    migrated = updateOpenCodeDefaultModels(agent) || migrated;
    migrated = removeDeprecatedModels(agent) || migrated;
    return migrated;
}
