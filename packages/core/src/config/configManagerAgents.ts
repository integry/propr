import {
    agentTankModeFromLegacyEnabled,
    normalizeAgentTankMode,
    type AgentTankMode,
    type AgentType,
    type ReasoningLevel
} from '@propr/shared';
import logger from '../utils/logger.js';
import { getConfig, saveConfig } from './configStore.js';
import { computeContentHash, generateAgentBundleImageTag, getAgentCliVersionMatrix } from '../agents/version/versionService.js';
import { migrateAgentConfig } from './configManagerAgentMigrations.js';

export { migrateAgentConfig } from './configManagerAgentMigrations.js';
export {
    DEFAULT_CONFIG_PATHS, AgentConfigPathUnavailableError, resolveConfigPath, resolveCodexConfigPath, assertCodexConfigPathAvailable,
} from './agentConfigPaths.js';
import { DEFAULT_CONFIG_PATHS, resolveConfigPath } from './agentConfigPaths.js';

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
    /** Authoritative integration mode. */
    mode: AgentTankMode;
    /**
     * Derived convenience flag (`mode !== 'disabled'`).
     *
     * Kept so the existing `settings.enabled` call sites keep working without a
     * sweeping refactor. Treat it as read-only: `mode` is the source of truth,
     * and `saveAgentTankSettings` ignores whatever is passed here.
     */
    enabled: boolean;
    /** Only meaningful in `external` mode. */
    url: string;
}

export const DEFAULT_AGENT_TANK_URL = 'http://0.0.0.0:3456';

/**
 * Environment fallback for headless/automated deployments that configure the
 * stack entirely through `.env` and never open the Settings UI. Database
 * settings still win; this only fills in a missing record.
 */
function environmentModeFallback(): AgentTankMode | undefined {
    const raw = process.env.AGENT_TANK_MODE?.trim();
    if (!raw) return undefined;
    const normalized = normalizeAgentTankMode(raw);
    // normalizeAgentTankMode is total, so an unrecognized value silently becomes
    // 'disabled'. Log it instead of pretending the operator asked for that.
    if (normalized === 'disabled' && raw !== 'disabled') {
        logger.warn({ AGENT_TANK_MODE: raw }, 'Unrecognized AGENT_TANK_MODE; treating Agent Tank as disabled');
    }
    return normalized;
}

/**
 * Accepts both the current `{ mode, url }` shape and the legacy
 * `{ enabled, url }` shape written before bundled mode existed.
 */
export function normalizeAgentTankSettings(raw: unknown): AgentTankSettings {
    const record = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    const mode = 'mode' in record
        ? normalizeAgentTankMode(record.mode)
        // No `mode` key at all means this record predates the feature (or is
        // empty). Derive from the legacy boolean, then from the environment.
        : ('enabled' in record
            ? agentTankModeFromLegacyEnabled(record.enabled)
            : environmentModeFallback() ?? 'disabled');
    const url = typeof record.url === 'string' && record.url.trim()
        ? record.url.trim()
        : (process.env.AGENT_TANK_URL?.trim() || DEFAULT_AGENT_TANK_URL);
    return { mode, enabled: mode !== 'disabled', url };
}

/**
 * Loads Agent Tank settings from the database.
 */
export async function loadAgentTankSettings(): Promise<AgentTankSettings> {
    // Read as `unknown`: the persisted value may be the legacy shape, and the
    // normalizer is what guarantees callers only ever see the current one.
    const raw = await getConfig<unknown>('agent_tank', {});
    const settings = normalizeAgentTankSettings(raw);
    logger.info({ agentTank: { mode: settings.mode } }, 'Successfully loaded Agent Tank settings');
    return settings;
}

/**
 * Saves Agent Tank settings to the database.
 */
export async function saveAgentTankSettings(
    settings: Pick<AgentTankSettings, 'mode'> & Partial<AgentTankSettings>
): Promise<boolean> {
    // Persist the canonical shape only. `enabled` is intentionally written too,
    // so that a rollback to an older build still reads a sane boolean instead of
    // defaulting Agent Tank on/off arbitrarily.
    const mode = normalizeAgentTankMode(settings.mode);
    const persisted = { mode, enabled: mode !== 'disabled', url: settings.url || DEFAULT_AGENT_TANK_URL };
    await saveConfig('agent_tank', persisted);
    logger.info({ agentTank: { mode } }, 'Successfully saved Agent Tank settings');
    return true;
}
