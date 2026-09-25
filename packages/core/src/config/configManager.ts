import {
    normalizeGitHubAttachmentPlanOverride,
    ROUTING_STATUS_REDIS_KEY,
    type GitHubAttachmentCapacity,
    type GitHubAttachmentPlanOverride,
    type ManagedPreviewStorageStatus,
    type VisualPreviewOriginalCapability
} from '@propr/shared';
import { getIssueQueue } from '../queue/taskQueue.js';
import { createManagedPreviewStorageClient } from '../services/previewStorage/runtime.js';
import { loadGitHubAttachmentCapacity } from '../services/visualPreviewCapacityService.js';
import logger from '../utils/logger.js';
import { invalidateSettingsCache } from '../services/relevance/keywordExtractor.js';
import { getConfig, saveConfig } from './configStore.js';
import type { Knex } from 'knex';
export {
    clearRemovedRepositoryIndexData,
    getRepositoriesIndexingStatus,
    getRepositoryIndexingStatus,
    type RepositoryIndexCleanupResult,
    type RepositoryIndexingProgress,
    type RepositoryIndexingStatus
} from './configManagerIndexing.js';

// --- Interfaces ---

export interface RepoToMonitor {
    id: string;              // UUID, required for uniqueness
    name: string;            // owner/repo
    enabled: boolean;
    autoFollowupOnFailedCi?: boolean; // Defaults to false for legacy configurations
    cancelCiDuringFollowup?: boolean; // Defaults to false; cancels obsolete PR validation while a follow-up implements
    // Exactly which validation workflows that option may cancel: workflow file
    // paths, file names, display names or numeric workflow IDs. Nothing is
    // cancelled while this is empty; eligibility is never inferred from a name.
    cancelCiDuringFollowupWorkflows?: string[];
    notificationsEnabled?: boolean; // Defaults to true; undefined (legacy configurations) reads as enabled
    visualPreview?: VisualPreviewSettings; // Defaults to disabled for legacy configurations
    alias?: string;          // Optional display name
    baseBranch?: string;     // Optional specific branch to monitor
    defaultBranch?: string;  // Optional repository default branch for demo metadata
}

export type VisualPreviewType = 'image' | 'video';

export interface VisualPreviewSettings {
    githubAttachmentPlan?: GitHubAttachmentPlanOverride;
    /** Computed at runtime; never trusted from stored settings. */
    githubAttachmentCapacity?: GitHubAttachmentCapacity;
    /** Trusted runtime capability supplied by managed storage; never persisted or accepted from repository settings. */
    originalEvidenceCapability?: VisualPreviewOriginalCapability;
    enabled: boolean;
    types: VisualPreviewType[];
    instructions?: string;
}

export function normalizeStoredVisualPreviewSettings(value: unknown): VisualPreviewSettings {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { enabled: false, types: ['image'] };
    }

    const candidate = value as Partial<VisualPreviewSettings>;
    const types = Array.isArray(candidate.types)
        ? [...new Set(candidate.types.filter((type): type is VisualPreviewType => type === 'image' || type === 'video'))]
        : [];
    const instructions = typeof candidate.instructions === 'string' && candidate.instructions.trim()
        ? candidate.instructions.trim()
        : undefined;

    return {
        enabled: candidate.enabled === true,
        ...(candidate.githubAttachmentPlan !== undefined ? { githubAttachmentPlan: normalizeGitHubAttachmentPlanOverride(candidate.githubAttachmentPlan) } : {}),
        types: types.length > 0 ? types : ['image'],
        ...(instructions ? { instructions } : {})
    };
}

interface ConfigSettings {
    worker_concurrency?: number;
    analysis_model_fast?: string;
    analysis_model_advanced?: string;
    planner_context_model?: string;
    planner_generation_model?: string;
    [key: string]: unknown;
}

function redactSettingsForLog(settings: ConfigSettings): ConfigSettings {
    const redacted: ConfigSettings = {};
    for (const [key, value] of Object.entries(settings)) {
        redacted[key] = /(api[_-]?key|token|secret|password|credential)/i.test(key)
            ? '[REDACTED]'
            : value;
    }
    return redacted;
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

/**
 * Resolve the branch-independent visual-preview policy for a repository.
 * Multiple branch entries may exist for one repository; an explicitly enabled
 * entry wins over disabled or legacy entries until the next synchronized save.
 */
export function resolveRepositoryVisualPreviewSettings(
    repos: readonly RepoToMonitor[],
    repository: string
): VisualPreviewSettings {
    const normalizedRepository = repository.trim().toLowerCase();
    if (!normalizedRepository) return { enabled: false, types: ['image'] };

    const matching = repos.filter(repo => repo.name.trim().toLowerCase() === normalizedRepository);
    const configured = matching.find(repo => normalizeStoredVisualPreviewSettings(repo.visualPreview).enabled)
        ?? matching.find(repo => repo.visualPreview !== undefined);
    return normalizeStoredVisualPreviewSettings(configured?.visualPreview);
}

export async function loadRepositoryVisualPreviewSettings(repository: string): Promise<VisualPreviewSettings> {
    try {
        const settings = resolveRepositoryVisualPreviewSettings(await loadMonitoredReposRaw(), repository);
        logger.info({ repository, enabled: settings.enabled, types: settings.types }, 'Loaded repository visual-preview settings');
        const [githubAttachmentCapacity, originalEvidenceCapability] = await Promise.all([
            loadGitHubAttachmentCapacity(settings.githubAttachmentPlan, repository),
            settings.enabled ? loadOriginalEvidenceCapability() : undefined
        ]);
        return {
            ...settings,
            githubAttachmentCapacity,
            ...(originalEvidenceCapability ? { originalEvidenceCapability } : {})
        };
    } catch (error) {
        logger.warn({ repository, error: (error as Error).message }, 'Failed to load visual-preview settings; treating previews as disabled');
        return { enabled: false, types: ['image'] };
    }
}

async function loadManagedPreviewStorageStatus(): Promise<ManagedPreviewStorageStatus> {
    const queue = await getIssueQueue();
    const client = createManagedPreviewStorageClient(async () => (await queue.client).get(ROUTING_STATUS_REDIS_KEY));
    return client.getStatus();
}

export async function loadOriginalEvidenceCapability(
    loadStatus: () => Promise<ManagedPreviewStorageStatus> = loadManagedPreviewStorageStatus
): Promise<VisualPreviewOriginalCapability | undefined> {
    try {
        const status = await loadStatus();
        return status.state === 'enabled' && status.enabled && status.effective?.enabled
            ? {
                maxBytes: status.effective.maxObjectBytes,
                allowedContentTypes: [...status.effective.allowedContentTypes]
            }
            : undefined;
    } catch {
        return undefined;
    }
}

export async function saveMonitoredRepos(repos: RepoToMonitor[], client?: Knex | Knex.Transaction): Promise<boolean> {
    await saveConfig('repos_to_monitor', repos, client);
    logger.info({ repos }, 'Successfully saved monitored repositories');
    return true;
}

export async function loadSettings(): Promise<ConfigSettings> {
    const settings = await getConfig<ConfigSettings>('settings', {});
    logger.info({ settings: redactSettingsForLog(settings) }, 'Successfully loaded settings');
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

/**
 * Resolves the full set of labels that opt a pull request into ProPR automation.
 * Combines the primary processing labels, the PR label, and the AI primary tag
 * into a deduplicated list of non-empty strings.
 */
export async function loadValidTriggerLabels(): Promise<string[]> {
    const [primaryLabels, prLabel, aiPrimaryTag] = await Promise.all([
        loadPrimaryProcessingLabels(),
        loadPrLabel(),
        loadAiPrimaryTag(),
    ]);

    const candidates = [...(Array.isArray(primaryLabels) ? primaryLabels : []), prLabel, aiPrimaryTag];
    const unique = new Set<string>();
    for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue;
        const trimmed = candidate.trim();
        if (trimmed) unique.add(trimmed);
    }
    return [...unique];
}

/**
 * Returns true when at least one of the given PR labels is a valid trigger label.
 * Matching is case-sensitive, mirroring how GitHub labels are compared elsewhere.
 * Accepts label objects (`{ name }`) or plain strings; null/undefined yields false.
 */
export async function hasValidTriggerLabel(labels: Array<{ name: string } | string> | null | undefined): Promise<boolean> {
    if (!labels || !Array.isArray(labels) || labels.length === 0) return false;

    const labelNames = labels
        .map(label => (typeof label === 'string' ? label : label?.name))
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
    if (labelNames.length === 0) return false;

    const triggerLabels = await loadValidTriggerLabels();
    return labelNames.some(name => triggerLabels.includes(name));
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

export {
    loadModelReasoningLevel,
    saveModelReasoningLevel,
    normalizeModelReasoningLevel,
    resolveClaudeReasoningLevel,
    resolveCodexReasoningLevel,
    resolveAgentModelReasoningLevel,
    validateModelReasoningLevel,
    resolveRuntimeModelReasoningLevel,
    assertReasoningLevelCliVersionSupported,
    getReasoningLevelCliVersionError,
    findReasoningLevelCliVersionWarnings,
    type ModelReasoningLevel,
    type ClaudeRuntimeReasoningLevel,
    type CodexRuntimeReasoningLevel,
    type RuntimeReasoningLevel
} from './configManagerReasoning.js';

export { validatePrReviewModelValue, type PrReviewModelValidationResult } from './prReviewModelValidator.js';
export { getConfig, saveConfig } from './configStore.js';
export {
    clearSummarizationCooldown,
    clearSummarizationPrimaryQuotaFailures,
    clearSummarizationRuntimeState,
    clearSummarizationRuntimeStateForSettingsChange,
    getSummarizationCooldown,
    loadSummarizationRuntimeState,
    loadSummarizationSettings,
    normalizeSummarizationBranch,
    promoteSummarizationFallbackIfNeeded,
    recordPrimarySummarizationQuotaFailure,
    recordPrimarySummarizationResponseFailure,
    recordSummarizationCooldown,
    saveSummarizationSettings,
    isSummarizationInvalidResponseError,
    type SummarizationCooldown,
    type SummarizationDegradationWarning,
    type SummarizationRuntimeState,
    type SummarizationSettings
} from './configManagerSummarization.js';
export {
    type CliVersionType,
    type AgentConfig,
    AgentConfigPathUnavailableError,
    DEFAULT_CONFIG_PATHS,
    assertCodexConfigPathAvailable,
    resolveCodexConfigPath,
    resolveConfigPath,
    getDefaultConfigPath,
    loadAgents,
    loadEffectiveAgentBaseImages,
    saveAgents,
    migrateAgentConfigs,
    type AgentTankSettings,
    loadAgentTankSettings,
    saveAgentTankSettings
} from './configManagerAgents.js';

export {
    SYNTHETIC_AGENTS_CONFIG_KEY,
    loadSyntheticAgents,
    saveSyntheticAgents
} from './configManagerSyntheticAgents.js';

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
