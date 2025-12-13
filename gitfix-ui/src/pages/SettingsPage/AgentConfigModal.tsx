import React, { useState, useEffect } from 'react';
import { AgentConfig } from '../../api/gitfixApi';

interface AgentConfigModalProps {
  agent: AgentConfig | null;
  existingAliases: string[];
  onClose: () => void;
  onSave: (agent: AgentConfig) => void;
}

type AgentType = 'claude' | 'codex' | 'gemini';

const AGENT_DEFAULTS: Record<AgentType, { dockerImage: string; configPath: string; defaultModels: string[] }> = {
  claude: {
    dockerImage: 'claude-code-processor:latest',
    configPath: '~/.claude',
    defaultModels: ['claude-3-opus-20240229', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-opus-4-20250514', 'claude-sonnet-4-20250514']
  },
  codex: {
    dockerImage: 'codex-cli:latest',
    configPath: '~/.codex',
    defaultModels: ['codex-mini-latest', 'o3', 'o4-mini']
  },
  gemini: {
    dockerImage: 'gemini-cli:latest',
    configPath: '~/.gemini',
    defaultModels: ['gemini-2.5-pro', 'gemini-2.5-flash']
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

  const [modelsInput, setModelsInput] = useState<string>('');
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
      setModelsInput(agent.supportedModels.join(', '));
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
    setModelsInput(defaults.defaultModels.join(', '));
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
    const models = modelsInput.split(',').map(m => m.trim()).filter(m => m.length > 0);
    if (models.length === 0) {
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

    const models = modelsInput.split(',').map(m => m.trim()).filter(m => m.length > 0);

    const agentToSave: AgentConfig = {
      id: formData.id || crypto.randomUUID(),
      type: formData.type,
      alias: formData.alias,
      enabled: formData.enabled,
      dockerImage: formData.dockerImage,
      configPath: formData.configPath,
      supportedModels: models
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
            <label className="block text-gray-700 mb-2 font-medium" htmlFor="supportedModels">
              Supported Models
            </label>
            <textarea
              id="supportedModels"
              value={modelsInput}
              onChange={(e) => setModelsInput(e.target.value)}
              rows={3}
              placeholder="Enter model IDs separated by commas"
              className={`w-full px-3 py-2 bg-gray-50 text-gray-900 border rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 font-mono text-sm ${
                errors.supportedModels ? 'border-red-500' : 'border-gray-300'
              }`}
            />
            {errors.supportedModels && <p className="mt-1 text-sm text-red-600">{errors.supportedModels}</p>}
            <p className="mt-1 text-sm text-gray-600">
              Enter model IDs supported by this agent, separated by commas.
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
