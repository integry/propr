import {
  PI_PROVIDERS,
  getPiLoginProviders,
  getPiProviderInfo,
  getPiProviderApiKeyEnv,
  isValidAgentLoginProvider,
} from '@propr/shared';
import type { AgentConfig } from '../../api/proprApi';
import { getModelDisplayName } from '../../utils/modelDisplay';

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

/**
 * Provider-key variables only a type's own fields show (Pi's API keys, Vibe's
 * Mistral key). The modal has no generic env-var editor, so these are dropped
 * when the agent changes type: kept, they would stay saved but invisible, and
 * e.g. an ANTHROPIC_API_KEY would make Claude Code bill that key instead of the login.
 */
export function providerKeyEnvNames(
  type: AgentConfig['type'],
  agent: Pick<AgentConfig, 'supportedModels' | 'defaultModel' | 'envVars'>,
): string[] {
  if (type === 'pi') return piApiKeyEnvNames(agent.supportedModels, agent.defaultModel, agent.envVars ?? {});
  if (type === 'vibe') return ['MISTRAL_API_KEY'];
  return [];
}

/** The env vars left after a type change from `previousType`. */
export function envVarsAfterTypeChange(
  previousType: AgentConfig['type'],
  agent: Pick<AgentConfig, 'supportedModels' | 'defaultModel' | 'envVars'>,
): Record<string, string> {
  const dropped = new Set(providerKeyEnvNames(previousType, agent));
  return Object.fromEntries(Object.entries(agent.envVars ?? {}).filter(([name]) => !dropped.has(name)));
}

/** Providers the agent's models use first, then the rest of the catalog. */
export function piLoginProviderChoices(agent: Pick<AgentConfig, 'supportedModels' | 'defaultModel'>): string[] {
  const fromModels = getPiLoginProviders(agent.supportedModels, agent.defaultModel);
  return [...fromModels, ...PI_PROVIDERS.map(provider => provider.id).filter(id => !fromModels.includes(id))];
}

/**
 * A readable description of a `pi-<provider>/<model>` id: the model's
 * catalog or humanized name and the provider's label, never the raw id.
 */
export function describePiModel(modelId: string): string {
  const match = /^pi-([^/]+)\/(.+)$/.exec(modelId);
  if (!match) return getModelDisplayName(modelId);
  const [, provider, model] = match;
  const providerLabel = getPiProviderInfo(provider)?.label ?? getModelDisplayName(provider);
  return `${getModelDisplayName(model)} via ${providerLabel}`;
}
