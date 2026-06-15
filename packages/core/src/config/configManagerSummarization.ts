import type { Knex } from 'knex';
import { Redis } from 'ioredis';
import { db } from '../db/connection.js';
import logger from '../utils/logger.js';
import { getConfig, getConfigWithClient, saveConfig } from './configStore.js';

export interface SummarizationSettings {
    enabled: boolean;
    agent_alias: string;
    fallback_agent_alias?: string;
    custom_prompt?: string;
}

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

const DEFAULT_SUMMARIZATION_SETTINGS: SummarizationSettings = { enabled: false, agent_alias: '', fallback_agent_alias: '', custom_prompt: '' };
const DEFAULT_SUMMARIZATION_RUNTIME_STATE: SummarizationRuntimeState = { primary_quota_failures: 0, primary_quota_failures_by_alias: {}, cooldowns: {} };
const SUMMARIZATION_RUNTIME_STATE_KEY = 'summarization_runtime_state';
const SUMMARIZATION_RUNTIME_STATE_MUTATION_RETRIES = 3;
const CONFIG_EVENT_CHANNEL = 'system:config:events';
let summarizationRuntimeStateMutation = Promise.resolve();

export function normalizeSummarizationBranch(branch?: string): string { return branch?.trim() || 'HEAD'; }

function normalizeSummarizationAgentAliasSetting(value?: string): string {
    return value?.trim() || '';
}

function getSummarizationCooldownKey(repository: string, branch?: string): string {
    return JSON.stringify([repository, normalizeSummarizationBranch(branch)]);
}

function getPromotionThreshold(): number {
    const value = parseInt(process.env.SUMMARIZATION_FALLBACK_PROMOTE_THRESHOLD || '3', 10);
    return Number.isFinite(value) && value > 0 ? value : 3;
}

function getCooldownMs(): number {
    const value = parseInt(process.env.SUMMARIZATION_QUOTA_COOLDOWN_MS || String(60 * 60 * 1000), 10);
    return Number.isFinite(value) && value > 0 ? value : 60 * 60 * 1000;
}

export async function loadSummarizationSettings(client?: Knex | Knex.Transaction): Promise<SummarizationSettings> {
    const settings = client
        ? await getConfigWithClient<SummarizationSettings>('summarization', DEFAULT_SUMMARIZATION_SETTINGS, client)
        : await getConfig<SummarizationSettings>('summarization', DEFAULT_SUMMARIZATION_SETTINGS);
    const normalized = normalizeSummarizationSettings(settings);
    logger.info({ summarization: normalized }, 'Successfully loaded summarization settings');
    return normalized;
}

export async function saveSummarizationSettings(settings: SummarizationSettings, client?: Knex | Knex.Transaction): Promise<boolean> {
    const normalized = normalizeSummarizationSettings(settings);
    await saveConfig('summarization', normalized, client);
    logger.info({ summarization: normalized }, 'Successfully saved summarization settings');
    return true;
}

function normalizeSummarizationSettings(settings: Partial<SummarizationSettings> = {}): SummarizationSettings {
    return {
        ...DEFAULT_SUMMARIZATION_SETTINGS,
        ...settings,
        agent_alias: normalizeSummarizationAgentAliasSetting(settings.agent_alias),
        fallback_agent_alias: normalizeSummarizationAgentAliasSetting(settings.fallback_agent_alias)
    };
}

export async function loadSummarizationRuntimeState(): Promise<SummarizationRuntimeState> {
    const state = await getConfig<SummarizationRuntimeState>(SUMMARIZATION_RUNTIME_STATE_KEY, DEFAULT_SUMMARIZATION_RUNTIME_STATE);
    return normalizeSummarizationRuntimeState(state);
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
    const run = summarizationRuntimeStateMutation.then(async () => retrySummarizationRuntimeStateMutation(operation));
    summarizationRuntimeStateMutation = run.then(() => undefined, () => undefined);
    return run;
}

async function retrySummarizationRuntimeStateMutation<T>(
    operation: (state: SummarizationRuntimeState, client: Knex.Transaction) => Promise<{ result: T; save: boolean }>
): Promise<T> {
    let lastConflict: Error | undefined;
    for (let attempt = 1; attempt <= SUMMARIZATION_RUNTIME_STATE_MUTATION_RETRIES; attempt++) {
        try {
            return await runSummarizationRuntimeStateMutation(operation);
        } catch (error) {
            lastConflict = error as Error;
            if (!isSummarizationRuntimeStateConflict(error)) throw error;
            logger.warn({ attempt }, 'Retrying summarization runtime state mutation after concurrent update');
        }
    }
    throw lastConflict || new Error('summarization_runtime_state mutation conflict');
}

async function runSummarizationRuntimeStateMutation<T>(
    operation: (state: SummarizationRuntimeState, client: Knex.Transaction) => Promise<{ result: T; save: boolean }>
): Promise<T> {
    return db.transaction(async trx => {
        await ensureSummarizationRuntimeStateRow(trx);
        const { state, originalValue } = await loadSummarizationRuntimeStateForMutation(trx);
        const { result, save } = await operation(state, trx);
        if (save) await saveSummarizationRuntimeStateForMutation(state, originalValue, trx);
        return result;
    });
}

async function ensureSummarizationRuntimeStateRow(client: Knex.Transaction): Promise<void> {
    const now = client.fn.now();
    await client('system_configs').insert({ key: SUMMARIZATION_RUNTIME_STATE_KEY, value: JSON.stringify(DEFAULT_SUMMARIZATION_RUNTIME_STATE), updated_at: now, created_at: now }).onConflict('key').ignore();
}

async function loadSummarizationRuntimeStateForMutation(client: Knex.Transaction): Promise<{
    state: SummarizationRuntimeState;
    originalValue?: string;
}> {
    const query = client('system_configs').where({ key: SUMMARIZATION_RUNTIME_STATE_KEY });
    const row = await (client.client.config.client === 'better-sqlite3' ? query : query.forUpdate()).first();
    const originalValue = typeof row?.value === 'string' ? row.value : (row?.value === undefined ? undefined : JSON.stringify(row.value));
    const state = originalValue ? JSON.parse(originalValue) : DEFAULT_SUMMARIZATION_RUNTIME_STATE;
    return { state: normalizeSummarizationRuntimeState(state), originalValue };
}

async function saveSummarizationRuntimeStateForMutation(
    state: SummarizationRuntimeState,
    originalValue: string | undefined,
    client: Knex.Transaction
): Promise<void> {
    if (client.client.config.client !== 'better-sqlite3') {
        await saveConfig(SUMMARIZATION_RUNTIME_STATE_KEY, state, client);
        return;
    }

    const updated = await client('system_configs')
        .where({ key: SUMMARIZATION_RUNTIME_STATE_KEY, value: originalValue })
        .update({ value: JSON.stringify(state), updated_at: client.fn.now() });
    if (updated === 0) throw new Error('summarization_runtime_state concurrent update conflict');
}

function isSummarizationRuntimeStateConflict(error: unknown): boolean {
    return (error as Error).message === 'summarization_runtime_state concurrent update conflict';
}

export async function getSummarizationCooldown(repository: string, branch: string = 'HEAD'): Promise<SummarizationCooldown | null> {
    // Read-side degradation: this is consulted on the indexing hot path (e.g.
    // indexRepo / queueIndexingJob). loadSummarizationRuntimeState() rethrows on a
    // transient DB/parse error, so guard here and treat an unreadable state as
    // "no cooldown" rather than letting the error mark the repository failed.
    const state = await loadSummarizationRuntimeState().catch(error => {
        logger.warn({ error: (error as Error).message, repository, branch }, 'Failed to load summarization runtime state; proceeding without cooldown');
        return null;
    });
    if (!state) return null;
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
    const result = await mutateSummarizationRuntimeState(async (state, client) => {
        const failuresByAlias = state.primary_quota_failures_by_alias || {};
        const failureCount = (failuresByAlias[options.primaryAgentAlias] || 0) + 1;
        failuresByAlias[options.primaryAgentAlias] = failureCount;
        state.primary_quota_failures_by_alias = failuresByAlias;
        state.primary_quota_failures = failureCount;
        const warning = buildQuotaFailureWarning(options);
        let promoted = false;

        if (options.fallbackAgentAlias && failureCount >= getPromotionThreshold()) {
            promoted = await promoteFallbackIfCurrentPrimary({ options, failuresByAlias, state, warning, client });
        }

        state.warning = warning;
        return { result: { promoted, failureCount: state.primary_quota_failures, warning }, save: true };
    });
    if (result.promoted) await publishSummarizationSettingsUpdate();
    logger.warn({ failureCount: result.failureCount, promoted: result.promoted, ...options }, 'Recorded summarization primary quota failure');
    return result;
}

function buildQuotaFailureWarning(options: {
    primaryAgentAlias: string;
    fallbackAgentAlias?: string;
}): SummarizationDegradationWarning {
    return {
        mode: 'fallback_degraded',
        message: options.fallbackAgentAlias
            ? `Primary summarization model ${options.primaryAgentAlias} is quota-limited; using fallback ${options.fallbackAgentAlias}.`
            : `Primary summarization model ${options.primaryAgentAlias} is quota-limited.`,
        recorded_at: new Date().toISOString(),
        primary_agent_alias: options.primaryAgentAlias,
        fallback_agent_alias: options.fallbackAgentAlias
    };
}

async function promoteFallbackIfCurrentPrimary(args: {
    options: { primaryAgentAlias: string; fallbackAgentAlias?: string };
    failuresByAlias: Record<string, number>;
    state: SummarizationRuntimeState;
    warning: SummarizationDegradationWarning;
    client: Knex.Transaction;
}): Promise<boolean> {
    const { options, failuresByAlias, state, warning, client } = args;
    const currentSettings = await loadSummarizationSettings(client);
    const currentPrimaryAlias = currentSettings.agent_alias || options.primaryAgentAlias;
    if (currentPrimaryAlias !== options.primaryAgentAlias || !options.fallbackAgentAlias) return false;
    // Don't promote with a stale fallback: if an operator changed the fallback
    // since this in-flight failure began, swapping in options.fallbackAgentAlias
    // would clobber their newer choice. Only promote the fallback still configured.
    if (currentSettings.fallback_agent_alias && currentSettings.fallback_agent_alias !== options.fallbackAgentAlias) return false;

    await saveSummarizationSettings({ ...currentSettings, agent_alias: options.fallbackAgentAlias, fallback_agent_alias: options.primaryAgentAlias }, client);
    warning.mode = 'fallback_promoted';
    warning.message = `Promoted summarization fallback ${options.fallbackAgentAlias} after ${failuresByAlias[options.primaryAgentAlias]} primary quota failures.`;
    state.primary_quota_failures = 0;
    state.primary_quota_failures_by_alias = {};
    return true;
}

async function publishSummarizationSettingsUpdate(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    const redis = new Redis({
        host: process.env.REDIS_HOST ?? '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
        connectTimeout: 1000,
        maxRetriesPerRequest: 0,
        enableReadyCheck: false,
        lazyConnect: true
    });
    redis.on('error', (error: Error) => {
        logger.warn({ error: error.message }, 'Redis error publishing summarization settings update');
    });
    try {
        await redis.connect();
        await redis.publish(CONFIG_EVENT_CHANNEL, JSON.stringify({ type: 'config_update', subtype: 'summarization_settings_update', timestamp: Date.now() }));
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Failed to publish summarization promotion config update');
    } finally {
        redis.disconnect();
    }
}

export async function clearSummarizationPrimaryQuotaFailures(options: {
    primaryAgentAlias?: string;
    repository?: string;
    branch?: string;
} = {}): Promise<void> {
    // Cheap read-only pre-check: this runs after every successful summarization
    // batch, but the common case has nothing to clear. Avoid opening a
    // row-locking write transaction on system_configs when there is no state.
    const current = await loadSummarizationRuntimeState();
    if (!hasClearablePrimaryQuotaState(current)) return;

    await mutateSummarizationRuntimeState(async state => {
        const shouldSave = clearPrimaryQuotaState(state, options);
        return { result: undefined, save: shouldSave };
    });
}

function hasClearablePrimaryQuotaState(state: SummarizationRuntimeState): boolean {
    const hasFailures = state.primary_quota_failures !== 0 || Object.keys(state.primary_quota_failures_by_alias || {}).length > 0;
    const hasClearableWarning = !!state.warning && state.warning.mode !== 'cooldown';
    return hasFailures || hasClearableWarning;
}

export async function clearSummarizationCooldown(
    repository: string,
    branch?: string,
    options: { primaryAgentAlias?: string; fallbackAgentAlias?: string; clearDegradationWarning?: boolean } = {}
): Promise<void> {
    await mutateSummarizationRuntimeState(async state => {
        const cooldownCleared = clearMatchingCooldown(state, { repository, branch, ...options });
        const cooldownWarningCleared = cooldownCleared && clearMatchingCooldownWarning(state, { repository, branch, ...options });
        const degradationWarningCleared = options.clearDegradationWarning ? clearMatchingDegradationWarning(state, options) : false;
        return { result: undefined, save: cooldownCleared || cooldownWarningCleared || degradationWarningCleared };
    });
}

function clearPrimaryQuotaState(
    state: SummarizationRuntimeState,
    options: { primaryAgentAlias?: string; repository?: string; branch?: string }
): boolean {
    const failuresByAlias = state.primary_quota_failures_by_alias || {};
    const hadFailureState = clearAliasFailureState(state, failuresByAlias, options.primaryAgentAlias);
    const warningCleared = clearMatchingWarning(state, options);
    return hadFailureState || warningCleared;
}

function clearAliasFailureState(
    state: SummarizationRuntimeState,
    failuresByAlias: Record<string, number>,
    primaryAgentAlias?: string
): boolean {
    const hadFailures = state.primary_quota_failures !== 0 || Object.keys(failuresByAlias).length > 0;
    if (!primaryAgentAlias) {
        state.primary_quota_failures = 0;
        state.primary_quota_failures_by_alias = {};
        return hadFailures;
    }

    const hadAliasFailure = failuresByAlias[primaryAgentAlias] !== undefined;
    delete failuresByAlias[primaryAgentAlias];
    const remainingCounts = Object.values(failuresByAlias);
    state.primary_quota_failures = remainingCounts.length > 0 ? Math.max(...remainingCounts) : 0;
    state.primary_quota_failures_by_alias = failuresByAlias;
    return hadAliasFailure;
}

function clearMatchingCooldown(
    state: SummarizationRuntimeState,
    options: { repository?: string; branch?: string; primaryAgentAlias?: string; fallbackAgentAlias?: string }
): boolean {
    if (!options.repository) return false;
    const cooldownKey = getSummarizationCooldownKey(options.repository, options.branch);
    const cooldown = state.cooldowns[cooldownKey];
    if (!cooldown) return false;
    if (!cooldownAliasesMatch(cooldown, options)) return false;
    delete state.cooldowns[cooldownKey];
    return true;
}

function cooldownAliasesMatch(
    cooldown: SummarizationCooldown,
    options: { primaryAgentAlias?: string; fallbackAgentAlias?: string }
): boolean {
    if (options.primaryAgentAlias && cooldown.primary_agent_alias !== options.primaryAgentAlias) return false;
    if (options.fallbackAgentAlias && cooldown.fallback_agent_alias !== options.fallbackAgentAlias) return false;
    return true;
}

function clearMatchingWarning(
    state: SummarizationRuntimeState,
    options: { primaryAgentAlias?: string; repository?: string; branch?: string }
): boolean {
    if (!state.warning) return false;
    if (state.warning.mode !== 'cooldown' && (!options.primaryAgentAlias || state.warning.primary_agent_alias === options.primaryAgentAlias)) {
        delete state.warning;
        return true;
    }
    return false;
}

function clearMatchingCooldownWarning(
    state: SummarizationRuntimeState,
    options: { repository: string; branch?: string; primaryAgentAlias?: string; fallbackAgentAlias?: string }
): boolean {
    if (!state.warning) return false;
    if (state.warning.mode !== 'cooldown') return false;
    if (state.warning.repository !== options.repository) return false;
    if (normalizeSummarizationBranch(state.warning.branch) !== normalizeSummarizationBranch(options.branch)) return false;
    if (!warningAliasesMatch(state.warning, options)) return false;
    delete state.warning;
    return true;
}

function clearMatchingDegradationWarning(
    state: SummarizationRuntimeState,
    options: { primaryAgentAlias?: string; fallbackAgentAlias?: string }
): boolean {
    if (!state.warning) return false;
    if (state.warning.mode !== 'fallback_degraded') return false;
    if (!warningAliasesMatch(state.warning, options)) return false;
    delete state.warning;
    return true;
}

function warningAliasesMatch(
    warning: SummarizationDegradationWarning,
    options: { primaryAgentAlias?: string; fallbackAgentAlias?: string }
): boolean {
    if (options.primaryAgentAlias && warning.primary_agent_alias !== options.primaryAgentAlias) return false;
    if (options.fallbackAgentAlias && warning.fallback_agent_alias !== options.fallbackAgentAlias) return false;
    return true;
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
