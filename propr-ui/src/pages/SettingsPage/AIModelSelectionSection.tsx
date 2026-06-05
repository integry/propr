import React from 'react';
// CI trigger
import { Brain, ClipboardCheck, Cpu } from 'lucide-react';
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
  pr_review_model: string;
}

interface AIModelSelectionSectionProps {
  settings: AIModelSelectionSettings;
  summarizationSettings: SummarizationSettings;
  agents: AgentConfig[];
  onSettingChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  onSummarizationModelChange: (agentAlias: string) => void;
  onDefaultAgentChange: (agentAlias: string) => void;
  className?: string;
}

const NoAgentsMessage = ({ label }: { label: string }) => (
  <div className="text-xs text-gray-500 p-2.5 bg-gray-50 rounded border border-gray-200">
    No {label} available. Please enable an agent in the{' '}
    <a href="/agents" className="text-primary-600 hover:text-primary-700 underline">
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
  <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4 items-start">
    <label className="block text-xs font-medium text-gray-600 pt-1.5" htmlFor={htmlFor}>
      {label}
    </label>
    <div>
      {children}
      <p className="mt-1 text-[11px] text-slate-500">{helperText}</p>
    </div>
  </div>
);

const AIModelSelectionSection: React.FC<AIModelSelectionSectionProps> = ({
  settings,
  summarizationSettings,
  agents,
  onSettingChange,
  onSummarizationModelChange,
  onDefaultAgentChange,
  className
}) => {
  const enabledAgents = agents.filter(a => a.enabled);
  const modelOptions = buildAllModelOptions(agents);
  const enabledOptions = modelOptions.filter(opt => opt.enabled);
  const disabledOptions = modelOptions.filter(opt => !opt.enabled);
  const summarizationOptions = buildSummarizationOptions(enabledAgents);
  const contextAnalysisOptions = buildContextAnalysisOptions(enabledAgents);
  const planGenerationOptions = buildPlanGenerationOptions(enabledAgents);
  const prReviewOptions = buildPrReviewOptions(enabledAgents);
  const implementationAgentOptions = buildImplementationAgentOptions(enabledAgents);

  const hasAgents = agents.length > 0;
  const hasEnabledAgents = enabledAgents.length > 0;

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

export default AIModelSelectionSection;
