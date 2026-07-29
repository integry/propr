import {
  getManagedAgentConfigPath,
  isAgentLoginSupported,
} from '@propr/shared';
import type { AgentConfig } from '../../api/proprApi';
import {
  AGENT_DEFAULTS,
  type AgentType,
} from '../../config/modelDefinitions';

export type AgentFormData = Omit<AgentConfig, 'id'> & { id?: string };
export type CredentialSetup = 'login' | 'existing';

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
