import React from 'react';
import { AgentConfig, SummarizationSettings } from '../../api/gitfixApi';
import { MODEL_INFO_MAP } from '../../config/modelDefinitions';

interface AIModelSelectionSettings {
  analysis_model_fast: string;
  analysis_model_advanced: string;
  planner_model: string;
}

interface AIModelSelectionSectionProps {
  settings: AIModelSelectionSettings;
  summarizationSettings: SummarizationSettings;
  agents: AgentConfig[];
  onSettingChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  onSummarizationModelChange: (agentAlias: string) => void;
  className?: string;
}

interface ModelOption {
  value: string;
  label: string;
  enabled: boolean;
  isRecommended?: boolean;
}

// Models recommended for summarization (cost-effective options)
const RECOMMENDED_SUMMARIZATION_ALIASES = ['haiku', 'flash', 'flash-lite', 'gpt5-mini', 'o4-mini'];

// Models recommended for planning (high capability options)
const RECOMMENDED_PLANNER_ALIASES = ['opus', 'sonnet', 'gpt-5.2', 'gemini-3-pro'];

const AIModelSelectionSection: React.FC<AIModelSelectionSectionProps> = ({
  settings,
  summarizationSettings,
  agents,
  onSettingChange,
  onSummarizationModelChange,
  className
}) => {
  // Helper to get pretty name from MODEL_INFO_MAP
  const getModelLabel = (agentAlias: string, modelId: string) => {
    const info = MODEL_INFO_MAP[modelId];
    return info ? `${agentAlias} - ${info.name}` : `${agentAlias} - ${modelId}`;
  };

  // Check if a model is recommended for summarization
  const isRecommendedForSummarization = (modelId: string) => {
    const info = MODEL_INFO_MAP[modelId];
    return info && RECOMMENDED_SUMMARIZATION_ALIASES.includes(info.shortAlias);
  };

  // Check if a model is recommended for planning
  const isRecommendedForPlanning = (modelId: string) => {
    const info = MODEL_INFO_MAP[modelId];
    return info && RECOMMENDED_PLANNER_ALIASES.includes(info.shortAlias);
  };

  // Generate model options from agents with human-readable names
  const modelOptions: ModelOption[] = agents.flatMap(agent =>
    agent.supportedModels.map(model => ({
      value: `${agent.alias}:${model}`,
      label: getModelLabel(agent.alias, model),
      enabled: agent.enabled
    }))
  );

  const enabledOptions = modelOptions.filter(opt => opt.enabled);
  const disabledOptions = modelOptions.filter(opt => !opt.enabled);

  // Get only enabled agents for summarization dropdown
  const enabledAgents = agents.filter(a => a.enabled);

  // Model options for summarization (only enabled agents, sorted by recommendation)
  const summarizationOptions: ModelOption[] = enabledAgents.flatMap(agent =>
    agent.supportedModels.map(model => ({
      value: `${agent.alias}:${model}`,
      label: getModelLabel(agent.alias, model),
      enabled: agent.enabled,
      isRecommended: isRecommendedForSummarization(model)
    }))
  ).sort((a, b) => {
    if (a.isRecommended && !b.isRecommended) return -1;
    if (!a.isRecommended && b.isRecommended) return 1;
    return 0;
  });

  // Model options for planner (only enabled agents, sorted by recommendation)
  const plannerOptions: ModelOption[] = enabledAgents.flatMap(agent =>
    agent.supportedModels.map(model => ({
      value: `${agent.alias}:${model}`,
      label: getModelLabel(agent.alias, model),
      enabled: agent.enabled,
      isRecommended: isRecommendedForPlanning(model)
    }))
  ).sort((a, b) => {
    if (a.isRecommended && !b.isRecommended) return -1;
    if (!a.isRecommended && b.isRecommended) return 1;
    return 0;
  });

  const hasAgents = agents.length > 0;
  const hasEnabledAgents = enabledAgents.length > 0;

  return (
    <div className={`bg-white shadow rounded-lg p-6 ${className || ''}`}>
      <h3 className="text-gray-900 text-lg font-medium mb-2">AI Model Selection</h3>
      <p className="text-sm text-gray-500 mb-4">
        Configure which AI models to use for different tasks.
      </p>

      <div className="space-y-4">
        {/* Fast Analysis Model */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="analysis_model_fast">
            Fast Analysis Model
          </label>
          {hasAgents ? (
            <select
              id="analysis_model_fast"
              name="analysis_model_fast"
              value={settings.analysis_model_fast}
              onChange={onSettingChange}
              className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm px-3 py-2 border"
            >
              <option value="">Select a model...</option>
              {enabledOptions.length > 0 && (
                <optgroup label="Enabled Agents">
                  {enabledOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </optgroup>
              )}
              {disabledOptions.length > 0 && (
                <optgroup label="Disabled Agents">
                  {disabledOptions.map(opt => (
                    <option key={opt.value} value={opt.value} disabled>
                      {opt.label}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          ) : (
            <div className="text-sm text-gray-500 p-3 bg-gray-50 rounded-md border border-gray-200">
              No agents configured. Please add an agent in the{' '}
              <a href="/agents" className="text-primary-600 hover:text-primary-700 underline">
                AI Agents
              </a>{' '}
              page first.
            </div>
          )}
          <p className="mt-1 text-sm text-gray-500">
            Used for initial triage and quick tasks.
          </p>
        </div>

        {/* Advanced Analysis Model */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="analysis_model_advanced">
            Advanced Analysis Model
          </label>
          {hasAgents ? (
            <select
              id="analysis_model_advanced"
              name="analysis_model_advanced"
              value={settings.analysis_model_advanced}
              onChange={onSettingChange}
              className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm px-3 py-2 border"
            >
              <option value="">Select a model...</option>
              {enabledOptions.length > 0 && (
                <optgroup label="Enabled Agents">
                  {enabledOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </optgroup>
              )}
              {disabledOptions.length > 0 && (
                <optgroup label="Disabled Agents">
                  {disabledOptions.map(opt => (
                    <option key={opt.value} value={opt.value} disabled>
                      {opt.label}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          ) : (
            <div className="text-sm text-gray-500 p-3 bg-gray-50 rounded-md border border-gray-200">
              No agents configured. Please add an agent in the{' '}
              <a href="/agents" className="text-primary-600 hover:text-primary-700 underline">
                AI Agents
              </a>{' '}
              page first.
            </div>
          )}
          <p className="mt-1 text-sm text-gray-500">
            Used for deep-dive analysis and complex planning.
          </p>
        </div>

        {/* AI Planner Model */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="planner_model">
            AI Planner Model
          </label>
          {hasEnabledAgents ? (
            <select
              id="planner_model"
              name="planner_model"
              value={settings.planner_model}
              onChange={onSettingChange}
              className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm px-3 py-2 border"
            >
              <option value="">Select a model...</option>
              {plannerOptions.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                  {opt.isRecommended ? ' (Recommended)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <div className="text-sm text-gray-500 p-3 bg-gray-50 rounded-md border border-gray-200">
              No enabled agents available. Please enable an agent in the{' '}
              <a href="/agents" className="text-primary-600 hover:text-primary-700 underline">
                AI Agents
              </a>{' '}
              page first.
            </div>
          )}
          <p className="mt-1 text-sm text-gray-500">
            Used for task planning and generating implementation plans.
            {hasEnabledAgents && (
              <span className="block mt-1">
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                  Recommended
                </span>
                {' '}models are high-capability models best suited for complex planning tasks.
              </span>
            )}
          </p>
        </div>

        {/* Summarization Model */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="summarization_model">
            Summarization Model
          </label>
          {hasEnabledAgents ? (
            <select
              id="summarization_model"
              value={summarizationSettings.agent_alias}
              onChange={(e) => onSummarizationModelChange(e.target.value)}
              className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm px-3 py-2 border"
            >
              <option value="">Select a model...</option>
              {summarizationOptions.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                  {opt.isRecommended ? ' (Recommended)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <div className="text-sm text-gray-500 p-3 bg-gray-50 rounded-md border border-gray-200">
              No enabled agents available. Please enable an agent in the{' '}
              <a href="/agents" className="text-primary-600 hover:text-primary-700 underline">
                AI Agents
              </a>{' '}
              page first.
            </div>
          )}
          <p className="mt-1 text-sm text-gray-500">
            Used to generate file and directory summaries for semantic search.
            {hasEnabledAgents && (
              <span className="block mt-1">
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                  Recommended
                </span>
                {' '}models are optimized for speed and cost-effectiveness.
              </span>
            )}
          </p>
        </div>
      </div>
    </div>
  );
};

export default AIModelSelectionSection;
