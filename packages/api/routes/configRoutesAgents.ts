import { Request, Response } from 'express';
import { db, logger } from '@propr/core';
import * as configManager from '@propr/core';
import { AgentRegistry } from '@propr/core';
import type { AgentConfig } from '@propr/core';
import type { Knex } from 'knex';
import {
  findSyntheticReferencesToDirectAgent,
  validateSyntheticAgentReferences,
  type SyntheticAgentConfig,
} from '@propr/shared';
import { withConfigLock, SETTINGS_CONFIG_LOCK_KEY, upsertConfigValue, buildMergedSettings, stripSpecializedSettings, loadPersistedSettingsRecord, type ConfigLockContext } from './configHelpers.js';
import type { AgentConfigStore, AgentRegistrySync, AgentsRoutesDeps, ApplyAgentsUpdateParams, ApplyAgentsUpdateResult, PersistAgentConfigurationResult, PublishAgentUpdatesParams, RollbackAgentConfigStateParams } from './configRoutesAgentsTypes.js';
import { DEFAULT_PREPARATION_DEPS, loadProcessedAgents, prepareAgentsUpdate, resolveDefaultAgentAlias } from './configRoutesAgentsPreparation.js';
function buildAgentPreparationError(error: string, code?: string): { code?: string; error: string } {
  return code ? { code, error } : { error };
}
function validateDirectAgentUpdateIntegrity(
  previousAgents: AgentConfig[],
  processedAgents: AgentConfig[],
  syntheticAgents: SyntheticAgentConfig[],
): ApplyAgentsUpdateResult | undefined {
  const proposedAliases = new Set(processedAgents.map(agent => agent.alias));
  const removalConflicts = previousAgents.flatMap(agent => {
    if (proposedAliases.has(agent.alias)) return [];
    const references = findSyntheticReferencesToDirectAgent(syntheticAgents, agent.alias);
    return references.length > 0 ? [{ alias: agent.alias, references }] : [];
  });
  if (removalConflicts.length > 0) {
    const details = removalConflicts
      .map(conflict => `Direct agent '${conflict.alias}' is referenced by ${conflict.references.join(', ')}`)
      .join('; ');
    return {
      status: 409,
      body: { error: `${details}. Remove those synthetic pool members before deleting the direct agent.` },
    };
  }

  const referenceValidation = validateSyntheticAgentReferences(syntheticAgents, processedAgents);
  return referenceValidation.errors.length > 0
    ? { status: 400, body: { error: referenceValidation.errors.join('; ') } }
    : undefined;
}
async function rollbackAgentConfigState({
  configStore,
  registry,
  previousAgents,
  currentDefault,
  defaultChanged,
  database,
  lock,
  errorContext
}: RollbackAgentConfigStateParams): Promise<boolean> {
  try {
    const { settingsWereUpdated } = await persistAgentConfigurationAtomically({
      configStore,
      agents: previousAgents,
      settingsPatch: defaultChanged ? { default_agent_alias: currentDefault } : null,
      database,
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
async function persistAgentConfigurationAtomically({
  configStore,
  agents,
  settingsPatch,
  database,
  lock
}: {
  configStore: AgentConfigStore;
  agents: AgentConfig[];
  settingsPatch: Record<string, unknown> | null;
  database: Pick<Knex, 'transaction'>;
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
    trx = await database.transaction();
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
  database,
  lock
}: {
  configStore: AgentConfigStore;
  registry: AgentRegistrySync;
  previousAgents: AgentConfig[];
  currentDefault: string | undefined;
  newDefault: string | undefined;
  settingsWereUpdated: boolean;
  defaultChanged: boolean;
  database: Pick<Knex, 'transaction'>;
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
      database,
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
async function loadReasoningLevelWarnings(
  configStore: AgentConfigStore,
  agents: AgentConfig[],
): Promise<string[]> {
  if (!configStore.loadModelReasoningLevel) return [];
  try {
    return configManager.findReasoningLevelCliVersionWarnings(
      agents,
      await configStore.loadModelReasoningLevel(),
    );
  } catch (warningError) {
    console.warn('Could not evaluate reasoning-level CLI compatibility after agents save:', warningError);
    return [];
  }
}
function resolveUpdatedDefaultAgent(
  processedAgents: AgentConfig[],
  syntheticAgents: SyntheticAgentConfig[],
  currentDefault: string | undefined,
): string | undefined {
  return syntheticAgents.some(agent => agent.enabled && agent.alias === currentDefault)
    ? currentDefault
    : resolveDefaultAgentAlias(processedAgents, currentDefault);
}
export async function applyAgentsUpdate({
  agents,
  processedAgents: providedProcessedAgents,
  username,
  publishConfigUpdate,
  logActivityHelper,
  configStore = configManager,
  database = db,
  registry = AgentRegistry.getInstance(),
  preparationDeps: preparationOverrides,
  lock
}: ApplyAgentsUpdateParams): Promise<ApplyAgentsUpdateResult> {
  const preparationDeps = { ...DEFAULT_PREPARATION_DEPS, ...preparationOverrides };
  const preparedAgents = await loadProcessedAgents(agents, providedProcessedAgents, preparationDeps);
  if (preparedAgents.error) {
    return {
      status: preparedAgents.status ?? 400,
      body: buildAgentPreparationError(preparedAgents.error, preparedAgents.code),
    };
  }
  const processedAgents = preparedAgents.processedAgents;
  if (!processedAgents) {
    return { status: 500, body: { error: 'Failed to prepare agent configuration update' } };
  }

  const previousAgents = await configStore.loadAgents();
  const syntheticAgents = configStore.loadSyntheticAgents
    ? await configStore.loadSyntheticAgents()
    : [];
  const integrityError = validateDirectAgentUpdateIntegrity(previousAgents, processedAgents, syntheticAgents);
  if (integrityError) return integrityError;
  const settings = await configStore.loadSettings();
  const currentDefault = ((settings as Record<string, unknown>).default_agent_alias as string | undefined) ?? undefined;
  const newDefault = resolveUpdatedDefaultAgent(processedAgents, syntheticAgents, currentDefault);
  const defaultChanged = newDefault !== currentDefault;

  try {
    const { settingsWereUpdated } = await persistAgentConfigurationAtomically({
      configStore,
      agents: processedAgents,
      settingsPatch: defaultChanged ? { default_agent_alias: newDefault } : null,
      database,
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
      database,
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

  const warnings = await loadReasoningLevelWarnings(configStore, processedAgents);

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
  const {
    redisClient,
    publishConfigUpdate,
    logActivityHelper,
    applyAgentsUpdateFn,
    configStore = configManager,
    database = db,
    registry = AgentRegistry.getInstance(),
    preparationDeps: preparationOverrides,
  } = deps;
  const preparationDeps = { ...DEFAULT_PREPARATION_DEPS, ...preparationOverrides };
  const effectiveApplyFn = applyAgentsUpdateFn ?? applyAgentsUpdate;
  async function getAgents(_req: Request, res: Response): Promise<void> {
    try {
      res.json({ agents: await configStore.loadAgents() });
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
    const prepared = await prepareAgentsUpdate(req.body.agents, preparationDeps);
    if (prepared.error) {
      res.status(prepared.status ?? 400).json(buildAgentPreparationError(prepared.error, prepared.code));
      return;
    }
    if (!prepared.processedAgents) {
      res.status(500).json({ error: 'Failed to prepare agent configuration update' });
      return;
    }

    // Agent updates share the settings lock because they may also rewrite default_agent_alias.
    const result = await withConfigLock(redisClient, SETTINGS_CONFIG_LOCK_KEY, async lock => {
      return effectiveApplyFn({
        agents: req.body.agents,
        processedAgents: prepared.processedAgents,
        username: req.user?.username,
        publishConfigUpdate,
        logActivityHelper,
        configStore,
        database,
        registry,
        preparationDeps,
        lock,
      });
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
