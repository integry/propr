import { DEFAULT_MAX_PROVIDER_REPLACEMENTS, parseUsageTipsSettings } from '@propr/shared';
import { AgentConfig, SummarizationSettings } from '../../api/proprApi';
import { Settings } from './types';
import { agentTankModeFromLegacyEnabled, isAgentTankMode, normalizeReviewContextBudgetPercent } from '@propr/shared';

// Helper function to determine default agent alias
function resolveDefaultAgentAlias(savedAlias: string | undefined, enabledAgents: AgentConfig[]): string {
  if (savedAlias) return savedAlias;
  if (enabledAgents.length === 0) return '';
  const claudeAgent = enabledAgents.find((a: AgentConfig) =>
    a.alias.toLowerCase() === 'claude' || a.alias.toLowerCase().includes('claude')
  );
  return claudeAgent ? claudeAgent.alias : enabledAgents[0].alias;
}

interface SettingsApiData {
  worker_concurrency?: string;
  max_provider_replacements?: number;
  analysis_model_fast?: string;
  planner_context_model?: string;
  planner_generation_model?: string;
  default_agent_alias?: string;
  github_user_whitelist?: string[];
  usage_tips_enabled?: boolean;
  usage_tips_dismissal_cooldown_days?: number;
  auto_resolve_merge_conflicts?: boolean;
  dashboard_summary_enabled?: boolean;
  model_reasoning_level?: string;
  pr_review_model?: string;
  pr_review_prompt?: string;
  pr_review_context_enabled?: boolean;
  pr_review_context_model?: string;
  pr_review_max_context_tokens?: number;
  pr_review_context_budget_percent?: number;
  ultrafix_escalation_enabled?: boolean;
  ultrafix_escalation_models?: string[];
  ultrafix_escalation_patience?: number;
  ultrafix_escalation_max_reasoning_levels?: number;
  ultrafix_rating_goal?: number;
  ultrafix_max_cycles?: number;
  ultrafix_pause_seconds?: number;
  default_max_cost_usd?: number;
  agent_stall_timeout_ms?: number | null;
  agent_tool_stall_timeout_ms?: number | null;
  agent_degenerate_output_limit?: number | null;
  agent_watchdog_defaults?: Settings['agent_watchdog_defaults'];
  agent_network_mode?: unknown;
  agent_network_mode_enforced?: unknown;
  agent_network_allow?: unknown;
  agent_network_defaults?: Settings['agent_network_defaults'];
}

/** The spend cap as typed in Settings: empty for no cap (0 or unset). */
function costCapInput(amount: number | undefined): string {
  return amount ? String(amount) : '';
}

function watchdogOverride(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** One host per line (commas also separate); an empty list uses the environment default. */
export function parseAllowlistDraft(draft: string): string[] | null {
  const hosts = [...new Set(draft.split(/[\s,]+/).map(host => host.trim().toLowerCase()).filter(Boolean))];
  return hosts.length ? hosts : null;
}

/** Stored network overrides; anything unexpected reads as "use the default". */
export function networkOverrides(data: Pick<SettingsApiData, 'agent_network_mode' | 'agent_network_mode_enforced' | 'agent_network_allow'>): Pick<Settings, 'agent_network_mode' | 'agent_network_mode_enforced' | 'agent_network_allow'> {
  const mode = data.agent_network_mode;
  const allow = data.agent_network_allow;
  return {
    agent_network_mode: mode === 'open' || mode === 'restricted' ? mode : null,
    agent_network_mode_enforced: typeof data.agent_network_mode_enforced === 'boolean' ? data.agent_network_mode_enforced : null,
    agent_network_allow: Array.isArray(allow) && allow.every(host => typeof host === 'string') ? allow as string[] : null,
  };
}

function providerReplacements(settingsData: SettingsApiData): number {
  return settingsData.max_provider_replacements ?? DEFAULT_MAX_PROVIDER_REPLACEMENTS;
}

/** Sends the typed spend cap as a USD amount (empty = 0, no cap); a value that is not one is left unsaved. */
export function costCapToSave(value: string): { default_max_cost_usd?: number } {
  const trimmed = value.trim();
  if (!trimmed) return { default_max_cost_usd: 0 };
  const amount = Number(trimmed);
  return Number.isFinite(amount) && amount >= 0 ? { default_max_cost_usd: amount } : {};
}

/** The spend cap, agent watchdog and agent network overrides as sent on save. */
export function runLimitSettingsToSave(settings: Settings) {
  return {
    ...costCapToSave(settings.default_max_cost_usd),
    agent_stall_timeout_ms: settings.agent_stall_timeout_ms,
    agent_tool_stall_timeout_ms: settings.agent_tool_stall_timeout_ms,
    agent_degenerate_output_limit: settings.agent_degenerate_output_limit,
    agent_network_mode: settings.agent_network_mode,
    agent_network_mode_enforced: settings.agent_network_mode_enforced,
    agent_network_allow: settings.agent_network_allow
  };
}

function buildSettings(settingsData: SettingsApiData, enabledAgents: AgentConfig[]): Settings {
  return {
    worker_concurrency: settingsData.worker_concurrency || '',
    max_provider_replacements: providerReplacements(settingsData),
    analysis_model_fast: settingsData.analysis_model_fast || '',
    planner_context_model: settingsData.planner_context_model || '',
    planner_generation_model: settingsData.planner_generation_model || '',
    default_agent_alias: resolveDefaultAgentAlias(settingsData.default_agent_alias, enabledAgents),
    auto_resolve_merge_conflicts: settingsData.auto_resolve_merge_conflicts ?? false,
    usage_tips_enabled: parseUsageTipsSettings({ ...settingsData }).enabled,
    usage_tips_dismissal_cooldown_days: parseUsageTipsSettings({ ...settingsData }).cooldownDays,
    dashboard_summary_enabled: settingsData.dashboard_summary_enabled ?? true,
    model_reasoning_level: settingsData.model_reasoning_level || '',
    pr_review_model: settingsData.pr_review_model || '',
    pr_review_prompt: settingsData.pr_review_prompt || '',
    pr_review_context_enabled: settingsData.pr_review_context_enabled ?? true,
    pr_review_context_model: settingsData.pr_review_context_model || '',
    pr_review_max_context_tokens: settingsData.pr_review_max_context_tokens ?? 0,
    // Older servers omit the percentage; missing means automatic (100%).
    pr_review_context_budget_percent: normalizeReviewContextBudgetPercent(settingsData.pr_review_context_budget_percent),
    ultrafix_escalation_enabled: settingsData.ultrafix_escalation_enabled ?? false,
    ultrafix_escalation_models: settingsData.ultrafix_escalation_models ?? [],
    ultrafix_escalation_patience: settingsData.ultrafix_escalation_patience ?? 3,
    ultrafix_escalation_max_reasoning_levels: settingsData.ultrafix_escalation_max_reasoning_levels ?? 2,
    ultrafix_rating_goal: settingsData.ultrafix_rating_goal ?? 7,
    ultrafix_max_cycles: settingsData.ultrafix_max_cycles ?? 5,
    ultrafix_pause_seconds: settingsData.ultrafix_pause_seconds ?? 60,
    default_max_cost_usd: costCapInput(settingsData.default_max_cost_usd),
    agent_stall_timeout_ms: watchdogOverride(settingsData.agent_stall_timeout_ms),
    agent_tool_stall_timeout_ms: watchdogOverride(settingsData.agent_tool_stall_timeout_ms),
    agent_degenerate_output_limit: watchdogOverride(settingsData.agent_degenerate_output_limit),
    agent_watchdog_defaults: settingsData.agent_watchdog_defaults,
    ...networkOverrides(settingsData),
    agent_network_defaults: settingsData.agent_network_defaults,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseLoadedData(results: any[]) {
  const [sData, kData, ignoreData, pLabelData, pLabelsData, aData, sumData, atData] = results;
  const settingsData = sData as SettingsApiData;
  const agentsList = (aData as { agents?: AgentConfig[] }).agents || [];
  const enabledAgents = agentsList.filter((a: AgentConfig) => a.enabled);
  const whitelistRaw = settingsData.github_user_whitelist || [];
  const summarizationData = sumData as SummarizationSettings;
  return {
    settings: buildSettings(settingsData, enabledAgents),
    whitelist: Array.isArray(whitelistRaw) ? whitelistRaw : [],
    keywords: (kData as { followup_keywords?: string[] }).followup_keywords || [],
    ignoreKeywords: (ignoreData as { followup_ignore_keywords?: string[] }).followup_ignore_keywords || [],
    prLabel: (pLabelData as { pr_label?: string }).pr_label || 'propr',
    primaryLabels: (pLabelsData as { primary_processing_labels?: string[] }).primary_processing_labels || ['AI'],
    agents: agentsList,
    summarizationSettings: {
      enabled: summarizationData.enabled || false,
      agent_alias: summarizationData.agent_alias || '',
      fallback_agent_alias: summarizationData.fallback_agent_alias || '',
      custom_prompt: summarizationData.custom_prompt,
      default_prompt: summarizationData.default_prompt,
      runtime: summarizationData.runtime,
    },
    // An older backend answers with only `{ enabled, url }`; derive the mode
    // from it so the UI never renders an undefined radio selection.
    agentTankSettings: {
      mode: isAgentTankMode(atData.mode) ? atData.mode : agentTankModeFromLegacyEnabled(atData.enabled),
      enabled: atData.enabled || false,
      url: atData.url || 'http://0.0.0.0:3456'
    },
  };
}
