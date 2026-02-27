import React, { useMemo, useState, useEffect } from 'react';
import { AgentConfig } from '../../api/proprApi';
import { AgentModelPair } from '../../api/planIssuesApi';
import { MODEL_INFO_MAP } from '../../config/modelDefinitions';
import { AgentModelPairWithDisplay } from './agentModelSelectorUtils';
import { MultiSelectMode, SingleSelectMode } from './AgentModelSelectorParts';

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
  /** Callback when user confirms multi-selection */
  onMultiConfirm?: () => void;
  /** Automatically open the multi-select dropdown when switching to multi mode */
  autoOpenMultiDropdown?: boolean;
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
  onMultiModelChange,
  onMultiConfirm,
  autoOpenMultiDropdown = false
}) => {
  const [multiDropdownOpen, setMultiDropdownOpen] = useState(autoOpenMultiDropdown && isMulti);

  // Auto-open dropdown when switching to multi mode
  useEffect(() => {
    if (isMulti && autoOpenMultiDropdown) {
      setMultiDropdownOpen(true);
    }
  }, [isMulti, autoOpenMultiDropdown]);

  const enabledAgents = useMemo(() =>
    agents.filter(agent => agent.enabled),
    [agents]
  );

  const availableModels = useMemo(() => {
    if (!selectedAgent) return [];
    const agent = enabledAgents.find(a => a.alias === selectedAgent);
    return agent?.supportedModels || [];
  }, [selectedAgent, enabledAgents]);

  const allAgentModelPairs = useMemo(() => {
    const pairs: AgentModelPairWithDisplay[] = [];
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

  const handleAgentChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;

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

  if (enabledAgents.length === 0) {
    return (
      <div className={`text-sm text-gray-500 italic ${className}`}>
        No agents configured
      </div>
    );
  }

  if (isMulti) {
    return (
      <MultiSelectMode
        compact={compact}
        disabled={disabled}
        className={className}
        selectedModels={selectedModels}
        allAgentModelPairs={allAgentModelPairs}
        multiDropdownOpen={multiDropdownOpen}
        setMultiDropdownOpen={setMultiDropdownOpen}
        onMultiModelToggle={handleMultiModelToggle}
        onBackToSingle={handleBackToSingle}
        onConfirm={onMultiConfirm}
      />
    );
  }

  return (
    <SingleSelectMode
      compact={compact}
      disabled={disabled}
      className={className}
      selectedAgent={selectedAgent}
      selectedModel={selectedModel}
      enabledAgents={enabledAgents}
      availableModels={availableModels}
      onAgentChange={handleAgentChange}
      onModelChange={handleModelChange}
      showMultiOption={!!onMultiToggle && enabledAgents.length > 0}
    />
  );
};

export default AgentModelSelector;
