import React from 'react';
import { AgentType } from '../../config/modelDefinitions';
import { buildSelectableModels } from './modelSelectionHelpers';

// GitHub icon component
const GitHubIcon: React.FC<{ className?: string }> = ({ className = "w-4 h-4" }) => (
  <svg className={className} fill="currentColor" viewBox="0 0 24 24">
    <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
  </svg>
);

interface ModelSelectorProps {
  agentType: AgentType;
  supportedModels: string[];
  defaultModel?: string;
  availableModelIds?: string[];
  modelCustomLabels?: Record<string, string>;
  errors: Record<string, string>;
  onModelToggle: (modelId: string) => void;
  onDefaultModelChange: (modelId: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onCustomLabelChange: (modelId: string, label: string) => void;
}

const ModelSelector: React.FC<ModelSelectorProps> = ({
  agentType, supportedModels, defaultModel, availableModelIds = [], modelCustomLabels,
  errors, onModelToggle, onDefaultModelChange, onSelectAll, onDeselectAll, onCustomLabelChange
}) => {
  const models = buildSelectableModels(agentType, [...availableModelIds, ...supportedModels, ...(defaultModel ? [defaultModel] : [])]);

  return <div>
    <div className="flex justify-between items-center mb-1.5">
      <label className="block text-gray-700 font-medium text-sm">
        Supported Models
      </label>
      <div className="flex gap-2">
        <button type="button" onClick={onSelectAll} className="text-xs text-primary-600 hover:text-primary-800 font-medium">
          Select All
        </button>
        <span className="text-gray-300">|</span>
        <button type="button" onClick={onDeselectAll} className="text-xs text-gray-500 hover:text-gray-700 font-medium">
          Deselect All
        </button>
      </div>
    </div>
    <div className={`border rounded-md p-3 bg-gray-50 max-h-80 overflow-y-auto ${
      errors.supportedModels ? 'border-red-500' : 'border-gray-300'
    }`}>
      {models.map(model => {
        const isSupported = supportedModels.includes(model.id);
        const isDefault = defaultModel === model.id;
        const modelCustomLabel = modelCustomLabels?.[model.id] || '';

        return (
          <div key={model.id} className="py-2 px-2 hover:bg-gray-100 rounded">
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={isSupported}
                onChange={() => onModelToggle(model.id)}
                className="h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500 cursor-pointer"
              />
              <input
                type="radio"
                name="defaultModel"
                checked={isDefault}
                disabled={!isSupported}
                onChange={() => onDefaultModelChange(model.id)}
                className="h-4 w-4 text-primary-600 border-gray-300 focus:ring-primary-500 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                title={isSupported ? 'Set as default model' : 'Enable this model to set as default'}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900">{model.name}</span>
                  {model.contextWindow && (
                    <span className="px-1.5 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 text-[10px] rounded font-medium">
                      {model.contextWindow}
                    </span>
                  )}
                </div>
                <code className="text-xs text-gray-500">{model.id}</code>
                <div className="text-xs text-blue-600 mt-0.5">
                  alias: {model.shortAlias}
                </div>
              </div>
              <div className="flex flex-col items-end gap-0.5">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-purple-100 text-purple-700 text-xs rounded font-mono whitespace-nowrap">
                  <GitHubIcon className="w-3 h-3" />
                  {model.githubLabel}
                </span>
                {isSupported && (
                  <input
                    type="text"
                    value={modelCustomLabel}
                    onChange={(e) => onCustomLabelChange(model.id, e.target.value)}
                    placeholder="custom-label"
                    className="w-32 px-1.5 py-0.5 text-xs bg-white text-gray-700 border border-gray-300 rounded focus:ring-1 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                  />
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
    {errors.supportedModels && <p className="mt-1 text-xs text-red-600">{errors.supportedModels}</p>}
    <p className="mt-1 text-xs text-gray-500">
      Checkboxes enable models, radio buttons select the default. Custom labels allow alternative trigger names.
    </p>
  </div>
};

export default ModelSelector;
