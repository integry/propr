import logger from '../utils/logger.js';
import { invalidateSettingsCache } from '../services/relevance/keywordExtractor.js';
import { getConfig, getConfigWithClient, saveConfig } from './configStore.js';
import { db } from '../db/connection.js';
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
    alias?: string;          // Optional display name
    baseBranch?: string;     // Optional specific branch to monitor
    defaultBranch?: string;  // Optional repository default branch for demo metadata
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
    fallback_agent_alias?: string;
    custom_prompt?: string;
}

const DEFAULT_SUMMARIZATION_SETTINGS: SummarizationSettings = { enabled: false, agent_alias: '', fallback_agent_alias: '', custom_prompt: '' };

export interface SummarizationCooldown {
    repository: string;
    branch: string;
    until: string;
    reason: string;
    primary_agent_alias?: string;
    fallback_agent_alias?: string;
}

export interface SummarizationDegradationWarning {
    mode: 'fallback_degraded' | 'fallback_promoted' | 'cooldown';
    message: string;
    recorded_at: string;
    repository?: string;
    branch?: string;
    primary_agent_alias?: string;
    fallback_agent_alias?: string;
}

export interface SummarizationRuntimeState {
    primary_quota_failures: number;
    primary_quota_failures_by_alias: Record<string, number>;
    warning?: SummarizationDegradationWarning;
    cooldowns: Record<string, SummarizationCooldown>;
}

const DEFAULT_SUMMARIZATION_RUNTIME_STATE: SummarizationRuntimeState = { primary_quota_failures: 0, primary_quota_failures_by_alias: {}, cooldowns: {} };

const SUMMARIZATION_RUNTIME_STATE_KEY = 'summarization_runtime_state';
let summarizationRuntimeStateMutation = Promise.resolve();

export function normalizeSummarizationBranch(branch?: string): string { return branch?.trim() || 'HEAD'; }

function getSummarizationCooldownKey(repository: string, branch?: string): string { return JSON.stringify([repository, normalizeSummarizationBranch(branch)]); }

function getPromotionThreshold(): number {
    const value = parseInt(process.env.SUMMARIZATION_FALLBACK_PROMOTE_THRESHOLD || '3', 10);
    return Number.isFinite(value) && value > 0 ? value : 3;
}

function getCooldownMs(): number {
    const value = parseInt(process.env.SUMMARIZATION_QUOTA_COOLDOWN_MS || String(60 * 60 * 1000), 10);
    return Number.isFinite(value) && value > 0 ? value : 60 * 60 * 1000;
}

/**
 * Loads summarization settings from the database.
 */
export async function loadSummarizationSettings(client?: Knex | Knex.Transaction): Promise<SummarizationSettings> {
    const loader = client ? getConfigWithClient : getConfig;
    const settings = await loader<SummarizationSettings>('summarization', DEFAULT_SUMMARIZATION_SETTINGS, client as Knex | Knex.Transaction);
    const normalized = { ...DEFAULT_SUMMARIZATION_SETTINGS, ...settings };
    logger.info({ summarization: normalized }, 'Successfully loaded summarization settings');
    return normalized;
}

/**
 * Saves summarization settings to the database.
 */
export async function saveSummarizationSettings(settings: SummarizationSettings, client?: Knex | Knex.Transaction): Promise<boolean> {
    const normalized = { ...DEFAULT_SUMMARIZATION_SETTINGS, ...settings };
    await saveConfig('summarization', normalized, client);
    logger.info({ summarization: normalized }, 'Successfully saved summarization settings');
    return true;
}

export async function loadSummarizationRuntimeState(): Promise<SummarizationRuntimeState> {
    const state = await getConfig<SummarizationRuntimeState>(SUMMARIZATION_RUNTIME_STATE_KEY, DEFAULT_SUMMARIZATION_RUNTIME_STATE);
    const normalized = normalizeSummarizationRuntimeState(state);
    if (JSON.stringify(normalized) !== JSON.stringify(state)) {
        await saveConfig(SUMMARIZATION_RUNTIME_STATE_KEY, normalized);
    }
    return normalized;
}

function normalizeSummarizationRuntimeState(state: Partial<SummarizationRuntimeState> = {}): SummarizationRuntimeState {
    const now = Date.now();
    const cooldowns = Object.fromEntries(Object.entries(state.cooldowns || {}).filter(([, cooldown]) => Date.parse(cooldown.until) > now));
    const warning = normalizeSummarizationWarning(state.warning, cooldowns, now);
    return { ...DEFAULT_SUMMARIZATION_RUNTIME_STATE, ...state, warning, cooldowns, primary_quota_failures: state.primary_quota_failures || 0, primary_quota_failures_by_alias: state.primary_quota_failures_by_alias || {} };
}

function normalizeSummarizationWarning(
    warning: SummarizationDegradationWarning | undefined,
    cooldowns: Record<string, SummarizationCooldown>,
    now: number
): SummarizationDegradationWarning | undefined {
    if (!warning) return undefined;
    if (warning.mode !== 'cooldown') return warning;

    const matchingCooldown = Object.values(cooldowns).find(cooldown => cooldown.repository === warning.repository && cooldown.branch === normalizeSummarizationBranch(warning.branch) && Date.parse(cooldown.until) > now);
    return matchingCooldown ? warning : undefined;
}

async function mutateSummarizationRuntimeState<T>(
    operation: (state: SummarizationRuntimeState, client: Knex.Transaction) => Promise<{ result: T; save: boolean }>
): Promise<T> {
    const run = summarizationRuntimeStateMutation.then(async () =>
        db.transaction(async trx => {
            await ensureSummarizationRuntimeStateRow(trx);
            const state = await loadSummarizationRuntimeStateForMutation(trx);
            const { result, save } = await operation(state, trx);
            if (save) await saveConfig(SUMMARIZATION_RUNTIME_STATE_KEY, state, trx);
            return result;
        })
    );
    summarizationRuntimeStateMutation = run.then(() => undefined, () => undefined);
    return run;
}

async function ensureSummarizationRuntimeStateRow(client: Knex.Transaction): Promise<void> {
    const now = client.fn.now();
    await client('system_configs').insert({ key: SUMMARIZATION_RUNTIME_STATE_KEY, value: JSON.stringify(DEFAULT_SUMMARIZATION_RUNTIME_STATE), updated_at: now, created_at: now }).onConflict('key').ignore();
}

async function loadSummarizationRuntimeStateForMutation(client: Knex.Transaction): Promise<SummarizationRuntimeState> {
    const query = client('system_configs').where({ key: SUMMARIZATION_RUNTIME_STATE_KEY });
    const row = await (client.client.config.client === 'better-sqlite3' ? query : query.forUpdate()).first();
    const state = row?.value ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : DEFAULT_SUMMARIZATION_RUNTIME_STATE;
    return normalizeSummarizationRuntimeState(state);
}

export async function getSummarizationCooldown(repository: string, branch: string = 'HEAD'): Promise<SummarizationCooldown | null> {
    const state = await loadSummarizationRuntimeState();
    const cooldown = state.cooldowns[getSummarizationCooldownKey(repository, branch)];
    if (!cooldown || Date.parse(cooldown.until) <= Date.now()) return null;
    return cooldown;
}

export async function recordSummarizationCooldown(options: {
    repository: string;
    branch?: string;
    primaryAgentAlias?: string;
    fallbackAgentAlias?: string;
    reason?: string;
}): Promise<SummarizationCooldown> {
    const branch = normalizeSummarizationBranch(options.branch);
    const until = new Date(Date.now() + getCooldownMs()).toISOString();
    const reason = options.reason || 'Primary and fallback summarization models are quota-limited.';
    const cooldown: SummarizationCooldown = { repository: options.repository, branch, until, reason, primary_agent_alias: options.primaryAgentAlias, fallback_agent_alias: options.fallbackAgentAlias };
    await mutateSummarizationRuntimeState(async state => {
        state.cooldowns[getSummarizationCooldownKey(options.repository, branch)] = cooldown;
        state.warning = { mode: 'cooldown', message: `${options.repository} (${branch}) summarization is paused until ${until}: ${reason}`, recorded_at: new Date().toISOString(), repository: options.repository, branch, primary_agent_alias: options.primaryAgentAlias, fallback_agent_alias: options.fallbackAgentAlias };
        return { result: undefined, save: true };
    });
    logger.warn({ cooldown }, 'Recorded summarization cooldown');
    return cooldown;
}

export async function recordPrimarySummarizationQuotaFailure(options: {
    primaryAgentAlias: string;
    fallbackAgentAlias?: string;
}): Promise<{ promoted: boolean; failureCount: number; warning: SummarizationDegradationWarning }> {
    let promoted = false;
    const result = await mutateSummarizationRuntimeState(async (state, client) => {
        const failuresByAlias = state.primary_quota_failures_by_alias || {};
        const failureCount = (failuresByAlias[options.primaryAgentAlias] || 0) + 1;
        failuresByAlias[options.primaryAgentAlias] = failureCount;
        state.primary_quota_failures_by_alias = failuresByAlias;
        state.primary_quota_failures = failureCount;
        const warning: SummarizationDegradationWarning = {
            mode: 'fallback_degraded',
            message: options.fallbackAgentAlias
                ? `Primary summarization model ${options.primaryAgentAlias} is quota-limited; using fallback ${options.fallbackAgentAlias}.`
                : `Primary summarization model ${options.primaryAgentAlias} is quota-limited.`,
            recorded_at: new Date().toISOString(),
            primary_agent_alias: options.primaryAgentAlias,
            fallback_agent_alias: options.fallbackAgentAlias
        };

        if (options.fallbackAgentAlias && failureCount >= getPromotionThreshold()) {
            const currentSettings = await loadSummarizationSettings(client);
            const currentPrimaryAlias = currentSettings.agent_alias || options.primaryAgentAlias;
            if (currentPrimaryAlias === options.primaryAgentAlias) {
                await saveSummarizationSettings({ ...currentSettings, agent_alias: options.fallbackAgentAlias, fallback_agent_alias: options.primaryAgentAlias }, client);
                promoted = true;
                warning.mode = 'fallback_promoted';
                warning.message = `Promoted summarization fallback ${options.fallbackAgentAlias} after ${failureCount} primary quota failures.`;
                delete failuresByAlias[options.primaryAgentAlias];
                state.primary_quota_failures = 0;
            }
        }

        state.warning = warning;
        return { result: { promoted, failureCount, warning }, save: true };
    });
    logger.warn({ failureCount: result.failureCount, promoted: result.promoted, ...options }, 'Recorded summarization primary quota failure');
    return result;
}

export async function clearSummarizationPrimaryQuotaFailures(): Promise<void> {
    await mutateSummarizationRuntimeState(async state => {
        const hasFailuresByAlias = Object.keys(state.primary_quota_failures_by_alias || {}).length > 0;
        if (state.primary_quota_failures === 0 && !hasFailuresByAlias && !state.warning) {
            return { result: undefined, save: false };
        }
        state.primary_quota_failures = 0;
        state.primary_quota_failures_by_alias = {};
        delete state.warning;
        return { result: undefined, save: true };
    });
}

export async function clearSummarizationRuntimeState(): Promise<void> {
    await mutateSummarizationRuntimeState(async state => {
        const hasCooldowns = Object.keys(state.cooldowns || {}).length > 0;
        const hasFailures = state.primary_quota_failures !== 0 || Object.keys(state.primary_quota_failures_by_alias || {}).length > 0;
        if (!hasCooldowns && !hasFailures && !state.warning) {
            return { result: undefined, save: false };
        }
        state.primary_quota_failures = 0;
        state.primary_quota_failures_by_alias = {};
        state.cooldowns = {};
        delete state.warning;
        return { result: undefined, save: true };
    });
}
