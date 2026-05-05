import logger from '../utils/logger.js';
import { invalidateSettingsCache } from '../services/relevance/keywordExtractor.js';
import { getConfig, saveConfig } from './configStore.js';

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

// --- Auto-Followup Score Threshold ---

/**
 * Default threshold for auto-followup on low implementation scores.
 * Range: 0-9 (0 = disabled, 1-9 = trigger if score is at or below this value)
 */
const DEFAULT_AUTO_FOLLOWUP_SCORE_THRESHOLD = 4;

/**
 * Loads the auto-followup score threshold from the database.
 * Returns 0 if disabled, or a value 1-9 indicating the threshold.
 * Falls back to default if the stored value is malformed or out of range.
 */
export async function loadAutoFollowupScoreThreshold(): Promise<number> {
    const threshold = await getConfig<number>('auto_followup_score_threshold', DEFAULT_AUTO_FOLLOWUP_SCORE_THRESHOLD);
    if (typeof threshold !== 'number' || isNaN(threshold) || threshold < 0 || threshold > 9) {
        logger.warn({ stored_value: threshold }, 'Invalid auto_followup_score_threshold in DB, using default');
        return DEFAULT_AUTO_FOLLOWUP_SCORE_THRESHOLD;
    }
    logger.info({ auto_followup_score_threshold: threshold }, 'Successfully loaded auto-followup score threshold');
    return threshold;
}

/**
 * Saves the auto-followup score threshold to the database.
 * @param threshold - Value 0-9 (0 = disabled, 1-9 = threshold value)
 * @throws Error if threshold is not a valid integer in range 0-9
 */
export async function saveAutoFollowupScoreThreshold(threshold: number): Promise<boolean> {
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 9) {
        throw new Error('auto_followup_score_threshold must be an integer between 0 and 9');
    }
    await saveConfig('auto_followup_score_threshold', threshold);
    logger.info({ auto_followup_score_threshold: threshold }, 'Successfully saved auto-followup score threshold');
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
    handleSettingsSaveSideEffects();
    logger.info({ settings: merged }, 'Successfully saved settings');
    return true;
}

export function handleSettingsSaveSideEffects(): void {
    invalidateSettingsCache();
}

export async function loadPrLabel(): Promise<string> {
    const defaultLabel = process.env.PR_LABEL || 'propr';
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

export {
    loadPrReviewModel,
    savePrReviewModel,
    loadUltrafixRatingGoal,
    saveUltrafixRatingGoal,
    loadUltrafixMaxCycles,
    saveUltrafixMaxCycles,
    loadUltrafixPauseSeconds,
    saveUltrafixPauseSeconds
} from './configManagerUltrafix.js';

export { validatePrReviewModelValue, type PrReviewModelValidationResult } from './prReviewModelValidator.js';
export { getConfig, saveConfig } from './configStore.js';
export {
    type CliVersionType,
    type AgentConfig,
    DEFAULT_CONFIG_PATHS,
    resolveConfigPath,
    getDefaultConfigPath,
    loadAgents,
    saveAgents,
    migrateAgentConfigs,
    type AgentTankSettings,
    loadAgentTankSettings,
    saveAgentTankSettings
} from './configManagerAgents.js';
export {
    type RepositoryIndexingProgress,
    type RepositoryIndexingStatus,
    getRepositoriesIndexingStatus,
    getRepositoryIndexingStatus
} from './configManagerIndexing.js';

// --- Auto Resolve Merge Conflicts ---

/**
 * Loads the auto_resolve_merge_conflicts setting from the database.
 * Returns false if the setting has not been explicitly set (backward-compatible default).
 */
export async function loadAutoResolveMergeConflicts(): Promise<boolean> {
    const value = await getConfig<boolean>('auto_resolve_merge_conflicts', false);
    logger.info({ auto_resolve_merge_conflicts: value }, 'Successfully loaded auto-resolve merge conflicts setting');
    return value;
}

/**
 * Saves the auto_resolve_merge_conflicts setting to the database.
 */
export async function saveAutoResolveMergeConflicts(enabled: boolean): Promise<boolean> {
    await saveConfig('auto_resolve_merge_conflicts', enabled);
    logger.info({ auto_resolve_merge_conflicts: enabled }, 'Successfully saved auto-resolve merge conflicts setting');
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
