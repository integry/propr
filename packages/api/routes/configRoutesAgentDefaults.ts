import type * as configManager from '@propr/core';
import { validateExecutableSyntheticDefault } from '@propr/shared';
import { ConfigRouteError } from './configHelpers.js';

type DefaultAgentConfigStore = Pick<
  typeof configManager,
  'loadSettings' | 'loadSyntheticAgents' | 'loadAgents'
>;

export async function validateDefaultAgentSetting(
  settings: Record<string, unknown>,
  configStore: DefaultAgentConfigStore,
): Promise<void> {
  const [currentSettings, syntheticAgents, directAgents] = await Promise.all([
    configStore.loadSettings(),
    configStore.loadSyntheticAgents(),
    configStore.loadAgents(),
  ]);
  const effectiveDefault = typeof settings.default_agent_alias === 'string'
    ? settings.default_agent_alias
    : typeof (currentSettings as Record<string, unknown>).default_agent_alias === 'string'
      ? ((currentSettings as Record<string, unknown>).default_agent_alias as string).trim()
      : '';
  const defaultError = validateExecutableSyntheticDefault(effectiveDefault, syntheticAgents, directAgents);
  if (defaultError) throw new ConfigRouteError(409, { error: defaultError });
}
