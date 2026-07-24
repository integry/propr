import { Request, Response } from 'express';
import { db, logger } from '@propr/core';
import * as configManager from '@propr/core';
import {
    AgentRegistry,
    resolveVersion,
    computeContentHash,
    generateAgentBundleImageTag,
    getAgentCliVersionMatrix,
    findAgentCliVersionConflicts,
    AGENT_DEFAULT_VERSIONS
} from '@propr/core';
import type { CliVersionType, AgentType, AgentConfig } from '@propr/core';
import type { Knex } from 'knex';
import { withConfigLock, validateAgentsConfig, normalizeAgentsConfig, SETTINGS_CONFIG_LOCK_KEY, upsertConfigValue, buildMergedSettings, stripSpecializedSettings, loadPersistedSettingsRecord, type ConfigLockContext } from './configHelpers.js';
import type { AgentConfigStore, AgentRegistrySync, AgentsRoutesDeps, ApplyAgentsUpdateParams, ApplyAgentsUpdateResult, PersistAgentConfigurationResult, PublishAgentUpdatesParams, RollbackAgentConfigStateParams } from './configRoutesAgentsTypes.js';
async function rollbackAgentConfigState({
  configStore,
  registry,
  previousAgents,
  currentDefault,
  defaultChanged,
  lock,
  errorContext
}: RollbackAgentConfigStateParams): Promise<boolean> {
  try {
    const { settingsWereUpdated } = await persistAgentConfigurationAtomically({
      configStore,
      agents: previousAgents,
      settingsPatch: defaultChanged ? { default_agent_alias: currentDefault } : null,
      lock
    });
    if (settingsWereUpdated) {
      await configStore.handleSettingsSaveSideEffects();
    }
    await lock?.assertLockHeld();
    await registry.refresh();
    registry.setDefaultAgentAlias(currentDefault ?? null);
    return true;
  } catch (rollbackError) {
    if (lock?.hasLockBeenLost()) {
      throw rollbackError;
    }
    console.error(errorContext ?? 'Failed to roll back agent configuration after agents update failure:', rollbackError);
    return false;
  }
}
function resolveDefaultAgentAlias(processedAgents: AgentConfig[], currentDefault: string | undefined): string | undefined {
  const enabledAgents = processedAgents.filter((a: { enabled: boolean }) => a.enabled);
  if (enabledAgents.length === 0) return undefined;
  if (!currentDefault || !enabledAgents.some((a: { alias: string }) => a.alias === currentDefault)) return enabledAgents[0].alias;
  return currentDefault;
}
function requiresExplicitVersionSpec(versionType: CliVersionType): boolean {
  return versionType === 'tag' || versionType === 'specific' || versionType === 'custom';
}
function hasVersionSpec(versionSpec: string | undefined): boolean {
  return typeof versionSpec === 'string' && versionSpec.trim().length > 0;
}
function classifyVersionResolutionError(error: unknown): { message: string; status: number } {
  const message = error instanceof Error ? error.message : 'Unknown version resolution error';
  if (error instanceof TypeError || message.includes('fetch')) {
    return { message, status: 502 };
  }
  if (message.startsWith('NPM registry returned ')
      || message.startsWith('PyPI request failed ')
      || message.startsWith('PyPI request timed out ')) {
    return { message, status: 502 };
  }
  if (message.startsWith('Version spec required') || message.startsWith('Unknown tag ') || message.includes('not found for package')) {
    return { message, status: 400 };
  }
  return { message, status: 500 };
}
async function prepareAgentsUpdate(agents: unknown): Promise<{ error?: string; processedAgents?: AgentConfig[]; status?: number }> {
  if (!Array.isArray(agents)) {
    return { error: 'agents must be an array', status: 400 };
  }
  const normalizedAgents = normalizeAgentsConfig(agents);
  const validationError = validateAgentsConfig(normalizedAgents);
  if (validationError) {
    return { error: validationError, status: 400 };
  }

  const processedAgents: AgentConfig[] = [];
  for (const agent of normalizedAgents) {
    const processedAgent = { ...agent };

    if (agent.cliVersionType) {
      const versionType = agent.cliVersionType as CliVersionType;
      if (requiresExplicitVersionSpec(versionType) && !hasVersionSpec(agent.cliVersion)) {
        return { error: `Failed to resolve version for agent '${agent.alias}': version spec is required for ${versionType} version type`, status: 400 };
      }
      try {
        const agentType = agent.type as AgentType;
        const resolvedVersion = await resolveVersion(agentType, versionType, agent.cliVersion);
        processedAgent.cliVersionResolved = resolvedVersion;
      } catch (versionError) {
        const { message, status } = classifyVersionResolutionError(versionError);
        return { error: `Failed to resolve version for agent '${agent.alias}': ${message}`, status };
      }
    } else {
      const agentType = agent.type as AgentType;
      processedAgent.cliVersionType = 'default';
      processedAgent.cliVersionResolved = AGENT_DEFAULT_VERSIONS[agentType];
    }

    processedAgents.push(processedAgent);
  }

  const versionConflicts = findAgentCliVersionConflicts(processedAgents);
  if (versionConflicts.length > 0) {
    const details = versionConflicts
      .map(conflict => `${conflict.agentType} (${conflict.aliases.join(', ')}: ${conflict.versions.join(' vs ')})`)
      .join('; ');
    return {
      error: `Conflicting CLI versions for the unified agent image: ${details}. Enabled agents of the same type must use the same CLI version.`,
      status: 400
    };
  }

  try {
    const bundleImage = generateAgentBundleImageTag(getAgentCliVersionMatrix(processedAgents), computeContentHash());
    for (const agent of processedAgents) {
      agent.dockerImage = bundleImage;
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Invalid unified agent version configuration', status: 400 };
  }

  return { processedAgents };
}
async function loadProcessedAgents(
  agents: AgentConfig[],
  providedProcessedAgents?: AgentConfig[]
): Promise<{ error?: string; processedAgents?: AgentConfig[]; status?: number }> {
  if (providedProcessedAgents) {
    return { processedAgents: providedProcessedAgents };
  }
  const prepared = await prepareAgentsUpdate(agents);
  if (prepared.error || !prepared.processedAgents) {
    return prepared.error
      ? prepared
      : { status: 500, error: 'Failed to prepare agent configuration update' };
  }
  return { processedAgents: prepared.processedAgents };
}
async function persistAgentConfigurationAtomically({
  configStore,
  agents,
  settingsPatch,
  lock
}: {
  configStore: AgentConfigStore;
  agents: AgentConfig[];
  settingsPatch: Record<string, unknown> | null;
  lock?: ConfigLockContext;
}): Promise<PersistAgentConfigurationResult> {
  let trx: Knex.Transaction | null = null;
  let committed = false;
  try {
    await lock?.assertLockHeld();
    const mergedSettings = buildMergedSettings(
      stripSpecializedSettings(await loadPersistedSettingsRecord(configStore)),
      settingsPatch
    );
    const settingsWereUpdated = mergedSettings !== null;
    trx = await db.transaction();
    const transaction = trx;
    await upsertConfigValue(transaction, 'agents', agents);
    if (settingsWereUpdated) {
      await upsertConfigValue(transaction, 'settings', mergedSettings);
    }
    await lock?.assertLockHeld();
    await transaction.commit();
    committed = true;
    lock?.markCommitted();
    return { settingsWereUpdated };
  } catch (error) {
    if (trx && !committed) {
      try {
        await trx.rollback();
      } catch {
        // Ignore rollback failures after a failed transaction; the original error is more useful.
      }
    }
    throw error;
  }
}
async function applyCommittedAgentsUpdate({
  configStore,
  registry,
  previousAgents,
  currentDefault,
  newDefault,
  settingsWereUpdated,
  defaultChanged,
  lock
}: {
  configStore: AgentConfigStore;
  registry: AgentRegistrySync;
  previousAgents: AgentConfig[];
  currentDefault: string | undefined;
  newDefault: string | undefined;
  settingsWereUpdated: boolean;
  defaultChanged: boolean;
  lock?: ConfigLockContext;
}): Promise<ApplyAgentsUpdateResult | void> {
  try {
    if (settingsWereUpdated) {
      await configStore.handleSettingsSaveSideEffects();
    }
    await lock?.assertLockHeld();
    await registry.refresh();
    registry.setDefaultAgentAlias(newDefault ?? null);
    return;
  } catch (refreshError) {
    const rollbackSucceeded = await rollbackAgentConfigState({
      configStore,
      registry,
      previousAgents,
      currentDefault,
      defaultChanged,
      lock,
      errorContext: 'Failed to roll back agent configuration after live apply failure:'
    });
    console.error('Failed to apply agent configuration after commit:', refreshError);
    if (!rollbackSucceeded) {
      return {
        status: 500,
        body: {
          error: 'Failed to apply committed agent configuration to the live registry, and automatic rollback did not complete. Persisted config may be out of sync with the live registry.',
          out_of_sync: true
        }
      };
    }
    return { status: 500, body: { error: 'Failed to apply agent configuration to the live registry' } };
  }
}
async function publishAgentUpdates({
  processedAgents,
  defaultChanged,
  publishConfigUpdate,
  logActivityHelper,
  username
}: PublishAgentUpdatesParams): Promise<void> {
  await publishConfigUpdate('agents_update');
  if (defaultChanged) {
    await publishConfigUpdate('settings_update');
  }
  try {
    await logActivityHelper(`Updated agents configuration (${processedAgents.length} agents)`, 'agents-update', 'agents_updated', username);
  } catch (error) {
    console.error('Failed to log agents configuration update activity:', error);
  }
}
export async function applyAgentsUpdate({
  agents,
  processedAgents: providedProcessedAgents,
  username,
  publishConfigUpdate,
  logActivityHelper,
  configStore = configManager,
  registry = AgentRegistry.getInstance(),
  lock
}: ApplyAgentsUpdateParams): Promise<ApplyAgentsUpdateResult> {
  const preparedAgents = await loadProcessedAgents(agents, providedProcessedAgents);
  if (preparedAgents.error) {
    return { status: preparedAgents.status ?? 400, body: { error: preparedAgents.error } };
  }
  const processedAgents = preparedAgents.processedAgents;
  if (!processedAgents) {
    return { status: 500, body: { error: 'Failed to prepare agent configuration update' } };
  }

  const previousAgents = await configStore.loadAgents();
  const settings = await configStore.loadSettings();
  const currentDefault = ((settings as Record<string, unknown>).default_agent_alias as string | undefined) ?? undefined;
  const newDefault = resolveDefaultAgentAlias(processedAgents, currentDefault);
  const defaultChanged = newDefault !== currentDefault;

  try {
    const { settingsWereUpdated } = await persistAgentConfigurationAtomically({
      configStore,
      agents: processedAgents,
      settingsPatch: defaultChanged ? { default_agent_alias: newDefault } : null,
      lock
    });
    const liveApplyResult = await applyCommittedAgentsUpdate({
      configStore,
      registry,
      previousAgents,
      currentDefault,
      newDefault,
      settingsWereUpdated,
      defaultChanged,
      lock
    });
    if (liveApplyResult) {
      return liveApplyResult;
    }
  } catch (syncError) {
    if (lock?.hasLockBeenLost()) {
      throw syncError;
    }
    console.error('Failed to persist agent configuration atomically:', syncError);
    return {
      status: 500,
      body: {
        error: 'Failed to persist agent configuration. No changes were committed. Please retry or check system logs.'
      }
    };
  }

  let publishResult: ApplyAgentsUpdateResult | null = null;
  try {
    await publishAgentUpdates({ processedAgents, defaultChanged, publishConfigUpdate, logActivityHelper, username });
  } catch (error) {
    if (lock?.hasLockBeenLost()) {
      throw error;
    }
    console.error('Failed to publish agent configuration updates after commit:', error);
    publishResult = {
      status: 500,
      body: {
        error: 'Agent configuration was saved, but publishing the config update notification failed. Other processes may still be using stale configuration.',
        committed: true
      }
    };
  }

  if (publishResult) {
    return publishResult;
  }

  let warnings: string[] = [];
  if (configStore.loadModelReasoningLevel) {
    try {
      warnings = configManager.findReasoningLevelCliVersionWarnings(
        processedAgents,
        await configStore.loadModelReasoningLevel()
      );
    } catch (warningError) {
      console.warn('Could not evaluate reasoning-level CLI compatibility after agents save:', warningError);
    }
  }

  return {
    status: 200,
    body: {
      success: true,
      agents: processedAgents,
      ...(warnings.length > 0 ? { warnings } : {})
    }
  };
}

export function createAgentsRoutes(deps: AgentsRoutesDeps) {
  const { redisClient, publishConfigUpdate, logActivityHelper, applyAgentsUpdateFn } = deps;
  const effectiveApplyFn = applyAgentsUpdateFn ?? applyAgentsUpdate;
  async function getAgents(_req: Request, res: Response): Promise<void> {
    try {
      res.json({ agents: await configManager.loadAgents() });
    } catch (error) {
      console.error('Error in /api/config/agents GET:', error);
      res.status(500).json({ error: 'Failed to load agents configuration' });
    }
  }
  async function postAgents(req: Request, res: Response): Promise<void> {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: 'Request body must be a JSON object' });
      return;
    }
    const prepared = await prepareAgentsUpdate(req.body.agents);
    if (prepared.error) {
      res.status(prepared.status ?? 400).json({ error: prepared.error });
      return;
    }
    if (!prepared.processedAgents) {
      res.status(500).json({ error: 'Failed to prepare agent configuration update' });
      return;
    }

    // Agent updates share the settings lock because they may also rewrite default_agent_alias.
    const result = await withConfigLock(redisClient, SETTINGS_CONFIG_LOCK_KEY, async lock => {
      return effectiveApplyFn({ agents: req.body.agents, processedAgents: prepared.processedAgents, username: req.user?.username, publishConfigUpdate, logActivityHelper, lock });
    });

    if (!result || typeof result.status !== 'number' || !result.body) {
      logger.error({ hasResult: !!result, statusType: typeof result?.status, hasBody: !!result?.body, resultKeys: result ? Object.keys(result) : [] }, 'applyAgentsUpdate returned unexpected shape — possible bug in withConfigLock or applyFn');
      res.status(500).json({ error: 'Unexpected response from agent configuration update' });
      return;
    }
    res.status(result.status).json(result.body);
  }
  return { getAgents, postAgents };
}
