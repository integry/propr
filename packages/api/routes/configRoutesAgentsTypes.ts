import type { RedisClientType } from 'redis';
import type * as configManager from '@propr/core';
import type { AgentConfig } from '@propr/core';
import type { ConfigLockContext } from './configHelpers.js';

export type ApplyAgentsUpdateBody =
  | { success: true; agents: AgentConfig[]; warning?: string; warnings?: string[]; committed?: boolean; out_of_sync?: boolean }
  | { error: string; success?: never; agents?: never; committed?: boolean; out_of_sync?: boolean };

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
  registry?: AgentRegistrySync;
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
  lock?: ConfigLockContext;
  errorContext?: string;
}
