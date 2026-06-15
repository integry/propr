// Pure, side-effect-free helpers that read or mutate an in-memory
// SummarizationRuntimeState object. They are split out of configManagerSummarization.ts
// (which owns the DB-backed orchestration) to keep that file focused and small.
import type {
    SummarizationCooldown,
    SummarizationDegradationWarning,
    SummarizationRuntimeState
} from './configManagerSummarization.js';

export const DEFAULT_SUMMARIZATION_RUNTIME_STATE: SummarizationRuntimeState = {
    primary_quota_failures: 0,
    primary_quota_failures_by_alias: {},
    cooldowns: {}
};

export function normalizeSummarizationBranch(branch?: string): string {
    return branch?.trim() || 'HEAD';
}

export function getSummarizationCooldownKey(repository: string, branch?: string): string {
    return JSON.stringify([repository, normalizeSummarizationBranch(branch)]);
}

export function normalizeSummarizationRuntimeState(state: Partial<SummarizationRuntimeState> = {}): SummarizationRuntimeState {
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

export function hasClearablePrimaryQuotaState(state: SummarizationRuntimeState): boolean {
    const hasFailures = state.primary_quota_failures !== 0 || Object.keys(state.primary_quota_failures_by_alias || {}).length > 0;
    const hasClearableWarning = !!state.warning && state.warning.mode !== 'cooldown';
    return hasFailures || hasClearableWarning;
}

export function clearPrimaryQuotaState(
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

export function clearMatchingCooldown(
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

export function clearMatchingCooldownWarning(
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

export function clearMatchingDegradationWarning(
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

// Resets the (account-global, now-stale) quota-failure bookkeeping and drops
// degraded/promoted warnings, but leaves cooldowns and cooldown warnings alone.
export function clearStaleQuotaFailureBookkeeping(state: SummarizationRuntimeState): boolean {
    let changed = false;
    if (state.primary_quota_failures !== 0 || Object.keys(state.primary_quota_failures_by_alias || {}).length > 0) {
        state.primary_quota_failures = 0;
        state.primary_quota_failures_by_alias = {};
        changed = true;
    }
    if (state.warning && state.warning.mode !== 'cooldown') {
        delete state.warning;
        changed = true;
    }
    return changed;
}

// Resumes only repositories whose pause was caused by a model that is no longer
// configured; cooldowns for still-active models are preserved.
export function clearCooldownsForRemovedAliases(state: SummarizationRuntimeState, activeAliases: Set<string>): boolean {
    let changed = false;
    for (const [key, cooldown] of Object.entries(state.cooldowns || {})) {
        if (!cooldown.primary_agent_alias || activeAliases.has(cooldown.primary_agent_alias)) continue;
        delete state.cooldowns[key];
        if (cooldownWarningMatches(state.warning, cooldown)) delete state.warning;
        changed = true;
    }
    return changed;
}

function cooldownWarningMatches(
    warning: SummarizationDegradationWarning | undefined,
    cooldown: SummarizationCooldown
): boolean {
    return !!warning
        && warning.mode === 'cooldown'
        && warning.repository === cooldown.repository
        && normalizeSummarizationBranch(warning.branch) === cooldown.branch;
}
