import { AgentConfig } from '../../api/proprApi';
import { MODEL_INFO_MAP } from '../../config/modelDefinitions';

export interface ModelOption {
  value: string;
  label: string;
  enabled: boolean;
  isRecommended?: boolean;
}

export interface AgentOption {
  value: string;
  label: string;
  isRecommended: boolean;
}

// Models recommended for summarization (cost-effective options)
const RECOMMENDED_SUMMARIZATION_ALIASES = ['haiku', 'flash', 'flash-lite', 'gpt5-mini', 'o4-mini', 'devstral-small'];

// Models recommended for context analysis (fast, cost-effective options)
const RECOMMENDED_CONTEXT_ANALYSIS_ALIASES = ['haiku', 'flash', 'flash-lite', 'gpt5-mini', 'o4-mini', 'devstral-small'];

// Models recommended for plan generation (high capability options)
const RECOMMENDED_PLAN_GENERATION_ALIASES = ['opus', 'sonnet', 'gpt-5.2', 'pro-preview', 'medium35'];

// Models recommended for implementation (high capability options)
const RECOMMENDED_IMPLEMENTATION_ALIASES = ['claude'];

// Models recommended for PR review (high capability options)
const RECOMMENDED_PR_REVIEW_ALIASES = ['opus', 'sonnet', 'gpt-5.2', 'pro-preview', 'medium35'];

function formatFallbackModelName(modelId: string): string {
  const gptMatch = modelId.match(/^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/i);
  if (!gptMatch) return modelId;
  const suffix = gptMatch[2]
    ? ` ${gptMatch[2].split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')}`
    : '';
  return `GPT-${gptMatch[1]}${suffix}`;
}

export function getModelLabel(agentAlias: string, modelId: string): string {
  const info = MODEL_INFO_MAP[modelId];
  return `${agentAlias} - ${info?.name || formatFallbackModelName(modelId)}`;
}

function isRecommendedFor(modelId: string, aliases: string[]): boolean {
  const info = MODEL_INFO_MAP[modelId];
  return !!info && aliases.includes(info.shortAlias);
}

function buildSortedModelOptions(agents: AgentConfig[], recommendedAliases: string[]): ModelOption[] {
  return agents.flatMap(agent =>
    agent.supportedModels.map(model => ({
      value: `${agent.alias}:${model}`,
      label: getModelLabel(agent.alias, model),
      enabled: agent.enabled,
      isRecommended: isRecommendedFor(model, recommendedAliases)
    }))
  ).sort((a, b) => {
    if (a.isRecommended && !b.isRecommended) return -1;
    if (!a.isRecommended && b.isRecommended) return 1;
    return 0;
  });
}

export function buildAllModelOptions(agents: AgentConfig[]): ModelOption[] {
  return agents.flatMap(agent =>
    agent.supportedModels.map(model => ({
      value: `${agent.alias}:${model}`,
      label: getModelLabel(agent.alias, model),
      enabled: agent.enabled
    }))
  );
}

export function buildSummarizationOptions(enabledAgents: AgentConfig[]): ModelOption[] {
  return buildSortedModelOptions(enabledAgents, RECOMMENDED_SUMMARIZATION_ALIASES);
}

export function buildContextAnalysisOptions(enabledAgents: AgentConfig[]): ModelOption[] {
  return buildSortedModelOptions(enabledAgents, RECOMMENDED_CONTEXT_ANALYSIS_ALIASES);
}

export function buildPlanGenerationOptions(enabledAgents: AgentConfig[]): ModelOption[] {
  return buildSortedModelOptions(enabledAgents, RECOMMENDED_PLAN_GENERATION_ALIASES);
}

export function buildPrReviewOptions(enabledAgents: AgentConfig[]): ModelOption[] {
  return buildSortedModelOptions(enabledAgents, RECOMMENDED_PR_REVIEW_ALIASES);
}

export function buildImplementationAgentOptions(enabledAgents: AgentConfig[]): AgentOption[] {
  return enabledAgents.map(agent => ({
    value: agent.alias,
    label: agent.alias,
    isRecommended: RECOMMENDED_IMPLEMENTATION_ALIASES.some(alias =>
      agent.alias.toLowerCase().includes(alias.toLowerCase())
    )
  })).sort((a, b) => {
    if (a.isRecommended && !b.isRecommended) return -1;
    if (!a.isRecommended && b.isRecommended) return 1;
    return 0;
  });
}
