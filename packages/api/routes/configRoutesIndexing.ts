import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import * as configManager from '@propr/core';
import { publishIndexingStatus } from '@propr/core';
import { cancelDelayedReindex, queueIndexingJob, queueResummarizationForAllRepos, scheduleDelayedReindex, stopIndexingJob } from './indexingQueueHelpers.js';
import { validateIndexingInput, validateStopIndexingInput } from './indexingRouteHelpers.js';

interface IndexingRoutesDeps {
  redisClient: RedisClientType;
  publishConfigUpdate: (subtype: string) => Promise<void>;
  logActivityHelper: (description: string, idSuffix: string, type: string, username?: string) => Promise<void>;
}

export function createIndexingRoutes(deps: IndexingRoutesDeps) {
  const { redisClient, publishConfigUpdate, logActivityHelper } = deps;

  async function getRepositoriesIndexingStatus(_req: Request, res: Response): Promise<void> {
    try {
      const statuses = await configManager.getRepositoriesIndexingStatus();
      res.json({ repositories: statuses });
    } catch (error) {
      console.error('Error in /api/config/repos/indexing-status GET:', error);
      res.status(500).json({ error: 'Failed to load repositories indexing status' });
    }
  }

  async function triggerIndexing(req: Request, res: Response): Promise<void> {
    try {
      const validationError = validateIndexingInput(req.body);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }

      const { repository, fullReindex, baseBranch } = req.body as {
        repository: string;
        fullReindex?: boolean;
        baseBranch?: string;
        ignoreCooldown?: boolean;
      };
      const shouldRunFullReindex = fullReindex === true;
      const ignoreCooldown = req.body.ignoreCooldown === true;
      const result = await queueIndexingJob(repository, shouldRunFullReindex, baseBranch, { ignoreCooldown });
      if (!result.success) {
        const isAlreadyQueued = result.error?.includes('already queued');
        const statusCode = isAlreadyQueued ? 409 : 400;
        res.status(statusCode).json({ error: result.error });
        return;
      }

      // Best-effort optimistic status for newly accepted jobs only.
      try {
        await publishIndexingStatus(repository, baseBranch || 'HEAD', 'indexing');
      } catch (pubErr) {
        console.warn('Failed to publish optimistic indexing status:', pubErr);
      }

      await logActivityHelper(
        `Triggered ${shouldRunFullReindex ? 'full re-' : ''}indexing for ${repository}${baseBranch ? ` (branch: ${baseBranch})` : ''}`,
        'indexing-trigger', 'indexing_triggered', req.user?.username
      );

      res.json({ success: true, jobId: result.jobId, correlationId: result.correlationId, repository, fullReindex: shouldRunFullReindex, baseBranch, ignoreCooldown });
    } catch (error) {
      console.error('Error in /api/config/repos/trigger-indexing POST:', error);
      res.status(500).json({ error: 'Failed to trigger indexing' });
    }
  }

  async function triggerResummarizationSafe(ignoreCooldown: boolean): Promise<number> {
    try {
      return await queueResummarizationForAllRepos({ ignoreCooldown });
    } catch (error) {
      console.error('Error triggering resummarization for repositories:', error);
      return 0;
    }
  }

  async function triggerReindexAll(req: Request, res: Response): Promise<void> {
    try {
      if (req.body?.ignoreCooldown !== undefined && typeof req.body.ignoreCooldown !== 'boolean') {
        res.status(400).json({ error: 'ignoreCooldown must be a boolean' });
        return;
      }
      const settings = await configManager.loadSummarizationSettings();
      if (!settings.enabled) {
        res.status(400).json({ error: 'Summarization is not enabled. Enable it in settings first.' });
        return;
      }
      if (!settings.agent_alias) {
        res.status(400).json({ error: 'No agent configured for summarization. Configure one in settings first.' });
        return;
      }

      await cancelDelayedReindex(redisClient);
      const ignoreCooldown = req.body?.ignoreCooldown === true;
      const repositoriesQueued = await triggerResummarizationSafe(ignoreCooldown);

      await logActivityHelper(
        `Manually triggered reindexing for ${repositoriesQueued} repositories`,
        'reindex-all-trigger', 'reindex_all_triggered', req.user?.username
      );

      res.json({ success: true, repositoriesQueued, ignoreCooldown });
    } catch (error) {
      console.error('Error in /api/config/summarization/reindex-all POST:', error);
      res.status(500).json({ error: 'Failed to trigger reindexing' });
    }
  }

  async function stopIndexing(req: Request, res: Response): Promise<void> {
    try {
      const validationError = validateStopIndexingInput(req.body);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }

      const { repository, branch } = req.body as {
        repository: string;
        branch?: string;
      };
      const result = await stopIndexingJob(repository, branch);

      if (!result.success) {
        res.status(500).json({ error: result.message || 'Failed to stop indexing' });
        return;
      }

      // Emit idle immediately for both removed queued jobs and cancellation requests.
      // Active workers may still emit a later terminal event after they observe the
      // cancellation flag, but the UI should reflect the stop request right away.
      const branchesToPublish = new Set([
        ...result.cancelledActiveBranches,
        ...result.removedQueuedBranches
      ]);
      for (const queuedBranch of branchesToPublish) {
        try {
          await publishIndexingStatus(repository, queuedBranch, 'idle');
        } catch {
          // Best-effort — don't fail the stop request if publishing fails
        }
      }

      const branchInfo = branch ? ` (branch: ${branch})` : '';
      await logActivityHelper(
        `Stopped indexing for ${repository}${branchInfo}`,
        'indexing-stop',
        'indexing_stopped',
        req.user?.username
      );

      res.json({ success: true });
    } catch (error) {
      console.error('Error in /api/config/repos/stop-indexing POST:', error);
      res.status(500).json({ error: 'Failed to stop indexing' });
    }
  }

  function validateSummarizationInput(body: unknown): string | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'request body must be an object';
    const { enabled, agent_alias, fallback_agent_alias, custom_prompt } = body as Record<string, unknown>;
    if (typeof enabled !== 'boolean') return 'enabled must be a boolean';
    if (agent_alias !== undefined && typeof agent_alias !== 'string') return 'agent_alias must be a string';
    if (fallback_agent_alias !== undefined && typeof fallback_agent_alias !== 'string') return 'fallback_agent_alias must be a string';
    if (agent_alias && fallback_agent_alias && agent_alias === fallback_agent_alias) return 'fallback_agent_alias must differ from agent_alias';
    if (custom_prompt !== undefined && typeof custom_prompt !== 'string') return 'custom_prompt must be a string';
    return null;
  }

  function buildSummarizationDescription(
    settings: { enabled: boolean; agent_alias: string; fallback_agent_alias: string },
    promptChanged: boolean,
    reindexScheduled: boolean
  ): string {
    const { enabled, agent_alias, fallback_agent_alias } = settings;
    const base = `Updated summarization settings (enabled: ${enabled}, agent: ${agent_alias || 'none'}, fallback: ${fallback_agent_alias || 'none'})`;
    return promptChanged && reindexScheduled ? `${base}. Scheduled reindexing in 10 minutes.` : base;
  }

  async function postSummarizationSettings(req: Request, res: Response): Promise<void> {
    const validationError = validateSummarizationInput(req.body);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    const { enabled, agent_alias, fallback_agent_alias, custom_prompt } = req.body as {
      enabled: boolean;
      agent_alias?: string;
      fallback_agent_alias?: string;
      custom_prompt?: string;
    };
    const currentSettings = await configManager.loadSummarizationSettings();
    const newCustomPrompt = custom_prompt || '';
    const promptChanged = newCustomPrompt !== (currentSettings.custom_prompt || '');

    const settings = {
      enabled,
      agent_alias: agent_alias || '',
      fallback_agent_alias: fallback_agent_alias || '',
      custom_prompt: newCustomPrompt
    };
    const modelAliasesChanged =
      settings.agent_alias !== (currentSettings.agent_alias || '') ||
      settings.fallback_agent_alias !== (currentSettings.fallback_agent_alias || '');

    await configManager.saveSummarizationSettings(settings);
    if (modelAliasesChanged) {
      await configManager.clearSummarizationRuntimeState();
    }
    await publishConfigUpdate('summarization_settings_update');

    let reindexScheduled = false;
    if (promptChanged && enabled && agent_alias) {
      reindexScheduled = await scheduleDelayedReindex(redisClient);
    }

    const description = buildSummarizationDescription(settings, promptChanged, reindexScheduled);
    await logActivityHelper(description, 'summarization-update', 'summarization_updated', req.user?.username);

    res.json({ success: true, ...settings, promptChanged, reindexScheduled });
  }

  return {
    getRepositoriesIndexingStatus,
    triggerIndexing,
    triggerReindexAll,
    stopIndexing,
    postSummarizationSettings
  };
}
