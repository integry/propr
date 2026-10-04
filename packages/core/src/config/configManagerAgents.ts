import fs from 'node:fs';
import path from 'node:path';
import {
    agentTankModeFromLegacyEnabled,
    getManagedAgentConfigRelativePath,
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
