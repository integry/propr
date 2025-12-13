import React, { useState, useEffect } from 'react';
import { AgentConfig } from '../../api/gitfixApi';

interface AgentConfigModalProps {
  agent: AgentConfig | null;
  existingAliases: string[];
  onClose: () => void;
  onSave: (agent: AgentConfig) => void;
}

// GitHub icon component
const GitHubIcon: React.FC<{ className?: string }> = ({ className = "w-4 h-4" }) => (
  <svg className={className} fill="currentColor" viewBox="0 0 24 24">
    <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
  </svg>
);

type AgentType = 'claude' | 'codex' | 'gemini';

// Model info with ID, human-readable name, short alias, and GitHub label
interface ModelInfo {
  id: string;
  name: string;           // Human-readable name
  shortAlias: string;     // Short alias like "opus", "sonnet", "haiku"
  githubLabel: string;    // Format: llm-<agent-alias>-<model-alias>
}

// Claude models
const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', shortAlias: 'sonnet', githubLabel: 'llm-claude-sonnet' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', shortAlias: 'haiku', githubLabel: 'llm-claude-haiku' },
  { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', shortAlias: 'opus', githubLabel: 'llm-claude-opus' },
];

// Codex (OpenAI) models
const CODEX_MODELS: ModelInfo[] = [
  { id: 'gpt-5', name: 'GPT-5', shortAlias: 'gpt5', githubLabel: 'llm-codex-gpt5' },
  { id: 'gpt-5-mini', name: 'GPT-5 Mini', shortAlias: 'gpt5-mini', githubLabel: 'llm-codex-gpt5-mini' },
  { id: 'gpt-5-codex', name: 'GPT-5 Codex', shortAlias: 'codex', githubLabel: 'llm-codex-codex' },
  { id: 'o3', name: 'OpenAI o3', shortAlias: 'o3', githubLabel: 'llm-codex-o3' },
  { id: 'o4-mini', name: 'OpenAI o4-mini', shortAlias: 'o4-mini', githubLabel: 'llm-codex-o4-mini' },
];

// Gemini models
const GEMINI_MODELS: ModelInfo[] = [
  { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', shortAlias: 'pro-preview', githubLabel: 'llm-gemini-pro-preview' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', shortAlias: 'pro', githubLabel: 'llm-gemini-pro' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', shortAlias: 'flash', githubLabel: 'llm-gemini-flash' },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', shortAlias: 'flash-lite', githubLabel: 'llm-gemini-flash-lite' },
];

const AGENT_MODELS: Record<AgentType, ModelInfo[]> = {
  claude: CLAUDE_MODELS,
  codex: CODEX_MODELS,
  gemini: GEMINI_MODELS,
};

const AGENT_DEFAULTS: Record<AgentType, { dockerImage: string; configPath: string; defaultModels: string[] }> = {
  claude: {
    dockerImage: 'claude-code-processor:latest',
    configPath: '~/.claude',
    defaultModels: CLAUDE_MODELS.map(m => m.id)
  },
  codex: {
    dockerImage: 'codex-cli:latest',
    configPath: '~/.codex',
    defaultModels: CODEX_MODELS.map(m => m.id)
  },
  gemini: {
    dockerImage: 'gemini-cli:latest',
    configPath: '~/.gemini',
    defaultModels: GEMINI_MODELS.map(m => m.id)
  }
};

const AgentConfigModal: React.FC<AgentConfigModalProps> = ({
  agent,
  existingAliases,
  onClose,
  onSave
}) => {
  const isEditing = agent !== null;

  const [formData, setFormData] = useState<Omit<AgentConfig, 'id'> & { id?: string }>({
    type: 'claude',
    alias: '',
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
    setFormData(prev => ({
      ...prev,
      type: newType,
      dockerImage: defaults.dockerImage, // Docker image is predefined and not editable
      configPath: prev.configPath === AGENT_DEFAULTS[prev.type].configPath ? defaults.configPath : prev.configPath,
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

          {/* Docker Image (read-only for predefined agents) */}
          <div>
            <label className="block text-gray-700 mb-2 font-medium">
              Docker Image
            </label>
            <div className="w-full px-3 py-2 bg-gray-100 text-gray-700 border border-gray-300 rounded-md font-mono text-sm">
              {formData.dockerImage}
            </div>
            <p className="mt-1 text-sm text-gray-500">
              Docker image is predefined for each agent type and cannot be changed.
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
                      <div className="text-sm font-medium text-gray-900">{model.name}</div>
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
