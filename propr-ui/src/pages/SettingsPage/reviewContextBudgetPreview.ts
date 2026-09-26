import {
  resolveReviewInputCapacity,
  resolveReviewInputCeiling,
  type InstanceCatalogAgent,
  type ReviewInputCapacity,
  type ReviewInputCeiling,
} from '@propr/shared';
import type { AgentConfig } from '../../api/proprApi';
import { getModelLabel } from './modelSelectionHelpers';

export type ReviewBudgetPreviewAgent = Pick<AgentConfig, 'alias' | 'type' | 'enabled' | 'supportedModels' | 'defaultModel' | 'envVars'>;

export interface ReviewerBudgetPreview {
  key: string;
  label: string;
  capacity: ReviewInputCapacity;
  ceiling: ReviewInputCeiling;
}

export type ConfiguredReviewerPreview =
  | { status: 'resolved'; reviewer: ReviewerBudgetPreview }
  | { status: 'unknown'; reason: string };

export interface ReviewBudgetPreviewSettings {
  pr_review_model: string;
  default_agent_alias: string;
  pr_review_context_budget_percent: number;
  pr_review_max_context_tokens: number;
}

function splitModelValue(value: string): { alias: string; model: string } | null {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return null;
  return { alias: value.slice(0, separator), model: value.slice(separator + 1) };
}

function buildPreview(agent: ReviewBudgetPreviewAgent, model: string, settings: ReviewBudgetPreviewSettings): ReviewerBudgetPreview {
  const capacity = resolveReviewInputCapacity({ agentType: agent.type, model, runtimeEnv: agent.envVars });
  return {
    key: `${agent.alias}:${model}`,
    label: getModelLabel(agent.alias, model),
    capacity,
    ceiling: resolveReviewInputCeiling(capacity.safeInputTokens, {
      percent: settings.pr_review_context_budget_percent,
      legacyMaxContextTokens: settings.pr_review_max_context_tokens,
    }),
  };
}

/**
 * Preview the configured default reviewer. Synthetic (routed) models and
 * unresolved defaults are reported as unknown: their physical model is only
 * chosen when a review runs, so no precise allowance can be shown.
 */
export function resolveConfiguredReviewerPreview(
  settings: ReviewBudgetPreviewSettings,
  agents: ReviewBudgetPreviewAgent[],
  catalogAgents: InstanceCatalogAgent[] = [],
): ConfiguredReviewerPreview {
  const parsed = settings.pr_review_model ? splitModelValue(settings.pr_review_model) : null;
  const alias = parsed?.alias ?? settings.default_agent_alias;
  if (!alias) {
    return { status: 'unknown', reason: 'The review model is chosen automatically when a review runs.' };
  }
  if (catalogAgents.some(agent => agent.alias === alias && agent.kind === 'synthetic')) {
    return { status: 'unknown', reason: 'This routed model picks a physical reviewer when a review runs; each reviewer uses its own budget.' };
  }
  const agent = agents.find(candidate => candidate.alias === alias);
  const model = parsed?.model ?? agent?.defaultModel;
  if (!agent || !model) {
    return { status: 'unknown', reason: 'The review model is resolved when a review runs.' };
  }
  return { status: 'resolved', reviewer: buildPreview(agent, model, settings) };
}

/** Allowance for every enabled direct reviewer model, largest first, one row per distinct capacity. */
export function buildReviewerBudgetPreviews(
  settings: ReviewBudgetPreviewSettings,
  agents: ReviewBudgetPreviewAgent[],
): ReviewerBudgetPreview[] {
  const previews = agents
    .filter(agent => agent.enabled)
    .flatMap(agent => agent.supportedModels.map(model => buildPreview(agent, model, settings)));
  return previews.sort((a, b) => b.ceiling.ceiling - a.ceiling.ceiling || a.label.localeCompare(b.label));
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(tokens % 1000000 === 0 ? 0 : 2)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000).toLocaleString('en-US')}K`;
  return tokens.toLocaleString('en-US');
}

export function describeCapacitySource(capacity: ReviewInputCapacity): string {
  switch (capacity.source) {
    case 'runtime-verified': return 'verified runtime window';
    case 'catalog': return 'model catalog window, runtime unverified';
    default: return 'conservative fallback window';
  }
}
