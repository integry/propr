import path from 'path';
import { db } from '../db/connection.js';
import logger from '../utils/logger.js';
import { getIndexingProgress } from '../services/relevance/indexingCancellation.js';

// --- Interfaces ---

export interface RepoToMonitor {
    id: string;              // UUID, required for uniqueness
    name: string;            // owner/repo
    enabled: boolean;
    alias?: string;          // Optional display name
    baseBranch?: string;     // Optional specific branch to monitor
}

interface ConfigSettings {
    worker_concurrency?: number;
    analysis_model_fast?: string;
    analysis_model_advanced?: string;
    planner_context_model?: string;
    planner_generation_model?: string;
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

    // Custom GitHub label for triggering this agent (e.g., 'custom-bot', 'my-helper')
    // If not set, the default 'llm-{alias}' pattern is used
    customLabel?: string;
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

export async function saveFollowupKeywords(keywords: string[]): Promise<boolean> {
    await saveConfig('followup_keywords', keywords);
    logger.info({ keywords }, 'Successfully saved followup keywords');
    return true;
}

export async function loadFollowupIgnoreKeywords(): Promise<string[]> {
    const keywords = await getConfig<string[]>('followup_ignore_keywords', []);
    logger.info({ followup_ignore_keywords: keywords }, 'Successfully loaded followup ignore keywords');
    return keywords;
}

export async function saveFollowupIgnoreKeywords(keywords: string[]): Promise<boolean> {
    await saveConfig('followup_ignore_keywords', keywords);
    logger.info({ keywords }, 'Successfully saved followup ignore keywords');
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

export async function saveMonitoredRepos(repos: RepoToMonitor[]): Promise<boolean> {
    await saveConfig('repos_to_monitor', repos);
    logger.info({ repos }, 'Successfully saved monitored repositories');
    return true;
}

export async function loadSettings(): Promise<ConfigSettings> {
    const settings = await getConfig<ConfigSettings>('settings', {});
    logger.info({ settings }, 'Successfully loaded settings');
    return settings;
}

export async function saveSettings(settings: ConfigSettings): Promise<boolean> {
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

export async function savePrLabel(prLabel: string): Promise<boolean> {
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

export async function saveAiPrimaryTag(aiPrimaryTag: string): Promise<boolean> {
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

export async function savePrimaryProcessingLabels(primaryLabels: string[] | string): Promise<boolean> {
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
export async function saveAgents(agents: AgentConfig[]): Promise<boolean> {
    await saveConfig('agents', agents);
    logger.info({ agentCount: agents.length }, 'Successfully saved agents configuration');
    return true;
}

// --- Summarization Settings ---

/**
 * Settings for codebase summarization/indexing feature.
 */
export interface SummarizationSettings {
    enabled: boolean;
    agent_alias: string;
    custom_prompt?: string;
}

const DEFAULT_SUMMARIZATION_SETTINGS: SummarizationSettings = {
    enabled: false,
    agent_alias: '',
    custom_prompt: ''
};

/**
 * Loads summarization settings from the database.
 */
export async function loadSummarizationSettings(): Promise<SummarizationSettings> {
    const settings = await getConfig<SummarizationSettings>('summarization', DEFAULT_SUMMARIZATION_SETTINGS);
    logger.info({ summarization: settings }, 'Successfully loaded summarization settings');
    return settings;
}

/**
 * Saves summarization settings to the database.
 */
export async function saveSummarizationSettings(settings: SummarizationSettings): Promise<boolean> {
    await saveConfig('summarization', settings);
    logger.info({ summarization: settings }, 'Successfully saved summarization settings');
    return true;
}

// --- Repository Indexing Status ---

/**
 * Repository indexing status from the repositories table.
 */
export interface RepositoryIndexingProgress {
    totalFiles: number;
    processedFiles: number;
    percentComplete: number;
    inputTokens: number;
    outputTokens: number;
    phase: 'files' | 'directories' | 'done';
    totalDirectories: number;
    processedDirectories: number;
}

export interface RepositoryIndexingStatus {
    full_name: string;
    branch: string;
    indexing_status: 'idle' | 'indexing' | 'completed' | 'failed';
    last_indexed_at: string | null;
    last_indexed_hash: string | null;
    last_indexed_commit_message: string | null;
    progress?: RepositoryIndexingProgress;
}

/**
 * Gets the indexing status for all repositories.
 */
export async function getRepositoriesIndexingStatus(): Promise<RepositoryIndexingStatus[]> {
    try {
        const repos = await db('repositories')
            .select('full_name', 'branch', 'indexing_status', 'last_indexed_at', 'last_indexed_hash', 'last_indexed_commit_message');

        const results: RepositoryIndexingStatus[] = [];
        for (const r of repos) {
            const status: RepositoryIndexingStatus = {
                full_name: r.full_name,
                branch: r.branch || 'HEAD',
                indexing_status: r.indexing_status || 'idle',
                last_indexed_at: r.last_indexed_at ? new Date(r.last_indexed_at).toISOString() : null,
                last_indexed_hash: r.last_indexed_hash || null,
                last_indexed_commit_message: r.last_indexed_commit_message || null
            };

            // Fetch progress data for repos that are actively indexing
            if (status.indexing_status === 'indexing') {
                const progress = await getIndexingProgress(r.full_name);
                if (progress) {
                    const percentComplete = progress.totalFiles > 0
                        ? Math.round((progress.processedFiles / progress.totalFiles) * 100)
                        : 0;
                    status.progress = {
                        totalFiles: progress.totalFiles,
                        processedFiles: progress.processedFiles,
                        percentComplete,
                        inputTokens: progress.inputTokens,
                        outputTokens: progress.outputTokens,
                        phase: progress.phase,
                        totalDirectories: progress.totalDirectories,
                        processedDirectories: progress.processedDirectories
                    };
                }
            }

            results.push(status);
        }

        return results;
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message }, 'Failed to load repositories indexing status');
        return [];
    }
}

/**
 * Gets the indexing status for a specific repository and branch.
 */
export async function getRepositoryIndexingStatus(fullName: string, branch: string = 'HEAD'): Promise<RepositoryIndexingStatus | null> {
    try {
        const repo = await db('repositories')
            .where({ full_name: fullName, branch })
            .first();
        if (!repo) return null;
        return {
            full_name: repo.full_name,
            branch: repo.branch || 'HEAD',
            indexing_status: repo.indexing_status || 'idle',
            last_indexed_at: repo.last_indexed_at ? new Date(repo.last_indexed_at).toISOString() : null,
            last_indexed_hash: repo.last_indexed_hash || null,
            last_indexed_commit_message: repo.last_indexed_commit_message || null
        };
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message, fullName, branch }, 'Failed to load repository indexing status');
        return null;
    }
}
