import React from 'react';
import { Settings } from './types';
import { AgentConfig } from '../../api/gitfixApi';
import { MODEL_INFO_MAP } from '../../config/modelDefinitions';

interface GeneralSettingsSectionProps {
  settings: Settings;
  agents: AgentConfig[];
  onSettingChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => void;
  onBlur?: () => void;
  className?: string;
}

interface ModelOption {
  value: string;
  label: string;
  enabled: boolean;
}

const GeneralSettingsSection: React.FC<GeneralSettingsSectionProps> = ({
  settings,
  agents,
  onSettingChange,
  onBlur,
  className
}) => {
  // Helper to get pretty name from MODEL_INFO_MAP
  const getModelLabel = (agentAlias: string, modelId: string) => {
    const info = MODEL_INFO_MAP[modelId];
    return info ? `${agentAlias} - ${info.name}` : `${agentAlias} - ${modelId}`;
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

  const hasAgents = agents.length > 0;

  return (
    <div className={`bg-white shadow rounded-lg p-6 ${className || ''}`}>
      <h3 className="text-gray-900 text-lg font-medium mb-4">General Configuration</h3>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="worker_concurrency">
            Worker Concurrency
          </label>
          <input
            type="number"
            id="worker_concurrency"
            name="worker_concurrency"
            value={settings.worker_concurrency}
            onChange={onSettingChange}
            onBlur={onBlur}
            placeholder="e.g., 2"
            className="w-[100px] rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm px-3 py-2 border"
          />
          <p className="mt-1 text-sm text-gray-500">
            Number of issues to process simultaneously.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="analysis_model_fast">
            Fast Analysis Model
          </label>
          {hasAgents ? (
            <select
              id="analysis_model_fast"
              name="analysis_model_fast"
              value={settings.analysis_model_fast}
              onChange={(e) => { onSettingChange(e); onBlur?.(); }}
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
            <input
              type="text"
              id="analysis_model_fast"
              name="analysis_model_fast"
              value={settings.analysis_model_fast}
              onChange={onSettingChange}
              onBlur={onBlur}
              placeholder="e.g., claude-3-5-haiku-20241022"
              className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm px-3 py-2 border"
            />
          )}
          <p className="mt-1 text-sm text-gray-500">
            Used for initial triage and quick tasks.
            {!hasAgents && ' Configure agents above to select from available models.'}
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="analysis_model_advanced">
            Advanced Analysis Model
          </label>
          {hasAgents ? (
            <select
              id="analysis_model_advanced"
              name="analysis_model_advanced"
              value={settings.analysis_model_advanced}
              onChange={(e) => { onSettingChange(e); onBlur?.(); }}
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
            <input
              type="text"
              id="analysis_model_advanced"
              name="analysis_model_advanced"
              value={settings.analysis_model_advanced}
              onChange={onSettingChange}
              onBlur={onBlur}
              placeholder="e.g., claude-opus-4-20250514"
              className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm px-3 py-2 border"
            />
          )}
          <p className="mt-1 text-sm text-gray-500">
            Used for deep-dive analysis and complex planning.
            {!hasAgents && ' Configure agents above to select from available models.'}
          </p>
        </div>
      </div>
    </div>
  );
};

export default GeneralSettingsSection;
