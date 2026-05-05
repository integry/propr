import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { db } from '@propr/core';
import * as configManager from '@propr/core';
import {
    AgentRegistry,
    resolveVersion,
    computeContentHash,
    generateImageTag,
    AGENT_DEFAULT_VERSIONS
} from '@propr/core';
import type { CliVersionType, AgentType, AgentConfig } from '@propr/core';
import type { Knex } from 'knex';
import { withConfigLock, validateAgentsConfig, normalizeAgentsConfig, SETTINGS_CONFIG_LOCK_KEY, upsertConfigValue, buildMergedSettings, type ConfigLockContext } from './configHelpers.js';

interface AgentsRoutesDeps {
  redisClient: RedisClientType;
  publishConfigUpdate: (subtype: string) => Promise<void>;
  logActivityHelper: (description: string, idSuffix: string, type: string, username?: string) => Promise<void>;
}

interface AgentConfigStore {
  loadAgents: typeof configManager.loadAgents;
  loadSettings: typeof configManager.loadSettings;
  handleSettingsSaveSideEffects: typeof configManager.handleSettingsSaveSideEffects;
}

interface AgentRegistrySync {
  refresh: () => Promise<void>;
  setDefaultAgentAlias: (alias: string | null) => void;
}

interface ApplyAgentsUpdateParams {
  agents: AgentConfig[];
  processedAgents?: AgentConfig[];
  username?: string;
  publishConfigUpdate: AgentsRoutesDeps['publishConfigUpdate'];
  logActivityHelper: AgentsRoutesDeps['logActivityHelper'];
  configStore?: AgentConfigStore;
  registry?: AgentRegistrySync;
  lock?: ConfigLockContext;
}

interface PersistAgentConfigurationResult {
  settingsWereUpdated: boolean;
}

interface RollbackAgentConfigStateParams {
  configStore: AgentConfigStore;
  registry: AgentRegistrySync;
  previousAgents: AgentConfig[];
  currentDefault: string | undefined;
  defaultChanged: boolean;
  lock?: ConfigLockContext;
  errorContext?: string;
}

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
      configStore.handleSettingsSaveSideEffects();
    }
    await lock?.assertLockHeld();
    await registry.refresh();
    await lock?.assertLockHeld();
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

function classifyVersionResolutionError(error: unknown): { message: string; status: number } {
  const message = error instanceof Error ? error.message : 'Unknown version resolution error';
  if (message === 'Version spec required for tag type' || message === 'Version spec required' || message.startsWith('Version \'')) {
    return { message, status: 400 };
  }
  return { message, status: 502 };
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
      try {
        const agentType = agent.type as AgentType;
        const versionType = agent.cliVersionType as CliVersionType;
        const resolvedVersion = await resolveVersion(agentType, versionType, agent.cliVersion);
        processedAgent.cliVersionResolved = resolvedVersion;
        processedAgent.dockerImage = generateImageTag(agentType, resolvedVersion, computeContentHash(agentType));
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

  return { processedAgents };
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
      await configStore.loadSettings() as Record<string, unknown>,
      settingsPatch
    );
    const settingsWereUpdated = mergedSettings !== null;
    trx = await db.transaction();
    const transaction = trx;
    await upsertConfigValue(transaction, 'agents', agents);
    if (settingsWereUpdated) {
      await lock?.assertLockHeld();
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

export async function applyAgentsUpdate({
  agents,
  processedAgents: providedProcessedAgents,
  username,
  publishConfigUpdate,
  logActivityHelper,
  configStore = configManager,
  registry = AgentRegistry.getInstance(),
  lock
}: ApplyAgentsUpdateParams): Promise<{ status: number; body: Record<string, unknown> }> {
  let processedAgents = providedProcessedAgents;
  if (!processedAgents) {
    const prepared = await prepareAgentsUpdate(agents);
    if (prepared.error) {
      return { status: prepared.status ?? 400, body: { error: prepared.error } };
    }
    processedAgents = prepared.processedAgents;
  }
  if (!processedAgents) {
    return { status: 500, body: { error: 'Failed to prepare agent configuration update' } };
  }

  await lock?.assertLockHeld();
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
    try {
      if (settingsWereUpdated) {
        configStore.handleSettingsSaveSideEffects();
      }
      await lock?.assertLockHeld();
      await registry.refresh();
      await lock?.assertLockHeld();
      registry.setDefaultAgentAlias(newDefault ?? null);
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

  await publishConfigUpdate('agents_update');
  if (defaultChanged) {
    await publishConfigUpdate('settings_update');
  }
  try {
    await logActivityHelper(`Updated agents configuration (${processedAgents.length} agents)`, 'agents-update', 'agents_updated', username);
  } catch (error) {
    console.error('Failed to log agents configuration update activity:', error);
  }

  return { status: 200, body: { success: true, agents: processedAgents } };
}

export function createAgentsRoutes(deps: AgentsRoutesDeps) {
  const { redisClient, publishConfigUpdate, logActivityHelper } = deps;

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
      return applyAgentsUpdate({
        agents: req.body.agents,
        processedAgents: prepared.processedAgents,
        username: req.user?.username,
        publishConfigUpdate,
        logActivityHelper,
        lock
      });
    });

    res.status(result.status).json(result.body);
  }

  return {
    getAgents,
    postAgents
  };
}
