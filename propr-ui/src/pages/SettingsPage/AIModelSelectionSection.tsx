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

// Teal monospace chip for recommended badge
const RecommendedChip = () => (
  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium font-mono bg-teal-100 text-teal-700 uppercase tracking-wide">
    REC
  </span>
);

const NoAgentsMessage = ({ label }: { label: string }) => (
  <div className="text-xs text-gray-500 p-2.5 bg-gray-50 rounded border border-gray-200">
    No {label} available. Please enable an agent in the{' '}
    <a href="/agents" className="text-primary-600 hover:text-primary-700 underline">
      AI Agents
    </a>{' '}
    page first.
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
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor="default_agent_alias">
                Default Implementation Agent
              </label>
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
              <p className="mt-1 text-xs text-gray-500">
                The agent used for code implementation tasks when no specific agent is specified.
                {hasEnabledAgents && (
                  <span className="flex items-center gap-1.5 mt-1">
                    <RecommendedChip />
                    <span>agents are optimized for code implementation tasks.</span>
                  </span>
                )}
              </p>
            </div>
          </div>
        </div>

        {/* Planning Section */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Brain className="w-4 h-4 text-blue-600" />
            <h5 className="text-xs font-semibold text-gray-900 uppercase tracking-wide">Planning</h5>
          </div>
          <div className="space-y-3 pl-6">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor="planner_context_model">
                Plan Context Analysis Model
              </label>
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
              <p className="mt-1 text-xs text-gray-500">
                Used for matching prompts to relevant files using semantic analysis.
                {hasEnabledAgents && (
                  <span className="flex items-center gap-1.5 mt-1">
                    <RecommendedChip />
                    <span>models are fast and cost-effective for context analysis.</span>
                  </span>
                )}
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor="planner_generation_model">
                Plan Generation Model
              </label>
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
              <p className="mt-1 text-xs text-gray-500">
                Used for generating detailed implementation plans from context.
                {hasEnabledAgents && (
                  <span className="flex items-center gap-1.5 mt-1">
                    <RecommendedChip />
                    <span>models are high-capability models best suited for complex planning tasks.</span>
                  </span>
                )}
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor="summarization_model">
                Summarization Model
              </label>
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
              <p className="mt-1 text-xs text-gray-500">
                Used to generate file and directory summaries for semantic search.
                {hasEnabledAgents && (
                  <span className="flex items-center gap-1.5 mt-1">
                    <RecommendedChip />
                    <span>models are optimized for speed and cost-effectiveness.</span>
                  </span>
                )}
              </p>
            </div>
          </div>
        </div>

        {/* Review Section */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <ClipboardCheck className="w-4 h-4 text-green-600" />
            <h5 className="text-xs font-semibold text-gray-900 uppercase tracking-wide">Review</h5>
          </div>
          <div className="space-y-3 pl-6">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor="pr_review_model">
                Default PR Review Model
              </label>
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
              <p className="mt-1 text-xs text-gray-500">
                The model used to review pull requests and provide feedback.
                {hasEnabledAgents && (
                  <span className="flex items-center gap-1.5 mt-1">
                    <RecommendedChip />
                    <span>models are high-capability models best suited for thorough PR reviews.</span>
                  </span>
                )}
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor="analysis_model_fast">
                Post-Implementation Analysis Model
              </label>
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
              <p className="mt-1 text-xs text-gray-500">
                Analyzes the agent run, prompt, and diff after implementation. This is not used for PR review.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AIModelSelectionSection;
