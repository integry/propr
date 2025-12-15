import React, { useState, useEffect } from 'react';
import { AgentConfig } from '../../api/gitfixApi';
import { GitHubIcon } from './GitHubIcon';
import { AgentType, AGENT_MODELS, AGENT_DEFAULTS } from './agentModels';

interface AgentConfigModalProps {
  agent: AgentConfig | null;
  existingAliases: string[];
  onClose: () => void;
  onSave: (agent: AgentConfig) => void;
}

const AgentConfigModal: React.FC<AgentConfigModalProps> = ({
  agent,
  existingAliases,
  onClose,
  onSave
}) => {
  const isEditing = agent !== null;

  const [formData, setFormData] = useState<Omit<AgentConfig, 'id'> & { id?: string }>({
    type: 'claude',
    alias: AGENT_DEFAULTS.claude.defaultAlias,
    enabled: true,
    dockerImage: AGENT_DEFAULTS.claude.dockerImage,
    configPath: AGENT_DEFAULTS.claude.configPath,
    supportedModels: AGENT_DEFAULTS.claude.defaultModels,
    defaultModel: AGENT_DEFAULTS.claude.defaultModels[0]
  });

  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (agent) {
      setFormData({
        id: agent.id,
        type: agent.type,
        alias: agent.alias,
        enabled: agent.enabled,
        dockerImage: agent.dockerImage,
        configPath: agent.configPath,
        supportedModels: agent.supportedModels,
        defaultModel: agent.defaultModel || agent.supportedModels[0]
      });
    }
  }, [agent]);

  const handleTypeChange = (newType: AgentType) => {
    const defaults = AGENT_DEFAULTS[newType];
    const prevDefaults = AGENT_DEFAULTS[formData.type];
    setFormData(prev => ({
      ...prev,
      type: newType,
      // Update alias to new default if it was the previous default alias (for new agents)
      alias: prev.alias === prevDefaults.defaultAlias ? defaults.defaultAlias : prev.alias,
      dockerImage: defaults.dockerImage, // Docker image is predefined and not editable
      configPath: prev.configPath === prevDefaults.configPath ? defaults.configPath : prev.configPath,
      supportedModels: defaults.defaultModels,
      defaultModel: defaults.defaultModels[0]
    }));
  };

  const handleModelToggle = (modelId: string) => {
    setFormData(prev => {
      const isSelected = prev.supportedModels.includes(modelId);
      const newModels = isSelected
        ? prev.supportedModels.filter(m => m !== modelId)
        : [...prev.supportedModels, modelId];

      // If deselecting the current default model, pick the first remaining model
      let newDefaultModel = prev.defaultModel;
      if (isSelected && prev.defaultModel === modelId) {
        newDefaultModel = newModels[0] || undefined;
      }

      return { ...prev, supportedModels: newModels, defaultModel: newDefaultModel };
    });
  };

  const handleDefaultModelChange = (modelId: string) => {
    setFormData(prev => ({ ...prev, defaultModel: modelId }));
  };

  const handleSelectAllModels = () => {
    const allModels = AGENT_MODELS[formData.type].map(m => m.id);
    setFormData(prev => ({ ...prev, supportedModels: allModels }));
  };

  const handleDeselectAllModels = () => {
    setFormData(prev => ({ ...prev, supportedModels: [] }));
  };

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    // Validate alias
    if (!formData.alias) {
      newErrors.alias = 'Alias is required';
    } else if (!/^[a-z0-9-]+$/.test(formData.alias)) {
      newErrors.alias = 'Alias must only contain lowercase letters, numbers, and hyphens';
    } else if (!isEditing && existingAliases.includes(formData.alias)) {
      newErrors.alias = 'This alias is already in use';
    } else if (isEditing && agent && formData.alias !== agent.alias && existingAliases.includes(formData.alias)) {
      newErrors.alias = 'This alias is already in use';
    }

    // Note: dockerImage is predefined and not editable, so no validation needed

    // Validate configPath
    if (!formData.configPath) {
      newErrors.configPath = 'Config path is required';
    }

    // Validate supportedModels
    if (formData.supportedModels.length === 0) {
      newErrors.supportedModels = 'At least one model is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    const agentToSave: AgentConfig = {
      id: formData.id || crypto.randomUUID(),
      type: formData.type,
      alias: formData.alias,
      enabled: formData.enabled,
      dockerImage: formData.dockerImage,
      configPath: formData.configPath,
      supportedModels: formData.supportedModels,
      defaultModel: formData.defaultModel
    };

    onSave(agentToSave);
  };

  const typeBadgeColors: Record<AgentType, string> = {
    claude: 'bg-orange-100 text-orange-800 border-orange-300',
    codex: 'bg-green-100 text-green-800 border-green-300',
    gemini: 'bg-blue-100 text-blue-800 border-blue-300'
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] flex flex-col border border-gray-300 shadow-lg">
        <div className="flex justify-between items-center p-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">
            {isEditing ? 'Edit Agent' : 'Add New Agent'}
          </h3>
          <button
            className="text-gray-500 hover:text-gray-700 text-2xl leading-none"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Agent Type */}
          <div>
            <label className="block text-gray-700 mb-2 font-medium">Agent Type</label>
            <div className="flex gap-2">
              {(['claude', 'codex', 'gemini'] as AgentType[]).map(type => (
                <button
                  key={type}
                  type="button"
                  onClick={() => handleTypeChange(type)}
                  className={`px-4 py-2 rounded-md border font-medium capitalize transition-colors ${
                    formData.type === type
                      ? typeBadgeColors[type]
                      : 'bg-gray-50 text-gray-600 border-gray-300 hover:bg-gray-100'
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>

          {/* Alias */}
          <div>
            <label className="block text-gray-700 mb-2 font-medium" htmlFor="alias">
              Alias
            </label>
            <input
              type="text"
              id="alias"
              value={formData.alias}
              onChange={(e) => setFormData(prev => ({ ...prev, alias: e.target.value.toLowerCase() }))}
              placeholder="e.g., primary-claude, fast-gemini"
              className={`w-full px-3 py-2 bg-gray-50 text-gray-900 border rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 ${
                errors.alias ? 'border-red-500' : 'border-gray-300'
              }`}
            />
            {errors.alias && <p className="mt-1 text-sm text-red-600">{errors.alias}</p>}
            <p className="mt-1 text-sm text-gray-600">
              Unique identifier using lowercase letters, numbers, and hyphens only.
            </p>
          </div>

          {/* Config Path */}
          <div>
            <label className="block text-gray-700 mb-2 font-medium" htmlFor="configPath">
              Config Path
            </label>
            <input
              type="text"
              id="configPath"
              value={formData.configPath}
              onChange={(e) => setFormData(prev => ({ ...prev, configPath: e.target.value }))}
              placeholder={AGENT_DEFAULTS[formData.type].configPath}
              className={`w-full px-3 py-2 bg-gray-50 text-gray-900 border rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 font-mono text-sm ${
                errors.configPath ? 'border-red-500' : 'border-gray-300'
              }`}
            />
            {errors.configPath && <p className="mt-1 text-sm text-red-600">{errors.configPath}</p>}
          </div>

          {/* Supported Models */}
          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="block text-gray-700 font-medium">
                Supported Models
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSelectAllModels}
                  className="text-xs text-primary-600 hover:text-primary-800 font-medium"
                >
                  Select All
                </button>
                <span className="text-gray-300">|</span>
                <button
                  type="button"
                  onClick={handleDeselectAllModels}
                  className="text-xs text-gray-500 hover:text-gray-700 font-medium"
                >
                  Deselect All
                </button>
              </div>
            </div>
            <div className={`border rounded-md p-3 bg-gray-50 max-h-64 overflow-y-auto ${
              errors.supportedModels ? 'border-red-500' : 'border-gray-300'
            }`}>
              {AGENT_MODELS[formData.type].map(model => {
                const isSupported = formData.supportedModels.includes(model.id);
                const isDefault = formData.defaultModel === model.id;
                const agentDefaultLabel = formData.alias ? `llm-${formData.alias}` : null;

                return (
                  <div
                    key={model.id}
                    className="flex items-center gap-3 py-2 px-2 hover:bg-gray-100 rounded"
                  >
                    {/* Checkbox for enabling/disabling model */}
                    <input
                      type="checkbox"
                      checked={isSupported}
                      onChange={() => handleModelToggle(model.id)}
                      className="h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500 cursor-pointer"
                    />

                    {/* Radio for default model selection */}
                    <input
                      type="radio"
                      name="defaultModel"
                      checked={isDefault}
                      disabled={!isSupported}
                      onChange={() => handleDefaultModelChange(model.id)}
                      className="h-4 w-4 text-primary-600 border-gray-300 focus:ring-primary-500 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                      title={isSupported ? 'Set as default model' : 'Enable this model to set as default'}
                    />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900">{model.name}</span>
                        
                        {/* Context Window Badge */}
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

                    {/* GitHub labels column */}
                    <div className="flex flex-col gap-1 items-end">
                      <span className="inline-flex items-center gap-1 px-2 py-1 bg-purple-100 text-purple-700 text-xs rounded font-mono whitespace-nowrap">
                        <GitHubIcon className="w-3 h-3" />
                        {model.githubLabel}
                      </span>
                      {isDefault && agentDefaultLabel && (
                        <span className="inline-flex items-center gap-1 px-2 py-1 bg-teal-100 text-teal-700 text-xs rounded font-mono whitespace-nowrap">
                          <GitHubIcon className="w-3 h-3" />
                          {agentDefaultLabel}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {errors.supportedModels && <p className="mt-1 text-sm text-red-600">{errors.supportedModels}</p>}
            <p className="mt-1 text-sm text-gray-600">
              Use checkboxes to enable models. Use radio buttons to select the default model for this agent.
            </p>
          </div>

          {/* Enabled Toggle */}
          <div className="flex items-center gap-3">
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={formData.enabled}
                onChange={(e) => setFormData(prev => ({ ...prev, enabled: e.target.checked }))}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-600"></div>
            </label>
            <span className="text-gray-700 font-medium">Enabled</span>
          </div>
        </form>

        <div className="flex justify-end gap-3 p-4 border-t border-gray-200">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            onClick={handleSubmit}
            className="px-4 py-2 font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-md transition-colors"
          >
            {isEditing ? 'Save Changes' : 'Add Agent'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AgentConfigModal;
