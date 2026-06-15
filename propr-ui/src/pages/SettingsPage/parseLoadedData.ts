import { AgentConfig, SummarizationSettings } from '../../api/proprApi';
import { Settings } from './types';

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
  analysis_model_fast?: string;
  planner_context_model?: string;
  planner_generation_model?: string;
  default_agent_alias?: string;
  github_user_whitelist?: string[];
  auto_followup_score_threshold?: number;
  auto_resolve_merge_conflicts?: boolean;
  pr_review_model?: string;
  pr_review_prompt?: string;
  ultrafix_rating_goal?: number;
  ultrafix_max_cycles?: number;
  ultrafix_pause_seconds?: number;
}

function buildSettings(settingsData: SettingsApiData, enabledAgents: AgentConfig[]): Settings {
  return {
    worker_concurrency: settingsData.worker_concurrency || '',
    analysis_model_fast: settingsData.analysis_model_fast || '',
    planner_context_model: settingsData.planner_context_model || '',
    planner_generation_model: settingsData.planner_generation_model || '',
    default_agent_alias: resolveDefaultAgentAlias(settingsData.default_agent_alias, enabledAgents),
    auto_followup_score_threshold: settingsData.auto_followup_score_threshold ?? 4,
    auto_resolve_merge_conflicts: settingsData.auto_resolve_merge_conflicts ?? false,
    pr_review_model: settingsData.pr_review_model || '',
    pr_review_prompt: settingsData.pr_review_prompt || '',
    ultrafix_rating_goal: settingsData.ultrafix_rating_goal ?? 7,
    ultrafix_max_cycles: settingsData.ultrafix_max_cycles ?? 5,
    ultrafix_pause_seconds: settingsData.ultrafix_pause_seconds ?? 60,
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
      custom_prompt: summarizationData.custom_prompt,
      default_prompt: summarizationData.default_prompt,
    },
    agentTankSettings: { enabled: atData.enabled || false, url: atData.url || 'http://0.0.0.0:3456' },
  };
}
