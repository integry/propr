import {
  getManagedAgentConfigPath,
  isAgentLoginSupported,
  type ReasoningLevel,
} from '@propr/shared';
import type { AgentConfig } from '../../api/proprApi';
import {
  AGENT_DEFAULTS,
  type AgentType,
} from '../../config/modelDefinitions';

export type AgentFormData = Omit<AgentConfig, 'id'> & { id?: string };
export type CredentialSetup = 'login' | 'existing';

export function updateModelReasoningLevel(
  formData: AgentFormData,
  modelId: string,
  level: ReasoningLevel | '',
): AgentFormData {
  const modelReasoningLevels = { ...formData.modelReasoningLevels };
  if (level) modelReasoningLevels[modelId] = level;
  else delete modelReasoningLevels[modelId];
  return { ...formData, modelReasoningLevels };
}

export function validateAgentFormData(
  formData: AgentFormData,
  existingAliases: string[],
  originalAlias?: string,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!formData.alias) errors.alias = 'Alias is required';
  else if (!/^[a-z0-9-]+$/.test(formData.alias)) {
    errors.alias = 'Alias must only contain lowercase letters, numbers, and hyphens';
  } else if (formData.alias !== originalAlias && existingAliases.includes(formData.alias)) {
    errors.alias = 'This alias is already in use';
  }
  if (!formData.configPath) errors.configPath = 'Config path is required';
  if (formData.supportedModels.length === 0) errors.supportedModels = 'At least one model is required';
  return errors;
}

export function buildAgentConfig(formData: AgentFormData): AgentConfig {
  const modelCustomLabels = Object.fromEntries(
    Object.entries(formData.modelCustomLabels || {})
      .map(([modelId, label]) => [modelId, label?.trim()])
      .filter(([modelId, label]) => label && formData.supportedModels.includes(modelId)),
  );
  const modelReasoningLevels = Object.fromEntries(
    Object.entries(formData.modelReasoningLevels || {})
      .filter(([modelId, level]) => level && formData.supportedModels.includes(modelId)),
  );
  const envVars = Object.fromEntries(
    Object.entries(formData.envVars || {})
      .map(([key, value]) => [key, value?.trim()])
      .filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  const cliVersionType = formData.cliVersionType || 'default';
  return {
    ...formData,
    id: formData.id || crypto.randomUUID(),
    modelCustomLabels: Object.keys(modelCustomLabels).length > 0 ? modelCustomLabels : undefined,
    modelReasoningLevels: Object.keys(modelReasoningLevels).length > 0 ? modelReasoningLevels : undefined,
    envVars: Object.keys(envVars).length > 0 ? envVars : undefined,
    cliVersionType,
    cliVersion: cliVersionType === 'default' ? undefined : formData.cliVersion,
  };
}

export function createNewAgentFormData(): AgentFormData {
  const id = crypto.randomUUID();
  return {
    id,
    type: 'claude',
    alias: AGENT_DEFAULTS.claude.defaultAlias,
    enabled: true,
    dockerImage: AGENT_DEFAULTS.claude.dockerImage,
    configPath: getManagedAgentConfigPath(id, 'claude'),
    supportedModels: AGENT_DEFAULTS.claude.defaultModels,
    defaultModel: AGENT_DEFAULTS.claude.defaultModels[0],
    modelCustomLabels: {},
    modelReasoningLevels: {},
    envVars: {},
    cliVersionType: 'default',
    cliVersion: undefined,
    cliVersionResolved: AGENT_DEFAULTS.claude.defaultCliVersion,
  };
}

export function shouldLoginAfterSave(
  isEditing: boolean,
  credentialSetup: CredentialSetup,
  type: AgentType,
): boolean {
  return !isEditing
    && credentialSetup === 'login'
    && isAgentLoginSupported(type);
}

export function getAgentSubmitLabel(
  saving: boolean,
  isEditing: boolean,
  credentialSetup: CredentialSetup,
  type: AgentType,
): string {
  if (saving) return 'Saving…';
  if (isEditing) return 'Save Changes';
  return shouldLoginAfterSave(false, credentialSetup, type)
    ? 'Add Agent & Log In'
    : 'Add Agent';
}
