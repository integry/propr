import React, { useState, useEffect, useCallback } from 'react';
import { Eye, EyeOff, ExternalLink } from 'lucide-react';
import { AgentConfig, CliVersionType, getOpenCodeModels } from '../../api/proprApi';
import { AgentType, AGENT_DEFAULTS } from '../../config/modelDefinitions';
import {
  getManagedAgentConfigPath,
  isAgentLoginSupported,
  isManagedAgentConfigPath,
} from '@propr/shared';
import { getAgentVersions, AvailableVersionsResponse } from '../../api/agentVersionApi';
import AgentCredentialSetup from './AgentCredentialSetup';
import AgentEnabledToggle from './AgentEnabledToggle';
import {
  createNewAgentFormData,
  getAgentSubmitLabel,
  shouldLoginAfterSave,
  type AgentFormData,
  type CredentialSetup,
} from './agentCredentialSetupUtils';
import AgentTypeSelector from './AgentTypeSelector';
import CliVersionSelector from './CliVersionSelector';
import ModelSelector from './ModelSelector';
import { buildSelectableModels } from './modelSelectionHelpers';

interface AgentConfigModalProps {
  agent: AgentConfig | null;
  existingAliases: string[];
  onClose: () => void;
  onSave: (agent: AgentConfig, options?: { loginAfterSave: boolean }) => void;
  saving?: boolean;
}

const AgentConfigModal: React.FC<AgentConfigModalProps> = ({
  agent,
  existingAliases,
  onClose,
  onSave,
  saving = false,
}) => {
  const isEditing = agent !== null;

  const [formData, setFormData] = useState<AgentFormData>(createNewAgentFormData);
  const [credentialSetup, setCredentialSetup] = useState<CredentialSetup>('login');

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [versionData, setVersionData] = useState<AvailableVersionsResponse | null>(null);
  const [versionLoading, setVersionLoading] = useState(false);
  const [discoveredOpenCodeModels, setDiscoveredOpenCodeModels] = useState<string[]>([]);

  // Separate state for API key visibility (password field toggle)
  const [showApiKey, setShowApiKey] = useState(false);

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
    let cancelled = false;
    if (formData.type !== 'opencode') {
      setDiscoveredOpenCodeModels([]);
      return;
    }

    getOpenCodeModels(formData.id)
      .then(data => {
        if (!cancelled) setDiscoveredOpenCodeModels(data.models);
      })
      .catch(error => {
        console.error('Failed to discover OpenCode models:', error);
        if (!cancelled) setDiscoveredOpenCodeModels([]);
      });

    return () => {
      cancelled = true;
    };
  }, [formData.type, formData.id]);

  useEffect(() => {
    if (agent) {
      setCredentialSetup('existing');
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
        modelReasoningLevels: agent.modelReasoningLevels || {},
        envVars: agent.envVars || {},
        cliVersionType: agent.cliVersionType || 'default',
        cliVersion: (agent.cliVersionType || 'default') === 'default' ? undefined : agent.cliVersion,
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
      configPath: (
        (!isEditing && credentialSetup === 'login')
        || isManagedAgentConfigPath(prev.configPath)
      ) && isAgentLoginSupported(newType)
        ? getManagedAgentConfigPath(prev.id!, newType)
        : (prev.configPath === prevDefaults.configPath || isManagedAgentConfigPath(prev.configPath))
          ? defaults.configPath
          : prev.configPath,
      supportedModels: defaults.defaultModels,
      defaultModel: defaults.defaultModels[0],
      // Reset version to default when changing agent type
      cliVersionType: 'default',
      cliVersion: undefined,
      cliVersionResolved: defaults.defaultCliVersion
    }));
  };

  const handleCredentialSetupChange = (next: CredentialSetup) => {
    setCredentialSetup(next);
    setErrors(prev => ({ ...prev, configPath: '' }));
    setFormData(prev => ({
      ...prev,
      configPath: next === 'login' && isAgentLoginSupported(prev.type)
        ? getManagedAgentConfigPath(prev.id!, prev.type)
        : AGENT_DEFAULTS[prev.type].configPath,
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
    const allModels = buildSelectableModels(
      formData.type,
      [...(formData.type === 'opencode' ? discoveredOpenCodeModels : []), ...formData.supportedModels]
    ).map(m => m.id);
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
    if (saving) return;

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

    const cleanedModelReasoningLevels = Object.fromEntries(
      Object.entries(formData.modelReasoningLevels || {})
        .filter(([modelId, level]) => level && formData.supportedModels.includes(modelId))
    );

    // Clean envVars - remove empty values
    const cleanedEnvVars: Record<string, string> = {};
    if (formData.envVars) {
      for (const [key, value] of Object.entries(formData.envVars)) {
        const trimmedValue = value?.trim();
        if (trimmedValue) {
          cleanedEnvVars[key] = trimmedValue;
        }
      }
    }

    const cliVersionType = formData.cliVersionType || 'default';
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
      modelReasoningLevels: Object.keys(cleanedModelReasoningLevels).length > 0
        ? cleanedModelReasoningLevels
        : undefined,
      envVars: Object.keys(cleanedEnvVars).length > 0 ? cleanedEnvVars : undefined,
      cliVersionType,
      cliVersion: cliVersionType === 'default' ? undefined : formData.cliVersion,
      cliVersionResolved: formData.cliVersionResolved
    };

    onSave(agentToSave, {
      loginAfterSave: shouldLoginAfterSave(
        isEditing,
        credentialSetup,
        formData.type,
      ),
    });
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
            disabled={saving}
            aria-label="Close agent configuration"
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-4 space-y-3">
          <AgentTypeSelector value={formData.type} onChange={handleTypeChange} />

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

          {/* Mistral API Key - Only shown for Vibe agents */}
          {formData.type === 'vibe' && (
            <div>
              <label className="block text-gray-700 mb-1.5 font-medium text-sm" htmlFor="mistralApiKey">
                Mistral API Key
              </label>
              <div className="relative">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  id="mistralApiKey"
                  value={formData.envVars?.MISTRAL_API_KEY || ''}
                  onChange={(e) => setFormData(prev => ({
                    ...prev,
                    envVars: { ...prev.envVars, MISTRAL_API_KEY: e.target.value }
                  }))}
                  placeholder="Enter your Mistral API key"
                  className="w-full px-3 py-1.5 pr-10 bg-gray-50 text-gray-900 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 font-mono text-sm"
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  title={showApiKey ? 'Hide API key' : 'Show API key'}
                >
                  {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="mt-1 text-xs text-gray-500 flex items-center gap-1">
                Get your API key from
                <a
                  href="https://chat.mistral.ai/code/extensions"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary-600 hover:text-primary-700 inline-flex items-center gap-0.5"
                >
                  Mistral AI <ExternalLink className="w-3 h-3" />
                </a>
              </p>
            </div>
          )}

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
              placeholder="e.g., primary-claude, fast-antigravity"
              className={`w-full px-3 py-1.5 bg-gray-50 text-gray-900 border rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 font-mono text-sm ${
                errors.alias ? 'border-red-500' : 'border-gray-300'
              }`}
            />
            {errors.alias && <p className="mt-1 text-xs text-red-600">{errors.alias}</p>}
            <p className="mt-1 text-xs text-gray-500">
              Unique identifier using lowercase letters, numbers, and hyphens only.
            </p>
          </div>

          <AgentCredentialSetup
            isEditing={isEditing}
            type={formData.type}
            configPath={formData.configPath}
            credentialSetup={credentialSetup}
            configPathError={errors.configPath}
            onCredentialSetupChange={handleCredentialSetupChange}
            onConfigPathChange={configPath => {
              setFormData(prev => ({ ...prev, configPath }));
            }}
          />

          <ModelSelector
            agentType={formData.type} agentAlias={formData.alias}
            supportedModels={formData.supportedModels}
            defaultModel={formData.defaultModel}
            availableModelIds={formData.type === 'opencode' ? discoveredOpenCodeModels : undefined}
            modelCustomLabels={formData.modelCustomLabels}
            modelReasoningLevels={formData.modelReasoningLevels}
            errors={errors}
            onModelToggle={handleModelToggle}
            onDefaultModelChange={handleDefaultModelChange}
            onSelectAll={handleSelectAllModels}
            onDeselectAll={handleDeselectAllModels}
            onCustomLabelChange={(modelId, label) => setFormData(prev => ({
              ...prev,
              modelCustomLabels: { ...prev.modelCustomLabels, [modelId]: label }
            }))}
            onReasoningLevelChange={(modelId, level) => setFormData(prev => ({
              ...prev,
              modelReasoningLevels: { ...prev.modelReasoningLevels, [modelId]: level }
            }))}
          />

          <AgentEnabledToggle checked={formData.enabled} onChange={enabled => setFormData(prev => ({ ...prev, enabled }))} />
        </form>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-200">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            onClick={handleSubmit}
            disabled={saving}
            className="px-3 py-1.5 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 disabled:cursor-not-allowed disabled:bg-gray-300 rounded-md transition-colors"
          >
            {getAgentSubmitLabel(
              saving,
              isEditing,
              credentialSetup,
              formData.type,
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AgentConfigModal;
