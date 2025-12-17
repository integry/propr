import path from 'path';
import { db } from '../db/connection.js';
import logger from '../utils/logger.js';

// --- Interfaces ---

interface RepoToMonitor {
    name: string;
    enabled: boolean;
}

interface ConfigSettings {
    worker_concurrency?: number;
    analysis_model_fast?: string;
    [key: string]: unknown;
}

/**
 * Configuration for a specific agent instance.
 * Stored in system_configs table under 'agents' key.
 */
export interface AgentConfig {
    id: string;             // UUID v4
    type: 'claude' | 'codex' | 'gemini';
    alias: string;          // Human-readable ID (e.g., 'claude-prod', 'codex-beta')
    enabled: boolean;

    // Docker configuration
    dockerImage: string;    // e.g., 'claude-code-processor:latest'
    configPath: string;     // Host path to mount (e.g., '/root/.claude')

    // Model configuration
    supportedModels: string[]; // List of models this agent supports
    defaultModel?: string;     // Default model if none specified

    // Environment variables to inject into container
    envVars?: Record<string, string>;
}

/**
 * Default config paths for different agent types.
 * These are the standard host paths where agent configs are typically stored.
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
 * Helper to get a config value from DB with a fallback
 */
async function getConfig<T>(key: string, defaultValue: T): Promise<T> {
    try {
        const result = await db('system_configs').where({ key }).first();
        if (result && result.value !== undefined && result.value !== null) {
            // value is stored as JSON type in DB, knex handles parsing usually
            // but depending on driver, might need explicit parse if returned as string
            return typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
        }
        return defaultValue;
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message, key }, 'Failed to load config from DB');
        return defaultValue;
    }
}

/**
 * Helper to save a config value to DB
 */
async function saveConfig<T>(key: string, value: T): Promise<boolean> {
    try {
        const jsonValue = JSON.stringify(value);
        await db('system_configs')
            .insert({
                key,
                value: jsonValue,
                updated_at: db.fn.now(),
                created_at: db.fn.now()
            })
            .onConflict('key')
            .merge({
                value: jsonValue,
                updated_at: db.fn.now()
            });
        return true;
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message, key }, 'Failed to save config to DB');
        throw error;
    }
}

// --- Exported Functions ---

/**
 * @deprecated No longer needed with DB-based configuration.
 * Kept for backward compatibility - this is now a no-op.
 */
export async function cloneOrPullConfigRepo(): Promise<void> {
    // No-op for DB version
    return;
}

/**
 * Ensures the configuration system is ready.
 * With DB-based configuration, the database connection handles this.
 */
export async function ensureConfigRepoExists(): Promise<boolean> {
    // No-op for DB version, connection check is handled in db/connection
    return true;
}

export async function loadFollowupKeywords(): Promise<string[]> {
    const keywords = await getConfig<string[]>('followup_keywords', []);
    logger.info({ followup_keywords: keywords }, 'Successfully loaded followup keywords');
    return keywords;
}

export async function saveFollowupKeywords(keywords: string[], _commitMessage?: string): Promise<boolean> {
    await saveConfig('followup_keywords', keywords);
    logger.info({ keywords }, 'Successfully saved followup keywords');
    return true;
}

export async function loadMonitoredRepos(): Promise<string[]> {
    const rawRepos = await getConfig<RepoToMonitor[]>('repos_to_monitor', []);
    const repos = rawRepos.filter(r => r.enabled).map(r => r.name);
    logger.info({ repos_to_monitor: repos, total_configured: rawRepos.length }, 'Successfully loaded enabled monitored repositories');
    return repos;
}

/**
 * Loads all monitored repos including disabled ones.
 * Returns the raw repo objects with enabled flags.
 */
export async function loadMonitoredReposRaw(): Promise<RepoToMonitor[]> {
    const rawRepos = await getConfig<RepoToMonitor[]>('repos_to_monitor', []);
    logger.info({ total_repos: rawRepos.length }, 'Successfully loaded all monitored repositories');
    return rawRepos;
}

export async function saveMonitoredRepos(repos: RepoToMonitor[], _commitMessage?: string): Promise<boolean> {
    await saveConfig('repos_to_monitor', repos);
    logger.info({ repos }, 'Successfully saved monitored repositories');
    return true;
}

export async function loadSettings(): Promise<ConfigSettings> {
    const settings = await getConfig<ConfigSettings>('settings', {});
    logger.info({ settings }, 'Successfully loaded settings');
    return settings;
}

export async function saveSettings(settings: ConfigSettings, _commitMessage?: string): Promise<boolean> {
    // Merge with existing settings to avoid overwriting unrelated keys
    const existing = await getConfig<ConfigSettings>('settings', {});
    const merged = { ...existing, ...settings };

    await saveConfig('settings', merged);
    logger.info({ settings: merged }, 'Successfully saved settings');
    return true;
}

export async function loadPrLabel(): Promise<string> {
    const defaultLabel = process.env.PR_LABEL || 'gitfix';
    const label = await getConfig<string>('pr_label', defaultLabel);
    logger.info({ pr_label: label }, 'Successfully loaded PR label');
    return label;
}

export async function savePrLabel(prLabel: string, _commitMessage?: string): Promise<boolean> {
    await saveConfig('pr_label', prLabel);
    logger.info({ pr_label: prLabel }, 'Successfully saved PR label');
    return true;
}

export async function loadAiPrimaryTag(): Promise<string> {
    const defaultTag = process.env.AI_PRIMARY_TAG || 'AI';
    const tag = await getConfig<string>('ai_primary_tag', defaultTag);
    logger.info({ ai_primary_tag: tag }, 'Successfully loaded AI primary tag');
    return tag;
}

export async function saveAiPrimaryTag(aiPrimaryTag: string, _commitMessage?: string): Promise<boolean> {
    await saveConfig('ai_primary_tag', aiPrimaryTag);
    logger.info({ ai_primary_tag: aiPrimaryTag }, 'Successfully saved AI primary tag');
    return true;
}

export async function loadPrimaryProcessingLabels(): Promise<string[]> {
    const defaultLabels = process.env.PRIMARY_PROCESSING_LABELS
        ? process.env.PRIMARY_PROCESSING_LABELS.split(',').map(l => l.trim()).filter(l => l)
        : ['AI'];

    const labels = await getConfig<string[]>('primary_processing_labels', defaultLabels);
    logger.info({ primary_processing_labels: labels }, 'Successfully loaded primary processing labels');
    return labels;
}

export async function savePrimaryProcessingLabels(primaryLabels: string[] | string, _commitMessage?: string): Promise<boolean> {
    const labels = Array.isArray(primaryLabels) ? primaryLabels : primaryLabels.split(',').map(l => l.trim()).filter(l => l);
    await saveConfig('primary_processing_labels', labels);
    logger.info({ primary_processing_labels: labels }, 'Successfully saved primary processing labels');
    return true;
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
export async function saveAgents(agents: AgentConfig[], _commitMessage?: string): Promise<boolean> {
    await saveConfig('agents', agents);
    logger.info({ agentCount: agents.length }, 'Successfully saved agents configuration');
    return true;
}
