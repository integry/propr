import type { Request, Response } from 'express';
import type { RedisClientType } from 'redis';
import * as configManager from '@propr/core';
import {
  syntheticAgentConfigsSchema,
  validateSyntheticAgentReferences,
  validateExecutableSyntheticDefault,
  type SyntheticAgentConfig,
} from '@propr/shared';
import { ConfigRouteError, SETTINGS_CONFIG_LOCK_KEY, withConfigLock } from './configHelpers.js';
import { saveThenPublishConfigUpdate } from './configRoutesPersistence.js';

interface SyntheticAgentConfigRoutesDeps {
  redisClient: RedisClientType;
  configStore?: Pick<
    typeof configManager,
    'loadAgents' | 'loadSettings' | 'loadSyntheticAgents' | 'saveSyntheticAgents'
  >;
  publishConfigUpdate: (subtype: string) => Promise<void>;
  logActivityHelper: (
    description: string,
    idSuffix: string,
    type: string,
    username?: string,
  ) => Promise<void>;
  refreshAgentRegistry?: () => Promise<void>;
}

function schemaValidationMessage(issues: Array<{ message: string; path: PropertyKey[] }>): string {
  return issues
    .map(issue => `synthetic_agents${issue.path.length ? `.${issue.path.join('.')}` : ''}: ${issue.message}`)
    .join('; ');
}

function parseRequestBody(body: unknown):
  | { syntheticAgents: SyntheticAgentConfig[] }
  | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }
  const result = syntheticAgentConfigsSchema.safeParse(
    (body as Record<string, unknown>).synthetic_agents,
  );
  if (!result.success) {
    return { error: schemaValidationMessage(result.error.issues) };
  }
  return { syntheticAgents: result.data };
}

export function createSyntheticAgentConfigRoutes({
  redisClient,
  configStore = configManager,
  publishConfigUpdate,
  logActivityHelper,
  refreshAgentRegistry,
}: SyntheticAgentConfigRoutesDeps) {
  async function getSyntheticAgents(_req: Request, res: Response): Promise<void> {
    try {
      res.json({ synthetic_agents: await configStore.loadSyntheticAgents() });
    } catch (error) {
      console.error('Error in /api/config/synthetic-agents GET:', error);
      res.status(500).json({ error: 'Failed to load synthetic agents configuration' });
    }
  }

  async function postSyntheticAgents(req: Request, res: Response): Promise<void> {
    const parsed = parseRequestBody(req.body);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const result = await withConfigLock(redisClient, SETTINGS_CONFIG_LOCK_KEY, async lock => {
      const [directAgents, previousSyntheticAgents, settings] = await Promise.all([
        configStore.loadAgents(),
        configStore.loadSyntheticAgents(),
        configStore.loadSettings(),
      ]);
      const validation = validateSyntheticAgentReferences(parsed.syntheticAgents, directAgents);
      if (validation.errors.length > 0) {
        throw new ConfigRouteError(400, { error: validation.errors.join('; ') });
      }

      const configuredDefault = typeof settings.default_agent_alias === 'string'
        ? settings.default_agent_alias.trim()
        : '';
      const wasSyntheticDefault = previousSyntheticAgents.some(agent => agent.alias === configuredDefault);
      const defaultError = validateExecutableSyntheticDefault(
        configuredDefault,
        parsed.syntheticAgents,
        directAgents,
        wasSyntheticDefault,
      );
      if (defaultError) {
        throw new ConfigRouteError(409, {
          error: defaultError,
        });
      }

      return saveThenPublishConfigUpdate({
        save: () => configStore.saveSyntheticAgents(parsed.syntheticAgents),
        publish: () => publishConfigUpdate('synthetic_agents_update'),
        lock,
        publicationContext: 'synthetic_agents_update',
        committedErrorMessage: 'Synthetic agents were saved, but publishing the config update notification failed. Other processes may still be using stale configuration.',
        successBody: {
          success: true,
          synthetic_agents: parsed.syntheticAgents,
          warnings: validation.warnings,
        },
      });
    });

    let responseResult = result;
    const committed = result.status === 200 || result.body.committed === true;
    if (committed && refreshAgentRegistry) {
      try {
        await refreshAgentRegistry();
      } catch (error) {
        console.error('Synthetic agents were saved but the local AgentRegistry refresh failed:', error);
        const refreshError = 'The local AgentRegistry refresh failed, so this process may still be using stale synthetic-agent configuration.';
        const existingError = typeof result.body.error === 'string' ? result.body.error : undefined;
        responseResult = {
          status: 500,
          body: {
            ...result.body,
            success: false,
            error: existingError
              ? `${existingError} ${refreshError}`
              : `Synthetic agents were saved, but the local AgentRegistry refresh failed. This process may still be using stale synthetic-agent configuration.`,
            committed: true,
            registry_out_of_sync: true,
          },
        };
      }
    }
    if (responseResult.status === 200) {
      try {
        await logActivityHelper(
          `Updated synthetic agents configuration (${parsed.syntheticAgents.length} agents)`,
          'synthetic-agents-update',
          'synthetic_agents_updated',
          req.user?.username,
        );
      } catch (error) {
        console.error('Failed to log synthetic agents configuration activity:', error);
      }
    }
    res.status(responseResult.status).json(responseResult.body);
  }

  return { getSyntheticAgents, postSyntheticAgents };
}
