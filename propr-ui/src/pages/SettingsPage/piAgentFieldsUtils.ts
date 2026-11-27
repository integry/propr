import {
  PI_PROVIDERS,
  getPiLoginProviders,
  getPiProviderApiKeyEnv,
  isValidAgentLoginProvider,
} from '@propr/shared';
import type { AgentConfig } from '../../api/proprApi';

/** `pi-<provider>/<model>`, or undefined when either part is unusable. */
export function buildPiModelId(provider: string, model: string): string | undefined {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim().replace(/^\/+/, '');
  if (!isValidAgentLoginProvider(normalizedProvider) || !normalizedModel || /\s/.test(normalizedModel)) return undefined;
  return `pi-${normalizedProvider}/${normalizedModel}`;
}

/** API key variables for the providers the selected models use, plus keys already set. */
export function piApiKeyEnvNames(supportedModels: string[], defaultModel: string | undefined, envVars: Record<string, string>): string[] {
  const names = getPiLoginProviders(supportedModels, defaultModel)
    .map(provider => getPiProviderApiKeyEnv(provider))
    .filter((name): name is string => Boolean(name));
  for (const name of Object.keys(envVars)) {
    if (/_(API_KEY|TOKEN)$/.test(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Providers the agent's models use first, then the rest of the catalog. */
export function piLoginProviderChoices(agent: Pick<AgentConfig, 'supportedModels' | 'defaultModel'>): string[] {
  const fromModels = getPiLoginProviders(agent.supportedModels, agent.defaultModel);
  return [...fromModels, ...PI_PROVIDERS.map(provider => provider.id).filter(id => !fromModels.includes(id))];
}
