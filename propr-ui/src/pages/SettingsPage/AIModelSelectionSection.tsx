import React from 'react';
// CI trigger
import { Brain, ClipboardCheck, Cpu } from 'lucide-react';
import { DEFAULT_REVIEW_GUIDANCE } from '@propr/shared';
import { AgentConfig, SummarizationSettings } from '../../api/proprApi';
import type { InstanceCatalogAgent } from '@propr/shared';
import {
  buildAllModelOptions,
  buildSummarizationOptions,
  buildContextAnalysisOptions,
  buildPlanGenerationOptions,
  buildPrReviewOptions,
  buildImplementationAgentOptions
} from './modelSelectionHelpers';
import { buildReasoningLevelSelectOptions, formatReasoningLevelOption } from './reasoningLevelOptions';
import ReviewContextSettings from './ReviewContextSettings';
import { pathWithActiveHostedTunnelFlow } from '../../config/runtimeConfig';
import { SettingsField, SettingsSection } from './SettingsLayout';
import { SETTINGS_CONTROL } from './settingsStyles';

interface AIModelSelectionSettings {
  analysis_model_fast: string;
  planner_context_model: string;
  planner_generation_model: string;
  default_agent_alias: string;
  model_reasoning_level: string;
  pr_review_model: string;
  pr_review_prompt: string;
  pr_review_context_enabled: boolean;
  pr_review_context_model: string;
  pr_review_max_context_tokens: number;
  pr_review_context_budget_percent: number;
}

interface AIModelSelectionSectionProps {
  settings: AIModelSelectionSettings;
  summarizationSettings: SummarizationSettings;
  agents: AgentConfig[];
  /** Operational direct and synthetic agents exposed by the instance catalog. */
  catalogAgents?: InstanceCatalogAgent[];
  onSettingChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  onReviewPromptChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onReviewPromptBlur: () => void;
  onReviewContextEnabledChange: (enabled: boolean) => void;
  onReviewContextBudgetPercentChange: (percent: number) => void;
  onReviewContextBudgetPercentCommit: (percent: number) => void;
  onRemoveLegacyReviewCap: () => void;
  onSummarizationModelChange: (agentAlias: string) => void;
  onSummarizationFallbackModelChange: (agentAlias: string) => void;
  onDefaultAgentChange: (agentAlias: string) => void;
  className?: string;
}

// eslint-disable-next-line react-refresh/only-export-components
export const buildAiAgentsSettingsHref = (hostname = typeof window !== 'undefined' ? window.location.hostname : ''): string =>
  pathWithActiveHostedTunnelFlow('/ai-agents', hostname);

const NoAgentsMessage = ({ label }: { label: string }) => (
  <p className="text-[12px] leading-5 text-amber-700">
    No {label} available. Enable an agent on the{' '}
    <a href={buildAiAgentsSettingsHref()} className="font-medium underline hover:text-amber-800">
      AI Agents
    </a>{' '}
    page first.
  </p>
);

const AIModelSelectionSection: React.FC<AIModelSelectionSectionProps> = ({
  settings,
  summarizationSettings,
  agents,
  catalogAgents,
  onSettingChange,
  onReviewPromptChange,
  onReviewPromptBlur,
  onReviewContextEnabledChange,
  onReviewContextBudgetPercentChange,
  onReviewContextBudgetPercentCommit,
  onRemoveLegacyReviewCap,
  onSummarizationModelChange,
  onSummarizationFallbackModelChange,
  onDefaultAgentChange,
  className
}) => {
  // Older servers do not expose the instance catalog. Keep the direct-agent
  // list as a compatibility fallback, but prefer the catalog so virtual
  // models are selectable anywhere a routed model is accepted.
  const modelAgents = catalogAgents?.length ? catalogAgents : agents;
  const enabledModelAgents = modelAgents.filter(a => a.enabled);
  const modelOptions = buildAllModelOptions(modelAgents);
  const enabledOptions = modelOptions.filter(opt => opt.enabled);
  const disabledOptions = modelOptions.filter(opt => !opt.enabled);
  const summarizationOptions = buildSummarizationOptions(enabledModelAgents);
  const fallbackValue = summarizationSettings.fallback_agent_alias || '';
  const fallbackSummarizationOptions = buildFallbackSummarizationOptions(
    summarizationOptions.filter(opt => opt.value !== summarizationSettings.agent_alias),
    summarizationOptions,
    fallbackValue
  );
  const contextAnalysisOptions = buildContextAnalysisOptions(enabledModelAgents);
  const planGenerationOptions = buildPlanGenerationOptions(enabledModelAgents);
  const prReviewOptions = buildPrReviewOptions(enabledModelAgents);
  const implementationAgentOptions = buildImplementationAgentOptions(enabledModelAgents);
  const reasoningLevelOptions = buildReasoningLevelSelectOptions(settings.model_reasoning_level);

  const hasAgents = modelAgents.length > 0;
  const hasEnabledAgents = enabledModelAgents.length > 0;
  const summarizationWarning = summarizationSettings.runtime?.warning?.message;

  return (
    <div className={`space-y-10 ${className || ''}`}>
      <SettingsSection title="Implementation" icon={<Cpu aria-hidden="true" className="h-3.5 w-3.5 text-slate-400" />}>
        <SettingsField
          label="Default Implementation Agent"
          htmlFor="default_agent_alias"
          helperText="The agent used for code implementation tasks when no specific agent is specified."
        >
          {hasEnabledAgents ? (
            <select
              id="default_agent_alias"
              value={settings.default_agent_alias}
              onChange={(e) => onDefaultAgentChange(e.target.value)}
              className={SETTINGS_CONTROL}
            >
              {implementationAgentOptions.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}{opt.isRecommended ? ' (Recommended)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <NoAgentsMessage label="enabled agents" />
          )}
        </SettingsField>

        <SettingsField
          label="Reasoning Level"
          htmlFor="model_reasoning_level"
          helperText="System-wide reasoning effort for supported GPT and Claude agents."
        >
          <select
            id="model_reasoning_level"
            name="model_reasoning_level"
            value={settings.model_reasoning_level}
            onChange={onSettingChange}
            className={SETTINGS_CONTROL}
          >
            <option value="">Agent default</option>
            {reasoningLevelOptions.map(level => (
              <option key={level} value={level}>
                {formatReasoningLevelOption(level)}
              </option>
            ))}
          </select>
        </SettingsField>
      </SettingsSection>

      <SettingsSection title="Planning" icon={<Brain aria-hidden="true" className="h-3.5 w-3.5 text-slate-400" />}>
        <SettingsField
          label="Plan Context Analysis Model"
          htmlFor="planner_context_model"
          helperText="Used for matching prompts to relevant files using semantic analysis."
        >
          {hasEnabledAgents ? (
            <select
              id="planner_context_model"
              name="planner_context_model"
              value={settings.planner_context_model}
              onChange={onSettingChange}
              className={SETTINGS_CONTROL}
            >
              <option value="">Select a model...</option>
              {contextAnalysisOptions.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}{opt.isRecommended ? ' (Recommended)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <NoAgentsMessage label="enabled agents" />
          )}
        </SettingsField>

        <SettingsField
          label="Plan Generation Model"
          htmlFor="planner_generation_model"
          helperText="Used for generating detailed implementation plans from context."
        >
          {hasEnabledAgents ? (
            <select
              id="planner_generation_model"
              name="planner_generation_model"
              value={settings.planner_generation_model}
              onChange={onSettingChange}
              className={SETTINGS_CONTROL}
            >
              <option value="">Select a model...</option>
              {planGenerationOptions.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}{opt.isRecommended ? ' (Recommended)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <NoAgentsMessage label="enabled agents" />
          )}
        </SettingsField>

        <SettingsField
          label="Summarization Model"
          htmlFor="summarization_model"
          helperText="Used to generate file and directory summaries for semantic search."
        >
          {hasEnabledAgents ? (
            <select
              id="summarization_model"
              value={summarizationSettings.agent_alias}
              onChange={(e) => onSummarizationModelChange(e.target.value)}
              className={SETTINGS_CONTROL}
            >
              <option value="">Select a model...</option>
              {summarizationOptions.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}{opt.isRecommended ? ' (Recommended)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <NoAgentsMessage label="enabled agents" />
          )}
        </SettingsField>

        <SettingsField
          label="Summarization Fallback Model"
          htmlFor="summarization_fallback_model"
          helperText="Used once for a summarization batch when the primary model is quota-limited."
        >
          {hasEnabledAgents ? (
            <select
              id="summarization_fallback_model"
              value={summarizationSettings.fallback_agent_alias || ''}
              onChange={(e) => onSummarizationFallbackModelChange(e.target.value)}
              className={SETTINGS_CONTROL}
            >
              <option value="">No fallback model</option>
              {fallbackSummarizationOptions.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}{opt.isRecommended ? ' (Recommended)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <NoAgentsMessage label="enabled agents" />
          )}
        </SettingsField>

        {summarizationWarning && (
          <p className="max-w-2xl text-[12px] leading-5 text-amber-700">{summarizationWarning}</p>
        )}
      </SettingsSection>

      <SettingsSection title="Review" icon={<ClipboardCheck aria-hidden="true" className="h-3.5 w-3.5 text-slate-400" />}>
        <SettingsField
          label="Default PR Review Model"
          htmlFor="pr_review_model"
          helperText="The model used to review pull requests and provide feedback."
        >
          {hasEnabledAgents ? (
            <select
              id="pr_review_model"
              name="pr_review_model"
              value={settings.pr_review_model}
              onChange={onSettingChange}
              className={SETTINGS_CONTROL}
            >
              <option value="">Use default agent model</option>
              {prReviewOptions.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}{opt.isRecommended ? ' (Recommended)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <NoAgentsMessage label="enabled agents" />
          )}
        </SettingsField>

        <ReviewContextSettings
          settings={settings}
          agents={modelAgents}
          budgetAgents={agents}
          catalogAgents={catalogAgents}
          onSettingChange={onSettingChange}
          onEnabledChange={onReviewContextEnabledChange}
          onBudgetPercentChange={onReviewContextBudgetPercentChange}
          onBudgetPercentCommit={onReviewContextBudgetPercentCommit}
          onRemoveLegacyCap={onRemoveLegacyReviewCap}
        />

        <SettingsField
          label="Review Prompt"
          htmlFor="pr_review_prompt"
          helperText="Override for the review task guidance. Prefilled with the built-in default so you can see what's customizable — edit it to change the guidance. Clear the field to fall back to the built-in default. The required output sections (Overall Evaluation, Findings, Score) are always appended automatically."
        >
          <textarea
            id="pr_review_prompt"
            name="pr_review_prompt"
            value={settings.pr_review_prompt || DEFAULT_REVIEW_GUIDANCE}
            onChange={onReviewPromptChange}
            onBlur={onReviewPromptBlur}
            rows={6}
            maxLength={20000}
            className={`${SETTINGS_CONTROL} font-mono`}
          />
        </SettingsField>

        <SettingsField
          label="Post-Implementation Analysis Model"
          htmlFor="analysis_model_fast"
          helperText="Analyzes the agent run, prompt, and diff after implementation. This is not used for PR review."
        >
          {hasAgents ? (
            <select
              id="analysis_model_fast"
              name="analysis_model_fast"
              value={settings.analysis_model_fast}
              onChange={onSettingChange}
              className={SETTINGS_CONTROL}
            >
              <option value="">Select a model...</option>
              {enabledOptions.length > 0 && (
                <optgroup label="Enabled Agents">
                  {enabledOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </optgroup>
              )}
              {disabledOptions.length > 0 && (
                <optgroup label="Disabled Agents">
                  {disabledOptions.map(opt => (
                    <option key={opt.value} value={opt.value} disabled>{opt.label}</option>
                  ))}
                </optgroup>
              )}
            </select>
          ) : (
            <NoAgentsMessage label="agents configured" />
          )}
        </SettingsField>
      </SettingsSection>
    </div>
  );
};

function buildFallbackSummarizationOptions(
  options: ReturnType<typeof buildSummarizationOptions>,
  allOptions: ReturnType<typeof buildSummarizationOptions>,
  fallbackValue: string
): ReturnType<typeof buildSummarizationOptions> {
  if (!fallbackValue || options.some(opt => opt.value === fallbackValue)) return options;
  const selectedOption = allOptions.find(opt => opt.value === fallbackValue) || {
    value: fallbackValue,
    label: `Saved fallback (${fallbackValue})`,
    enabled: true
  };
  return [selectedOption, ...options];
}

export default AIModelSelectionSection;
