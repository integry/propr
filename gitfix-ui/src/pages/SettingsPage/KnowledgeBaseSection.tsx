import React from 'react';
import { AgentConfig, SummarizationSettings } from '../../api/gitfixApi';
import { MODEL_INFO_MAP } from '../../config/modelDefinitions';

interface KnowledgeBaseSectionProps {
  settings: SummarizationSettings;
  agents: AgentConfig[];
  onSettingsChange: (settings: SummarizationSettings) => void;
  className?: string;
}

// Models recommended for summarization (cost-effective options)
const RECOMMENDED_MODEL_ALIASES = ['haiku', 'flash', 'flash-lite', 'gpt5-mini', 'o4-mini'];

const KnowledgeBaseSection: React.FC<KnowledgeBaseSectionProps> = ({
  settings,
  agents,
  onSettingsChange,
  className
}) => {
  // Helper to get pretty name from MODEL_INFO_MAP
  const getModelLabel = (agentAlias: string, modelId: string) => {
    const info = MODEL_INFO_MAP[modelId];
    return info ? `${agentAlias} - ${info.name}` : `${agentAlias} - ${modelId}`;
  };

  // Check if a model is recommended (cheap/fast)
  const isRecommendedModel = (modelId: string) => {
    const info = MODEL_INFO_MAP[modelId];
    return info && RECOMMENDED_MODEL_ALIASES.includes(info.shortAlias);
  };

  // Generate model options from agents - list all models from all enabled agents
  interface ModelOption {
    value: string; // agent_alias:model format (same as analysis model dropdowns)
    label: string;
    enabled: boolean;
    isRecommended: boolean;
    agentType: string;
    modelId: string;
  }

  // Get only enabled agents
  const enabledAgents = agents.filter(a => a.enabled);

  // List ALL models from all enabled agents (matching the analysis model dropdowns behavior)
  const modelOptions: ModelOption[] = enabledAgents.flatMap(agent =>
    agent.supportedModels.map(model => ({
      value: `${agent.alias}:${model}`,
      label: getModelLabel(agent.alias, model),
      enabled: agent.enabled,
      isRecommended: isRecommendedModel(model),
      agentType: agent.type,
      modelId: model
    }))
  );

  // Sort so recommended models come first
  const sortedOptions = [...modelOptions].sort((a, b) => {
    if (a.isRecommended && !b.isRecommended) return -1;
    if (!a.isRecommended && b.isRecommended) return 1;
    return 0;
  });

  const hasAgents = enabledAgents.length > 0;

  const handleToggleEnabled = () => {
    onSettingsChange({
      ...settings,
      enabled: !settings.enabled
    });
  };

  const handleAgentChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onSettingsChange({
      ...settings,
      agent_alias: e.target.value
    });
  };

  const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onSettingsChange({
      ...settings,
      custom_prompt: e.target.value
    });
  };

  return (
    <div className={`bg-white shadow rounded-lg p-6 ${className || ''}`}>
      <h3 className="text-gray-900 text-lg font-medium mb-4">Knowledge Base</h3>
      <p className="text-sm text-gray-500 mb-4">
        Configure codebase indexing to enable semantic search across your repositories.
      </p>

      <div className="space-y-4">
        {/* Enable Toggle */}
        <div className="flex items-start">
          <div className="flex items-center h-5">
            <input
              type="checkbox"
              id="summarization_enabled"
              checked={settings.enabled}
              onChange={handleToggleEnabled}
              className="h-4 w-4 cursor-pointer rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            />
          </div>
          <div className="ml-3">
            <label
              htmlFor="summarization_enabled"
              className="text-sm font-medium text-gray-700 cursor-pointer"
            >
              Enable Semantic Codebase Indexing
            </label>
            <p className="text-sm text-gray-500">
              Allows AI to search your codebase by meaning, not just filenames. Requires a configured Agent.
            </p>
          </div>
        </div>

        {/* Agent Selection */}
        <div className={settings.enabled ? '' : 'opacity-50 pointer-events-none'}>
          <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="summarization_agent">
            Summarization Model
          </label>
          {hasAgents ? (
            <select
              id="summarization_agent"
              value={settings.agent_alias}
              onChange={handleAgentChange}
              disabled={!settings.enabled}
              className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm px-3 py-2 border disabled:bg-gray-100 disabled:cursor-not-allowed"
            >
              <option value="">Select an agent...</option>
              {sortedOptions.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                  {opt.isRecommended ? ' (Recommended)' : ''}
                </option>
              ))}
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
            The agent used to generate file and directory summaries.
            {hasAgents && (
              <span className="block mt-1">
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                  Recommended
                </span>
                {' '}models are optimized for speed and cost-effectiveness.
              </span>
            )}
          </p>
        </div>

        {/* Custom Prompt */}
        <div className={settings.enabled ? '' : 'opacity-50 pointer-events-none'}>
          <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="custom_prompt">
            Custom Summary Prompt (Optional)
          </label>
          <textarea
            id="custom_prompt"
            value={settings.custom_prompt || ''}
            onChange={handlePromptChange}
            rows={3}
            className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm px-3 py-2 border disabled:bg-gray-100 disabled:cursor-not-allowed"
            placeholder="Override the default summarization instructions. E.g., 'Focus on security vulnerabilities and data flow...'"
            disabled={!settings.enabled}
          />
          <p className="mt-1 text-sm text-gray-500">
            Define specific goals for the AI when summarizing files. The output format is automatically enforced.
          </p>
        </div>

        {/* Warning if enabled but no agent selected */}
        {settings.enabled && !settings.agent_alias && hasAgents && (
          <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-md">
            <div className="flex">
              <svg className="h-5 w-5 text-yellow-400 mr-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <p className="text-sm text-yellow-700">
                Please select a summarization model to enable indexing.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default KnowledgeBaseSection;
