import React, { useState, useEffect } from 'react';
import { AgentConfig } from '../../api/gitfixApi';

interface AgentConfigModalProps {
  agent: AgentConfig | null;
  existingAliases: string[];
  onClose: () => void;
  onSave: (agent: AgentConfig) => void;
}

type AgentType = 'claude' | 'codex' | 'gemini';

// Model info with ID, alias, and GitHub label for display
interface ModelInfo {
  id: string;
  alias?: string;
  githubLabel: string;
}

// Latest Claude models from official documentation
const CLAUDE_MODELS: ModelInfo[] = [
  // Latest models (Claude 4.5)
  { id: 'claude-sonnet-4-5-20250929', alias: 'claude-sonnet-4-5', githubLabel: 'claude-sonnet-4.5' },
  { id: 'claude-haiku-4-5-20251001', alias: 'claude-haiku-4-5', githubLabel: 'claude-haiku-4.5' },
  { id: 'claude-opus-4-5-20251101', alias: 'claude-opus-4-5', githubLabel: 'claude-opus-4.5' },
  // Legacy models (still available)
  { id: 'claude-opus-4-1-20250805', alias: 'claude-opus-4-1', githubLabel: 'claude-opus-4.1' },
  { id: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-0', githubLabel: 'claude-sonnet-4' },
  { id: 'claude-3-7-sonnet-20250219', alias: 'claude-3-7-sonnet-latest', githubLabel: 'claude-3.7-sonnet' },
  { id: 'claude-opus-4-20250514', alias: 'claude-opus-4-0', githubLabel: 'claude-opus-4' },
  { id: 'claude-3-5-haiku-20241022', alias: 'claude-3-5-haiku-latest', githubLabel: 'claude-3.5-haiku' },
];

// Codex models from official documentation
const CODEX_MODELS: ModelInfo[] = [
  // Recommended models
  { id: 'gpt-5.1-codex-max', githubLabel: 'gpt-5.1-codex-max' },
  { id: 'gpt-5.1-codex-mini', githubLabel: 'gpt-5.1-codex-mini' },
  // Alternative models
  { id: 'gpt-5.2', githubLabel: 'gpt-5.2' },
  { id: 'gpt-5.1', githubLabel: 'gpt-5.1' },
  { id: 'gpt-5.1-codex', githubLabel: 'gpt-5.1-codex' },
  { id: 'gpt-5-codex', githubLabel: 'gpt-5-codex' },
  { id: 'gpt-5-codex-mini', githubLabel: 'gpt-5-codex-mini' },
  { id: 'gpt-5', githubLabel: 'gpt-5' },
];

// Gemini models from official documentation
const GEMINI_MODELS: ModelInfo[] = [
  { id: 'gemini-3-pro-preview', githubLabel: 'gemini-3-pro-preview' },
  { id: 'gemini-2.5-pro', githubLabel: 'gemini-2.5-pro' },
  { id: 'gemini-2.5-flash', githubLabel: 'gemini-2.5-flash' },
  { id: 'gemini-2.5-flash-lite', githubLabel: 'gemini-2.5-flash-lite' },
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
    supportedModels: AGENT_DEFAULTS.claude.defaultModels
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
        supportedModels: agent.supportedModels
      });
    }
  }, [agent]);

  const handleTypeChange = (newType: AgentType) => {
    const defaults = AGENT_DEFAULTS[newType];
    setFormData(prev => ({
      ...prev,
      type: newType,
      dockerImage: prev.dockerImage === AGENT_DEFAULTS[prev.type].dockerImage ? defaults.dockerImage : prev.dockerImage,
      configPath: prev.configPath === AGENT_DEFAULTS[prev.type].configPath ? defaults.configPath : prev.configPath,
      supportedModels: defaults.defaultModels
    }));
  };

  const handleModelToggle = (modelId: string) => {
    setFormData(prev => {
      const isSelected = prev.supportedModels.includes(modelId);
      const newModels = isSelected
        ? prev.supportedModels.filter(m => m !== modelId)
        : [...prev.supportedModels, modelId];
      return { ...prev, supportedModels: newModels };
    });
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

    // Validate dockerImage
    if (!formData.dockerImage) {
      newErrors.dockerImage = 'Docker image is required';
    }

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
      supportedModels: formData.supportedModels
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

          {/* Docker Image */}
          <div>
            <label className="block text-gray-700 mb-2 font-medium" htmlFor="dockerImage">
              Docker Image
            </label>
            <input
              type="text"
              id="dockerImage"
              value={formData.dockerImage}
              onChange={(e) => setFormData(prev => ({ ...prev, dockerImage: e.target.value }))}
              placeholder={AGENT_DEFAULTS[formData.type].dockerImage}
              className={`w-full px-3 py-2 bg-gray-50 text-gray-900 border rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 font-mono text-sm ${
                errors.dockerImage ? 'border-red-500' : 'border-gray-300'
              }`}
            />
            {errors.dockerImage && <p className="mt-1 text-sm text-red-600">{errors.dockerImage}</p>}
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
              {AGENT_MODELS[formData.type].map(model => (
                <label
                  key={model.id}
                  className="flex items-start gap-3 py-2 px-2 hover:bg-gray-100 rounded cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={formData.supportedModels.includes(model.id)}
                    onChange={() => handleModelToggle(model.id)}
                    className="mt-1 h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="text-sm font-medium text-gray-900">{model.id}</code>
                      {model.alias && (
                        <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded">
                          alias: {model.alias}
                        </span>
                      )}
                    </div>
                    <div className="mt-1">
                      <span className="px-1.5 py-0.5 bg-purple-100 text-purple-700 text-xs rounded">
                        GitHub: {model.githubLabel}
                      </span>
                    </div>
                  </div>
                </label>
              ))}
            </div>
            {errors.supportedModels && <p className="mt-1 text-sm text-red-600">{errors.supportedModels}</p>}
            <p className="mt-1 text-sm text-gray-600">
              Select the models this agent supports. All models are selected by default.
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
