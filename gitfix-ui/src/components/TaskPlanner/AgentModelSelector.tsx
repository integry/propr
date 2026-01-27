import React, { useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import { AgentConfig } from '../../api/gitfixApi';
import { ProviderLogo } from '../ui/ProviderLogo';
import { MODEL_INFO_MAP } from '../../config/modelDefinitions';

interface AgentModelSelectorProps {
  agents: AgentConfig[];
  selectedAgent: string | null;
  selectedModel: string | null;
  onAgentChange: (agentAlias: string | null) => void;
  onModelChange: (modelName: string | null) => void;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
}

export const AgentModelSelector: React.FC<AgentModelSelectorProps> = ({
  agents,
  selectedAgent,
  selectedModel,
  onAgentChange,
  onModelChange,
  disabled = false,
  compact = false,
  className = ''
}) => {
  // Get enabled agents only
  const enabledAgents = useMemo(() =>
    agents.filter(agent => agent.enabled),
    [agents]
  );

  // Get models for the selected agent
  const availableModels = useMemo(() => {
    if (!selectedAgent) return [];
    const agent = enabledAgents.find(a => a.alias === selectedAgent);
    return agent?.supportedModels || [];
  }, [selectedAgent, enabledAgents]);

  // When agent changes, reset model or set to default
  const handleAgentChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newAgent = e.target.value || null;
    onAgentChange(newAgent);

    if (newAgent) {
      const agent = enabledAgents.find(a => a.alias === newAgent);
      if (agent?.defaultModel) {
        onModelChange(agent.defaultModel);
      } else if (agent?.supportedModels?.length) {
        onModelChange(agent.supportedModels[0]);
      } else {
        onModelChange(null);
      }
    } else {
      onModelChange(null);
    }
  };

  const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onModelChange(e.target.value || null);
  };

  // Get display name for model
  const getModelDisplayName = (modelId: string): string => {
    const modelInfo = MODEL_INFO_MAP[modelId];
    return modelInfo?.name || modelId;
  };

  const selectBaseClass = compact
    ? 'text-xs px-2 py-1 pr-6'
    : 'text-sm px-3 py-1.5 pr-8';

  const selectClass = `
    ${selectBaseClass}
    appearance-none
    bg-white
    border border-gray-300
    rounded-md
    focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500
    disabled:bg-gray-100 disabled:text-gray-500 disabled:cursor-not-allowed
    transition-colors
  `.trim();

  if (enabledAgents.length === 0) {
    return (
      <div className={`text-sm text-gray-500 italic ${className}`}>
        No agents configured
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {/* Agent Selector */}
      <div className="relative">
        <div className="absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none">
          {selectedAgent ? (
            <ProviderLogo
              provider={selectedAgent}
              className={compact ? "w-3 h-3" : "w-4 h-4"}
            />
          ) : null}
        </div>
        <select
          value={selectedAgent || ''}
          onChange={handleAgentChange}
          disabled={disabled}
          className={`${selectClass} ${selectedAgent ? (compact ? 'pl-6' : 'pl-8') : ''}`}
          title="Select AI agent"
        >
          <option value="">Select Agent</option>
          {enabledAgents.map(agent => (
            <option key={agent.id} value={agent.alias}>
              {agent.alias}
            </option>
          ))}
        </select>
        <ChevronDown
          className={`absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400 ${compact ? 'w-3 h-3' : 'w-4 h-4'}`}
        />
      </div>

      {/* Model Selector */}
      {selectedAgent && availableModels.length > 0 && (
        <div className="relative">
          <select
            value={selectedModel || ''}
            onChange={handleModelChange}
            disabled={disabled}
            className={selectClass}
            title="Select model"
          >
            <option value="">Select Model</option>
            {availableModels.map(modelId => (
              <option key={modelId} value={modelId}>
                {getModelDisplayName(modelId)}
              </option>
            ))}
          </select>
          <ChevronDown
            className={`absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400 ${compact ? 'w-3 h-3' : 'w-4 h-4'}`}
          />
        </div>
      )}
    </div>
  );
};

export default AgentModelSelector;
