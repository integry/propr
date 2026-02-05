import React, { useMemo, useState } from 'react';
import { ChevronDown, Users, Check } from 'lucide-react';
import { AgentConfig } from '../../api/gitfixApi';
import { AgentModelPair } from '../../api/planIssuesApi';
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
  /** Multi-select mode support */
  isMulti?: boolean;
  onMultiToggle?: (isMulti: boolean) => void;
  selectedModels?: AgentModelPair[];
  onMultiModelChange?: (models: AgentModelPair[]) => void;
}

export const AgentModelSelector: React.FC<AgentModelSelectorProps> = ({
  agents,
  selectedAgent,
  selectedModel,
  onAgentChange,
  onModelChange,
  disabled = false,
  compact = false,
  className = '',
  isMulti = false,
  onMultiToggle,
  selectedModels = [],
  onMultiModelChange
}) => {
  const [multiDropdownOpen, setMultiDropdownOpen] = useState(false);

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

  // Build all available agent:model pairs for multi-select
  const allAgentModelPairs = useMemo(() => {
    const pairs: (AgentModelPair & { displayName: string })[] = [];
    enabledAgents.forEach(agent => {
      (agent.supportedModels || []).forEach(modelId => {
        const modelInfo = MODEL_INFO_MAP[modelId];
        pairs.push({
          agent_alias: agent.alias,
          model_name: modelId,
          displayName: `${agent.alias} / ${modelInfo?.name || modelId}`
        });
      });
    });
    return pairs;
  }, [enabledAgents]);

  // When agent changes, reset model or set to default
  const handleAgentChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;

    // Handle "Assign Multiple Agents" option
    if (value === '__multi__') {
      onMultiToggle?.(true);
      return;
    }

    const newAgent = value || null;
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

  const handleMultiModelToggle = (pair: AgentModelPair) => {
    if (!onMultiModelChange) return;
    const exists = selectedModels.some(
      m => m.agent_alias === pair.agent_alias && m.model_name === pair.model_name
    );
    if (exists) {
      onMultiModelChange(selectedModels.filter(
        m => !(m.agent_alias === pair.agent_alias && m.model_name === pair.model_name)
      ));
    } else {
      onMultiModelChange([...selectedModels, pair]);
    }
  };

  const handleBackToSingle = () => {
    onMultiToggle?.(false);
    onMultiModelChange?.([]);
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

  // Multi-select mode UI
  if (isMulti) {
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        <div className="relative">
          <button
            onClick={() => !disabled && setMultiDropdownOpen(!multiDropdownOpen)}
            disabled={disabled}
            className={`
              flex items-center gap-1.5
              ${compact ? 'text-xs px-2 py-1' : 'text-sm px-3 py-1.5'}
              bg-white border border-indigo-300 rounded-md
              focus:outline-none focus:ring-2 focus:ring-indigo-500
              disabled:bg-gray-100 disabled:text-gray-500 disabled:cursor-not-allowed
              transition-colors hover:border-indigo-400
            `}
            title="Select multiple agent/model combinations"
          >
            <Users size={compact ? 12 : 14} className="text-indigo-500" />
            <span className="text-indigo-700 font-medium">
              {selectedModels.length === 0
                ? 'Select Agents'
                : `${selectedModels.length} agent${selectedModels.length !== 1 ? 's' : ''}`}
            </span>
            <ChevronDown size={compact ? 10 : 12} className="text-indigo-400" />
          </button>

          {multiDropdownOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setMultiDropdownOpen(false)}
              />
              <div className="absolute z-20 mt-1 right-0 w-64 bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-y-auto">
                <div className="p-2 border-b border-gray-100">
                  <button
                    onClick={handleBackToSingle}
                    className="text-xs text-gray-500 hover:text-gray-700 transition-colors"
                  >
                    &larr; Back to single agent
                  </button>
                </div>
                {allAgentModelPairs.map((pair) => {
                  const isSelected = selectedModels.some(
                    m => m.agent_alias === pair.agent_alias && m.model_name === pair.model_name
                  );
                  return (
                    <label
                      key={`${pair.agent_alias}-${pair.model_name}`}
                      className={`
                        flex items-center gap-2 px-3 py-2 cursor-pointer
                        hover:bg-gray-50 transition-colors
                        ${isSelected ? 'bg-indigo-50' : ''}
                      `}
                    >
                      <div className={`
                        flex items-center justify-center w-4 h-4 rounded border
                        ${isSelected
                          ? 'bg-indigo-600 border-indigo-600'
                          : 'border-gray-300 bg-white'}
                        transition-colors
                      `}>
                        {isSelected && <Check size={12} className="text-white" />}
                      </div>
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={isSelected}
                        onChange={() => handleMultiModelToggle(pair)}
                      />
                      <ProviderLogo provider={pair.agent_alias} className="w-3.5 h-3.5" />
                      <span className="text-sm text-gray-700 truncate">
                        {pair.displayName}
                      </span>
                    </label>
                  );
                })}
                {allAgentModelPairs.length === 0 && (
                  <div className="px-3 py-4 text-sm text-gray-400 text-center">
                    No agents available
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Show selected models summary chips */}
        {selectedModels.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            {selectedModels.map(m => (
              <span
                key={`${m.agent_alias}-${m.model_name}`}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs bg-indigo-50 text-indigo-700 rounded border border-indigo-200"
              >
                <ProviderLogo provider={m.agent_alias} className="w-2.5 h-2.5" />
                {getModelDisplayName(m.model_name)}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Single-select mode (original behavior + "Assign Multiple Agents" option)
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
          {onMultiToggle && enabledAgents.length > 0 && (
            <option value="__multi__">Assign Multiple Agents</option>
          )}
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
