import React from 'react';
import { Settings } from './types';
import Alert from './Alert';
import { AgentConfig } from '../../api/gitfixApi';

interface GeneralSettingsSectionProps {
  settings: Settings;
  agents: AgentConfig[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  success: string | null;
  onSettingChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => void;
  onSave: () => void;
}

interface ModelOption {
  value: string;
  label: string;
  agentAlias: string;
  agentType: string;
  enabled: boolean;
}

const GeneralSettingsSection: React.FC<GeneralSettingsSectionProps> = ({
  settings,
  agents,
  loading,
  saving,
  error,
  success,
  onSettingChange,
  onSave
}) => {
  // Generate model options from agents
  const modelOptions: ModelOption[] = agents.flatMap(agent =>
    agent.supportedModels.map(model => ({
      value: `${agent.alias}:${model}`,
      label: `${agent.alias} - ${model}`,
      agentAlias: agent.alias,
      agentType: agent.type,
      enabled: agent.enabled
    }))
  );

  // Group options by agent type for better organization
  const enabledOptions = modelOptions.filter(opt => opt.enabled);
  const disabledOptions = modelOptions.filter(opt => !opt.enabled);

  const hasAgents = agents.length > 0;

  return (
    <div className="mb-8">
      <h3 className="text-gray-900 text-xl font-semibold mb-4">General Settings</h3>

      {error && <Alert message={error} type="error" />}
      {success && <Alert message={success} type="success" />}

      {loading ? (
        <p className="text-gray-600">Loading settings...</p>
      ) : (
        <div className="space-y-4">
          <div>
            <label className="block text-gray-700 mb-2" htmlFor="worker_concurrency">
              Worker Concurrency
            </label>
            <input
              type="number"
              id="worker_concurrency"
              name="worker_concurrency"
              value={settings.worker_concurrency}
              onChange={onSettingChange}
              placeholder="Number of concurrent workers (e.g., 2)"
              className="w-full px-3 py-2 bg-gray-50 text-gray-900 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
            <p className="mt-1 text-sm text-gray-600">
              Controls how many issues can be processed simultaneously
            </p>
          </div>

          <div>
            <label className="block text-gray-700 mb-2" htmlFor="github_user_whitelist">
              GitHub User Whitelist
            </label>
            <textarea
              id="github_user_whitelist"
              name="github_user_whitelist"
              value={settings.github_user_whitelist}
              onChange={onSettingChange}
              rows={3}
              placeholder="Comma-separated list of GitHub usernames (e.g., user1, user2)"
              className="w-full px-3 py-2 bg-gray-50 text-gray-900 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 font-mono text-sm"
            />
            <p className="mt-1 text-sm text-gray-600">
              Only process issues from these GitHub users. Leave empty to process from all users.
            </p>
          </div>

          <div>
            <label className="block text-gray-700 mb-2" htmlFor="analysis_model_fast">
              Fast Analysis Model
            </label>
            {hasAgents ? (
              <select
                id="analysis_model_fast"
                name="analysis_model_fast"
                value={settings.analysis_model_fast}
                onChange={onSettingChange}
                className="w-full px-3 py-2 bg-gray-50 text-gray-900 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 font-mono text-sm"
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
                        {opt.label} (disabled)
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
                placeholder="e.g., claude-3-5-haiku-20241022"
                className="w-full px-3 py-2 bg-gray-50 text-gray-900 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 font-mono text-sm"
              />
            )}
            <p className="mt-1 text-sm text-gray-600">
              Model for automatic, fast analysis of all tasks (e.g., Haiku, Flash).
              {!hasAgents && ' Configure agents above to select from available models.'}
            </p>
          </div>

          <div>
            <label className="block text-gray-700 mb-2" htmlFor="analysis_model_advanced">
              Advanced Analysis Model
            </label>
            {hasAgents ? (
              <select
                id="analysis_model_advanced"
                name="analysis_model_advanced"
                value={settings.analysis_model_advanced}
                onChange={onSettingChange}
                className="w-full px-3 py-2 bg-gray-50 text-gray-900 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 font-mono text-sm"
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
                        {opt.label} (disabled)
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
                placeholder="e.g., claude-opus-4-20250514"
                className="w-full px-3 py-2 bg-gray-50 text-gray-900 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 font-mono text-sm"
              />
            )}
            <p className="mt-1 text-sm text-gray-600">
              Model for manual "Deep-Dive Analysis" (e.g., Opus, Pro).
              {!hasAgents && ' Configure agents above to select from available models.'}
            </p>
          </div>

          <button
            onClick={onSave}
            disabled={saving}
            className={`px-6 py-3 font-medium rounded-md transition-colors ${
              saving
                ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                : 'bg-primary-600 text-white hover:bg-primary-700 cursor-pointer'
            }`}
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      )}
    </div>
  );
};

export default GeneralSettingsSection;
