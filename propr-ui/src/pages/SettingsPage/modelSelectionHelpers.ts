import { AgentConfig } from '../../api/proprApi';
import { AgentType, AGENT_MODELS, MODEL_INFO_MAP, ModelInfo } from '../../config/modelDefinitions';

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
const MAX_GITHUB_LABEL_LENGTH = 50;

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

function toTitleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => {
      const upper = part.toUpperCase();
      if (upper === 'GPT') return 'GPT';
      if (upper === 'OPENAI') return 'OpenAI';
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function buildSyntheticGithubLabel(agentType: AgentType, modelId: string): string {
  const canonicalLabel = agentType === 'opencode'
    ? `llm-opencode:${modelId}`
    : `llm-${agentType}-${modelId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
  if (canonicalLabel.length <= MAX_GITHUB_LABEL_LENGTH) return canonicalLabel;

  const hash = shortHash(modelId);
  const maxAgentTypeLength = Math.max(1, MAX_GITHUB_LABEL_LENGTH - `llm-:-x-${hash}`.length);
  const labelAgentType = agentType.slice(0, maxAgentTypeLength);
  const prefix = modelId
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .slice(0, Math.max(1, MAX_GITHUB_LABEL_LENGTH - `llm-${labelAgentType}:-${hash}`.length))
    .replace(/[^a-zA-Z0-9]+$/, '');
  return `llm-${labelAgentType}:${prefix || 'model'}-${hash}`;
}

function buildSyntheticModel(agentType: AgentType, modelId: string): ModelInfo {
  const displayModelId = modelId;
  const providerSeparator = displayModelId.includes('/') ? '/' : displayModelId.includes(':') ? ':' : '';
  const [provider, rawName] = providerSeparator ? displayModelId.split(providerSeparator, 2) : ['', displayModelId];
  const shortAlias = (rawName || modelId).toLowerCase().replace(/[^a-z0-9-]+/g, '');
  const providerPrefix = provider ? `${toTitleCase(provider)} ` : '';

  return {
    id: modelId,
    name: `${providerPrefix}${toTitleCase(rawName || modelId)}`,
    shortName: toTitleCase(rawName || modelId),
    shortAlias,
    githubLabel: buildSyntheticGithubLabel(agentType, modelId),
    contextWindow: '',
    maxTokens: 0,
    openRouterId: modelId,
  };
}

export function buildSelectableModels(agentType: AgentType, modelIds: string[]): ModelInfo[] {
  const staticModels = AGENT_MODELS[agentType] || [];
  const modelMap = new Map<string, ModelInfo>();
  for (const model of staticModels) modelMap.set(model.id, model);
  for (const modelId of modelIds) {
    if (!modelMap.has(modelId)) {
      modelMap.set(modelId, MODEL_INFO_MAP[modelId] || buildSyntheticModel(agentType, modelId));
    }
  }
  return Array.from(modelMap.values());
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
