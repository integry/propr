import type { RedisClientType } from 'redis';
import type * as configManager from '@propr/core';
import type { AgentConfig } from '@propr/core';
import type { resolveVersion, computeContentHash, generateAgentBundleImageTag } from '@propr/core';
import type { Knex } from 'knex';
import type { ConfigLockContext } from './configHelpers.js';

export type ApplyAgentsUpdateBody =
  | { success: true; agents: AgentConfig[]; warning?: string; warnings?: string[]; committed?: boolean; out_of_sync?: boolean }
  | { code?: string; error: string; success?: never; agents?: never; committed?: boolean; out_of_sync?: boolean };

export interface ApplyAgentsUpdateResult {
  status: number;
  body: ApplyAgentsUpdateBody;
}

export interface AgentsRoutesDeps {
  redisClient: RedisClientType;
  publishConfigUpdate: (subtype: string) => Promise<void>;
  logActivityHelper: (description: string, idSuffix: string, type: string, username?: string) => Promise<void>;
  /** @internal Test-only override for the agent-update function. */
  applyAgentsUpdateFn?: (params: ApplyAgentsUpdateParams) => Promise<ApplyAgentsUpdateResult>;
  configStore?: AgentConfigStore;
  database?: Pick<Knex, 'transaction'>;
  registry?: AgentRegistrySync;
  preparationDeps?: Partial<AgentPreparationDeps>;
}

export interface AgentPreparationDeps {
  resolveVersion: typeof resolveVersion;
  computeContentHash: typeof computeContentHash;
  generateAgentBundleImageTag: typeof generateAgentBundleImageTag;
}

export interface AgentConfigStore {
  loadAgents: typeof configManager.loadAgents;
  loadSettings: typeof configManager.loadSettings;
  loadSettingsRecord?: () => Promise<Record<string, unknown>>;
  loadModelReasoningLevel?: typeof configManager.loadModelReasoningLevel;
  handleSettingsSaveSideEffects: typeof configManager.handleSettingsSaveSideEffects;
}

export interface AgentRegistrySync {
  refresh: () => Promise<void>;
  setDefaultAgentAlias: (alias: string | null) => void;
}

export interface ApplyAgentsUpdateParams {
  agents: AgentConfig[];
  processedAgents?: AgentConfig[];
  username?: string;
  publishConfigUpdate: AgentsRoutesDeps['publishConfigUpdate'];
  logActivityHelper: AgentsRoutesDeps['logActivityHelper'];
  configStore?: AgentConfigStore;
  database?: Pick<Knex, 'transaction'>;
  registry?: AgentRegistrySync;
  preparationDeps?: Partial<AgentPreparationDeps>;
  lock?: ConfigLockContext;
}

export interface PublishAgentUpdatesParams {
  processedAgents: AgentConfig[];
  defaultChanged: boolean;
  publishConfigUpdate: AgentsRoutesDeps['publishConfigUpdate'];
  logActivityHelper: AgentsRoutesDeps['logActivityHelper'];
  username?: string;
}

export interface PersistAgentConfigurationResult {
  settingsWereUpdated: boolean;
}

export interface RollbackAgentConfigStateParams {
  configStore: AgentConfigStore;
  registry: AgentRegistrySync;
  previousAgents: AgentConfig[];
  currentDefault: string | undefined;
  defaultChanged: boolean;
  database: Pick<Knex, 'transaction'>;
  lock?: ConfigLockContext;
  errorContext?: string;
}
