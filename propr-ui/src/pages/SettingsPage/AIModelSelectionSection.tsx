import React from 'react';
// CI trigger
import { Brain, ClipboardCheck, Cpu } from 'lucide-react';
import { DEFAULT_REVIEW_GUIDANCE, REASONING_LEVELS, getReasoningLevelsForAgentType } from '@propr/shared';
import { AgentConfig, SummarizationSettings } from '../../api/proprApi';
import {
  buildAllModelOptions,
  buildSummarizationOptions,
  buildContextAnalysisOptions,
  buildPlanGenerationOptions,
  buildPrReviewOptions,
  buildImplementationAgentOptions
} from './modelSelectionHelpers';

interface AIModelSelectionSettings {
  analysis_model_fast: string;
  planner_context_model: string;
  planner_generation_model: string;
  default_agent_alias: string;
  model_reasoning_level: string;
  pr_review_model: string;
  pr_review_prompt: string;
}

interface AIModelSelectionSectionProps {
  settings: AIModelSelectionSettings;
  summarizationSettings: SummarizationSettings;
  agents: AgentConfig[];
  onSettingChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  onReviewPromptChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onReviewPromptBlur: () => void;
  onSummarizationModelChange: (agentAlias: string) => void;
  onSummarizationFallbackModelChange: (agentAlias: string) => void;
  onDefaultAgentChange: (agentAlias: string) => void;
  className?: string;
}

const NoAgentsMessage = ({ label }: { label: string }) => (
  <div className="text-xs text-gray-500 p-2.5 bg-gray-50 rounded border border-gray-200">
    No {label} available. Please enable an agent in the{' '}
    <a href="/ai-agents" className="text-primary-600 hover:text-primary-700 underline">
      AI Agents
    </a>{' '}
    page first.
  </div>
);

const SettingRow = ({
  label,
  htmlFor,
  children,
  helperText
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
  helperText: string;
}) => (
  <div className="grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2 md:gap-4 items-start">
    <label className="block text-xs font-medium text-gray-600 md:pt-1.5" htmlFor={htmlFor}>
      {label}
    </label>
    <div>
      {children}
      <p className="mt-1 text-[11px] text-slate-500">{helperText}</p>
    </div>
  </div>
);

const reasoningLevelLabels: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra (Codex only)',
  ultracode: 'Ultracode (Claude only)',
  auto: 'Auto (Claude only)',
};

const AIModelSelectionSection: React.FC<AIModelSelectionSectionProps> = ({
  settings,
  summarizationSettings,
  agents,
  onSettingChange,
  onReviewPromptChange,
  onReviewPromptBlur,
  onSummarizationModelChange,
  onSummarizationFallbackModelChange,
  onDefaultAgentChange,
  className
}) => {
  const enabledAgents = agents.filter(a => a.enabled);
  const modelOptions = buildAllModelOptions(agents);
  const enabledOptions = modelOptions.filter(opt => opt.enabled);
  const disabledOptions = modelOptions.filter(opt => !opt.enabled);
  const summarizationOptions = buildSummarizationOptions(enabledAgents);
  const fallbackValue = summarizationSettings.fallback_agent_alias || '';
  const fallbackSummarizationOptions = buildFallbackSummarizationOptions(
    summarizationOptions.filter(opt => opt.value !== summarizationSettings.agent_alias),
    summarizationOptions,
    fallbackValue
  );
  const contextAnalysisOptions = buildContextAnalysisOptions(enabledAgents);
  const planGenerationOptions = buildPlanGenerationOptions(enabledAgents);
  const prReviewOptions = buildPrReviewOptions(enabledAgents);
  const implementationAgentOptions = buildImplementationAgentOptions(enabledAgents);
  const selectedImplementationAgent = enabledAgents.find(a => a.alias === settings.default_agent_alias) ?? enabledAgents[0];
  const compatibleReasoningLevels = selectedImplementationAgent
    ? getReasoningLevelsForAgentType(selectedImplementationAgent.type)
    : REASONING_LEVELS;
  const reasoningLevelOptions = settings.model_reasoning_level &&
    !compatibleReasoningLevels.includes(settings.model_reasoning_level as typeof REASONING_LEVELS[number])
    ? [...compatibleReasoningLevels, settings.model_reasoning_level]
    : compatibleReasoningLevels;

  const hasAgents = agents.length > 0;
  const hasEnabledAgents = enabledAgents.length > 0;
  const summarizationWarning = summarizationSettings.runtime?.warning?.message;

  return (
    <div className={className || ''}>
      <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-3">Model Selection</h4>

      <div className="space-y-5">
        {/* Implementation Section */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Cpu className="w-4 h-4 text-purple-600" />
            <h5 className="text-xs font-semibold text-gray-900 uppercase tracking-wide">Implementation</h5>
          </div>
          <div className="space-y-3 pl-6">
            <SettingRow
              label="Default Implementation Agent"
              htmlFor="default_agent_alias"
              helperText="The agent used for code implementation tasks when no specific agent is specified."
            >
              {hasEnabledAgents ? (
                <select
                  id="default_agent_alias"
                  value={settings.default_agent_alias}
                  onChange={(e) => onDefaultAgentChange(e.target.value)}
                  className="w-full rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2.5 py-1.5 border"
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
            </SettingRow>

            <SettingRow
              label="Reasoning Level"
              htmlFor="model_reasoning_level"
              helperText="System-wide reasoning effort for supported GPT and Claude agents."
            >
              <select
                id="model_reasoning_level"
                name="model_reasoning_level"
                value={settings.model_reasoning_level}
                onChange={onSettingChange}
                className="w-full rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2.5 py-1.5 border"
              >
                <option value="">Agent default</option>
                {reasoningLevelOptions.map(level => (
                  <option
                    key={level}
                    value={level}
                    disabled={!compatibleReasoningLevels.includes(level as typeof REASONING_LEVELS[number])}
                  >
                    {reasoningLevelLabels[level]}
                  </option>
                ))}
              </select>
            </SettingRow>
          </div>
        </div>

        {/* Planning Section */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Brain className="w-4 h-4 text-blue-600" />
            <h5 className="text-xs font-semibold text-gray-900 uppercase tracking-wide">Planning</h5>
          </div>
          <div className="space-y-3 pl-6">
            <SettingRow
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
                  className="w-full rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2.5 py-1.5 border"
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
            </SettingRow>

            <SettingRow
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
                  className="w-full rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2.5 py-1.5 border"
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
            </SettingRow>

            <SettingRow
              label="Summarization Model"
              htmlFor="summarization_model"
              helperText="Used to generate file and directory summaries for semantic search."
            >
              {hasEnabledAgents ? (
                <select
                  id="summarization_model"
                  value={summarizationSettings.agent_alias}
                  onChange={(e) => onSummarizationModelChange(e.target.value)}
                  className="w-full rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2.5 py-1.5 border"
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
            </SettingRow>

            <SettingRow
              label="Summarization Fallback Model"
              htmlFor="summarization_fallback_model"
              helperText="Used once for a summarization batch when the primary model is quota-limited."
            >
              {hasEnabledAgents ? (
                <select
                  id="summarization_fallback_model"
                  value={summarizationSettings.fallback_agent_alias || ''}
                  onChange={(e) => onSummarizationFallbackModelChange(e.target.value)}
                  className="w-full rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2.5 py-1.5 border"
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
            </SettingRow>

            {summarizationWarning && (
              <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {summarizationWarning}
              </div>
            )}
          </div>
        </div>

        {/* Review Section */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <ClipboardCheck className="w-4 h-4 text-green-600" />
            <h5 className="text-xs font-semibold text-gray-900 uppercase tracking-wide">Review</h5>
          </div>
          <div className="space-y-3 pl-6">
            <SettingRow
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
                  className="w-full rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2.5 py-1.5 border"
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
            </SettingRow>

            <SettingRow
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
                rows={5}
                maxLength={20000}
                className="w-full rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2.5 py-1.5 border font-mono"
              />
            </SettingRow>

            <SettingRow
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
                  className="w-full rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2.5 py-1.5 border"
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
            </SettingRow>
          </div>
        </div>
      </div>
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
