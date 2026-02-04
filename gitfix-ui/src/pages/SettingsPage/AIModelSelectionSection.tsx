import React from 'react';
import { Brain, ClipboardCheck, Cpu } from 'lucide-react';
import { AgentConfig, SummarizationSettings } from '../../api/gitfixApi';
import { MODEL_INFO_MAP } from '../../config/modelDefinitions';

interface AIModelSelectionSettings {
  analysis_model_fast: string;
  planner_context_model: string;
  planner_generation_model: string;
  default_agent_alias: string;
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

interface ModelOption {
  value: string;
  label: string;
  enabled: boolean;
  isRecommended?: boolean;
}

// Models recommended for summarization (cost-effective options)
const RECOMMENDED_SUMMARIZATION_ALIASES = ['haiku', 'flash', 'flash-lite', 'gpt5-mini', 'o4-mini'];

// Models recommended for context analysis (fast, cost-effective options)
const RECOMMENDED_CONTEXT_ANALYSIS_ALIASES = ['haiku', 'flash', 'flash-lite', 'gpt5-mini', 'o4-mini'];

// Models recommended for plan generation (high capability options)
const RECOMMENDED_PLAN_GENERATION_ALIASES = ['opus', 'sonnet', 'gpt-5.2', 'gemini-3-pro'];

// Models recommended for implementation (high capability options)
const RECOMMENDED_IMPLEMENTATION_ALIASES = ['claude'];

const AIModelSelectionSection: React.FC<AIModelSelectionSectionProps> = ({
  settings,
  summarizationSettings,
  agents,
  onSettingChange,
  onSummarizationModelChange,
  onDefaultAgentChange,
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

  // Check if a model is recommended for context analysis
  const isRecommendedForContextAnalysis = (modelId: string) => {
    const info = MODEL_INFO_MAP[modelId];
    return info && RECOMMENDED_CONTEXT_ANALYSIS_ALIASES.includes(info.shortAlias);
  };

  // Check if a model is recommended for plan generation
  const isRecommendedForPlanGeneration = (modelId: string) => {
    const info = MODEL_INFO_MAP[modelId];
    return info && RECOMMENDED_PLAN_GENERATION_ALIASES.includes(info.shortAlias);
  };

  // Check if an agent is recommended for implementation
  const isAgentRecommendedForImplementation = (agentAlias: string) => {
    return RECOMMENDED_IMPLEMENTATION_ALIASES.some(alias =>
      agentAlias.toLowerCase().includes(alias.toLowerCase())
    );
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

  // Model options for context analysis (only enabled agents, sorted by recommendation - faster models)
  const contextAnalysisOptions: ModelOption[] = enabledAgents.flatMap(agent =>
    agent.supportedModels.map(model => ({
      value: `${agent.alias}:${model}`,
      label: getModelLabel(agent.alias, model),
      enabled: agent.enabled,
      isRecommended: isRecommendedForContextAnalysis(model)
    }))
  ).sort((a, b) => {
    if (a.isRecommended && !b.isRecommended) return -1;
    if (!a.isRecommended && b.isRecommended) return 1;
    return 0;
  });

  // Model options for plan generation (only enabled agents, sorted by recommendation - high capability models)
  const planGenerationOptions: ModelOption[] = enabledAgents.flatMap(agent =>
    agent.supportedModels.map(model => ({
      value: `${agent.alias}:${model}`,
      label: getModelLabel(agent.alias, model),
      enabled: agent.enabled,
      isRecommended: isRecommendedForPlanGeneration(model)
    }))
  ).sort((a, b) => {
    if (a.isRecommended && !b.isRecommended) return -1;
    if (!a.isRecommended && b.isRecommended) return 1;
    return 0;
  });

  // Agent options for default implementation agent (only enabled agents, sorted by recommendation)
  interface AgentOption {
    value: string;
    label: string;
    isRecommended: boolean;
  }
  const implementationAgentOptions: AgentOption[] = enabledAgents.map(agent => ({
    value: agent.alias,
    label: agent.alias,
    isRecommended: isAgentRecommendedForImplementation(agent.alias)
  })).sort((a, b) => {
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

      <div className="space-y-6">
        {/* Implementation Section */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Cpu className="w-5 h-5 text-purple-600" />
            <h4 className="text-sm font-semibold text-gray-900">Implementation</h4>
          </div>
          <div className="space-y-4 pl-7">
            {/* Default Implementation Agent */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="default_agent_alias">
                Default Implementation Agent
              </label>
              {hasEnabledAgents ? (
                <select
                  id="default_agent_alias"
                  value={settings.default_agent_alias}
                  onChange={(e) => onDefaultAgentChange(e.target.value)}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm px-3 py-2 border"
                >
                  {implementationAgentOptions.map(opt => (
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
                The agent used for code implementation tasks when no specific agent is specified.
                {hasEnabledAgents && (
                  <span className="block mt-1">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800">
                      Recommended
                    </span>
                    {' '}agents are optimized for code implementation tasks.
                  </span>
                )}
              </p>
            </div>
          </div>
        </div>

        {/* Planning Section */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Brain className="w-5 h-5 text-blue-600" />
            <h4 className="text-sm font-semibold text-gray-900">Planning</h4>
          </div>
          <div className="space-y-4 pl-7">
            {/* Plan Context Analysis Model */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="planner_context_model">
                Plan Context Analysis Model
              </label>
              {hasEnabledAgents ? (
                <select
                  id="planner_context_model"
                  name="planner_context_model"
                  value={settings.planner_context_model}
                  onChange={onSettingChange}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm px-3 py-2 border"
                >
                  <option value="">Select a model...</option>
                  {contextAnalysisOptions.map(opt => (
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
                Used for matching prompts to relevant files using semantic analysis.
                {hasEnabledAgents && (
                  <span className="block mt-1">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                      Recommended
                    </span>
                    {' '}models are fast and cost-effective for context analysis.
                  </span>
                )}
              </p>
            </div>

            {/* Plan Generation Model */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="planner_generation_model">
                Plan Generation Model
              </label>
              {hasEnabledAgents ? (
                <select
                  id="planner_generation_model"
                  name="planner_generation_model"
                  value={settings.planner_generation_model}
                  onChange={onSettingChange}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm px-3 py-2 border"
                >
                  <option value="">Select a model...</option>
                  {planGenerationOptions.map(opt => (
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
                Used for generating detailed implementation plans from context.
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

        {/* Review Section */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <ClipboardCheck className="w-5 h-5 text-green-600" />
            <h4 className="text-sm font-semibold text-gray-900">Review</h4>
          </div>
          <div className="space-y-4 pl-7">
            {/* Post-implementation Analysis Model */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="analysis_model_fast">
                Post-implementation Analysis Model
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
                Analyzes code changes after implementation.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AIModelSelectionSection;
