import React, { useState, useEffect, useCallback } from 'react';
import { AgentConfig, CliVersionType } from '../../api/proprApi';
import { AgentType, AGENT_DEFAULTS } from '../../config/modelDefinitions';
import { getAgentVersions, AvailableVersionsResponse } from '../../api/agentVersionApi';
import CliVersionSelector from './CliVersionSelector';
import ModelSelector from './ModelSelector';

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
    defaultModel: AGENT_DEFAULTS.claude.defaultModels[0],
    modelCustomLabels: {},
    cliVersionType: 'default',
    cliVersion: undefined,
    cliVersionResolved: AGENT_DEFAULTS.claude.defaultCliVersion
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [versionData, setVersionData] = useState<AvailableVersionsResponse | null>(null);
  const [versionLoading, setVersionLoading] = useState(false);

  // Load version data when agent type changes
  const loadVersionData = useCallback(async (agentType: AgentType) => {
    setVersionLoading(true);
    try {
      const data = await getAgentVersions(agentType);
      setVersionData(data);
    } catch (error) {
      console.error('Failed to load version data:', error);
      setVersionData(null);
    } finally {
      setVersionLoading(false);
    }
  }, []);

  useEffect(() => {
    loadVersionData(formData.type);
  }, [formData.type, loadVersionData]);

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
        defaultModel: agent.defaultModel || agent.supportedModels[0],
        modelCustomLabels: agent.modelCustomLabels || {},
        cliVersionType: agent.cliVersionType || 'default',
        cliVersion: agent.cliVersion,
        cliVersionResolved: agent.cliVersionResolved || AGENT_DEFAULTS[agent.type].defaultCliVersion
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
      defaultModel: defaults.defaultModels[0],
      // Reset version to default when changing agent type
      cliVersionType: 'default',
      cliVersion: undefined,
      cliVersionResolved: defaults.defaultCliVersion
    }));
  };

  const handleVersionTypeChange = (versionType: CliVersionType) => {
    const defaults = AGENT_DEFAULTS[formData.type];
    setFormData(prev => ({
      ...prev,
      cliVersionType: versionType,
      cliVersion: versionType === 'default' ? undefined : prev.cliVersion,
      cliVersionResolved: versionType === 'default' ? defaults.defaultCliVersion : prev.cliVersionResolved
    }));
  };

  const handleVersionChange = (version: string) => {
    setFormData(prev => ({
      ...prev,
      cliVersion: version,
      // The resolved version will be set by the backend
      cliVersionResolved: undefined
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

    // Filter modelCustomLabels to only include supported models with non-empty labels
    const cleanedModelCustomLabels: Record<string, string> = {};
    if (formData.modelCustomLabels) {
      for (const [modelId, label] of Object.entries(formData.modelCustomLabels)) {
        const trimmedLabel = label?.trim();
        if (trimmedLabel && formData.supportedModels.includes(modelId)) {
          cleanedModelCustomLabels[modelId] = trimmedLabel;
        }
      }
    }

    const agentToSave: AgentConfig = {
      id: formData.id || crypto.randomUUID(),
      type: formData.type,
      alias: formData.alias,
      enabled: formData.enabled,
      dockerImage: formData.dockerImage,
      configPath: formData.configPath,
      supportedModels: formData.supportedModels,
      defaultModel: formData.defaultModel,
      modelCustomLabels: Object.keys(cleanedModelCustomLabels).length > 0 ? cleanedModelCustomLabels : undefined,
      cliVersionType: formData.cliVersionType,
      cliVersion: formData.cliVersion,
      cliVersionResolved: formData.cliVersionResolved
    };

    onSave(agentToSave);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] flex flex-col border border-gray-300 shadow-lg">
        <div className="flex justify-between items-center px-4 py-3 border-b border-gray-200">
          <h3 className="text-base font-semibold text-gray-900">
            {isEditing ? 'Edit Agent' : 'Add New Agent'}
          </h3>
          <button
            className="text-gray-500 hover:text-gray-700 text-2xl leading-none"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* Agent Type - Pill Toggle Style */}
          <div>
            <label className="block text-gray-700 mb-1.5 font-medium text-sm">Agent Type</label>
            <div className="inline-flex bg-gray-100 rounded-full p-1">
              {(['claude', 'codex', 'gemini', 'vibe'] as AgentType[]).map(type => (
                <button
                  key={type}
                  type="button"
                  onClick={() => handleTypeChange(type)}
                  className={`px-4 py-1.5 rounded-full text-sm font-medium capitalize transition-all ${
                    formData.type === type
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>

          <CliVersionSelector
            agentType={formData.type}
            cliVersionType={formData.cliVersionType || 'default'}
            cliVersion={formData.cliVersion}
            cliVersionResolved={formData.cliVersionResolved}
            versionData={versionData}
            versionLoading={versionLoading}
            onVersionTypeChange={handleVersionTypeChange}
            onVersionChange={handleVersionChange}
          />

          {/* Alias */}
          <div>
            <label className="block text-gray-700 mb-1.5 font-medium text-sm" htmlFor="alias">
              ID / Alias
            </label>
            <input
              type="text"
              id="alias"
              value={formData.alias}
              onChange={(e) => setFormData(prev => ({ ...prev, alias: e.target.value.toLowerCase() }))}
              placeholder="e.g., primary-claude, fast-gemini"
              className={`w-full px-3 py-1.5 bg-gray-50 text-gray-900 border rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 font-mono text-sm ${
                errors.alias ? 'border-red-500' : 'border-gray-300'
              }`}
            />
            {errors.alias && <p className="mt-1 text-xs text-red-600">{errors.alias}</p>}
            <p className="mt-1 text-xs text-gray-500">
              Unique identifier using lowercase letters, numbers, and hyphens only.
            </p>
          </div>

          {/* Config Path */}
          <div>
            <label className="block text-gray-700 mb-1.5 font-medium text-sm" htmlFor="configPath">
              Config Path
            </label>
            <input
              type="text"
              id="configPath"
              value={formData.configPath}
              onChange={(e) => setFormData(prev => ({ ...prev, configPath: e.target.value }))}
              placeholder={AGENT_DEFAULTS[formData.type].configPath}
              className={`w-full px-3 py-1.5 bg-gray-50 text-gray-900 border rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 font-mono text-sm ${
                errors.configPath ? 'border-red-500' : 'border-gray-300'
              }`}
            />
            {errors.configPath && <p className="mt-1 text-xs text-red-600">{errors.configPath}</p>}
          </div>

          <ModelSelector
            agentType={formData.type}
            supportedModels={formData.supportedModels}
            defaultModel={formData.defaultModel}
            modelCustomLabels={formData.modelCustomLabels}
            errors={errors}
            onModelToggle={handleModelToggle}
            onDefaultModelChange={handleDefaultModelChange}
            onSelectAll={handleSelectAllModels}
            onDeselectAll={handleDeselectAllModels}
            onCustomLabelChange={(modelId, label) => setFormData(prev => ({
              ...prev,
              modelCustomLabels: { ...prev.modelCustomLabels, [modelId]: label }
            }))}
          />

          {/* Enabled Toggle */}
          <div className="flex items-center gap-2">
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={formData.enabled}
                onChange={(e) => setFormData(prev => ({ ...prev, enabled: e.target.checked }))}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
            </label>
            <span className="text-gray-700 font-medium text-sm">Enabled</span>
          </div>
        </form>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-200">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            onClick={handleSubmit}
            className="px-3 py-1.5 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-md transition-colors"
          >
            {isEditing ? 'Save Changes' : 'Add Agent'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AgentConfigModal;
