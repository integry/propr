import React from 'react';
import { ChevronDown, Users, Check } from 'lucide-react';
import { AgentConfig } from '../../api/gitfixApi';
import { AgentModelPair } from '../../api/planIssuesApi';
import { ProviderLogo } from '../ui/ProviderLogo';
import {
  AgentModelPairWithDisplay,
  getModelDisplayName,
  getSelectClass,
  getMultiButtonLabel
} from './agentModelSelectorUtils';

interface MultiDropdownItemProps {
  pair: AgentModelPairWithDisplay;
  isSelected: boolean;
  onToggle: (pair: AgentModelPair) => void;
}

const MultiDropdownItem: React.FC<MultiDropdownItemProps> = ({ pair, isSelected, onToggle }) => (
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
      onChange={() => onToggle(pair)}
    />
    <ProviderLogo provider={pair.agent_alias} className="w-3.5 h-3.5" />
    <span className="text-sm text-gray-700 truncate">
      {pair.displayName}
    </span>
  </label>
);

interface SelectedModelsChipsProps {
  selectedModels: AgentModelPair[];
}

const SelectedModelsChips: React.FC<SelectedModelsChipsProps> = ({ selectedModels }) => (
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
);

interface MultiSelectModeProps {
  compact: boolean;
  disabled: boolean;
  className: string;
  selectedModels: AgentModelPair[];
  allAgentModelPairs: AgentModelPairWithDisplay[];
  multiDropdownOpen: boolean;
  setMultiDropdownOpen: (open: boolean) => void;
  onMultiModelToggle: (pair: AgentModelPair) => void;
  onBackToSingle: () => void;
  onConfirm?: () => void;
}

export const MultiSelectMode: React.FC<MultiSelectModeProps> = ({
  compact,
  disabled,
  className,
  selectedModels,
  allAgentModelPairs,
  multiDropdownOpen,
  setMultiDropdownOpen,
  onMultiModelToggle,
  onBackToSingle,
  onConfirm
}) => (
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
          {getMultiButtonLabel(selectedModels.length)}
        </span>
        <ChevronDown size={compact ? 10 : 12} className="text-indigo-400" />
      </button>

      {multiDropdownOpen && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setMultiDropdownOpen(false)}
          />
          <div className="absolute z-20 mt-1 right-0 w-64 bg-white border border-gray-200 rounded-lg shadow-lg flex flex-col">
            <div className="p-2 border-b border-gray-100 flex-shrink-0">
              <button
                onClick={onBackToSingle}
                className="text-xs text-gray-500 hover:text-gray-700 transition-colors"
              >
                &larr; Back to single agent
              </button>
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              {allAgentModelPairs.map((pair) => {
                const isSelected = selectedModels.some(
                  m => m.agent_alias === pair.agent_alias && m.model_name === pair.model_name
                );
                return (
                  <MultiDropdownItem
                    key={`${pair.agent_alias}-${pair.model_name}`}
                    pair={pair}
                    isSelected={isSelected}
                    onToggle={onMultiModelToggle}
                  />
                );
              })}
              {allAgentModelPairs.length === 0 && (
                <div className="px-3 py-4 text-sm text-gray-400 text-center">
                  No agents available
                </div>
              )}
            </div>
            {onConfirm && selectedModels.length > 0 && (
              <div className="p-2 border-t border-gray-100 flex-shrink-0">
                <button
                  onClick={() => {
                    onConfirm();
                    setMultiDropdownOpen(false);
                  }}
                  className="w-full px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 transition-colors"
                >
                  Apply {selectedModels.length} Agent{selectedModels.length !== 1 ? 's' : ''}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>

    {selectedModels.length > 0 && (
      <SelectedModelsChips selectedModels={selectedModels} />
    )}
  </div>
);

interface SingleSelectModeProps {
  compact: boolean;
  disabled: boolean;
  className: string;
  selectedAgent: string | null;
  selectedModel: string | null;
  enabledAgents: AgentConfig[];
  availableModels: string[];
  onAgentChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  onModelChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  showMultiOption: boolean;
}

export const SingleSelectMode: React.FC<SingleSelectModeProps> = ({
  compact,
  disabled,
  className,
  selectedAgent,
  selectedModel,
  enabledAgents,
  availableModels,
  onAgentChange,
  onModelChange,
  showMultiOption
}) => {
  const selectClass = getSelectClass(compact);
  const agentPadding = selectedAgent ? (compact ? 'pl-6' : 'pl-8') : '';

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="relative">
        <div className="absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none">
          {selectedAgent && (
            <ProviderLogo
              provider={selectedAgent}
              className={compact ? "w-3 h-3" : "w-4 h-4"}
            />
          )}
        </div>
        <select
          value={selectedAgent || ''}
          onChange={onAgentChange}
          disabled={disabled}
          className={`${selectClass} ${agentPadding}`}
          title="Select AI agent"
        >
          <option value="">Select Agent</option>
          {enabledAgents.map(agent => (
            <option key={agent.id} value={agent.alias}>
              {agent.alias}
            </option>
          ))}
          {showMultiOption && (
            <option value="__multi__">Assign Multiple Agents</option>
          )}
        </select>
        <ChevronDown
          className={`absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400 ${compact ? 'w-3 h-3' : 'w-4 h-4'}`}
        />
      </div>

      {selectedAgent && availableModels.length > 0 && (
        <div className="relative">
          <select
            value={selectedModel || ''}
            onChange={onModelChange}
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
