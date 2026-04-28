import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import * as configManager from '@propr/core';
import { publishIndexingStatus } from '@propr/core';
import { queueResummarizationForAllRepos, queueIndexingJob, scheduleDelayedReindex, cancelDelayedReindex, stopIndexingJob } from './configHelpers.js';

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
    const { repository, fullReindex, baseBranch } = req.body;
    try {
      if (!repository || typeof repository !== 'string') {
        res.status(400).json({ error: 'repository is required and must be a string (e.g., "owner/repo")' });
        return;
      }

      if (!repository.match(/^[a-zA-Z0-9\-_]+\/[a-zA-Z0-9\-_.]+$/)) {
        res.status(400).json({ error: 'Invalid repository format. Expected "owner/repo"' });
        return;
      }

      if (baseBranch !== undefined && typeof baseBranch !== 'string') {
        res.status(400).json({ error: 'baseBranch must be a string' });
        return;
      }

      // Publish indexing status before queueing to prevent race where a fast worker
      // emits completed/failed before the route publishes the start event
      await publishIndexingStatus(repository, baseBranch || 'HEAD', 'indexing');

      const result = await queueIndexingJob(repository, !!fullReindex, baseBranch);
      if (!result.success) {
        // Revert the optimistic status since the job wasn't queued
        await publishIndexingStatus(repository, baseBranch || 'HEAD', 'idle');
        const statusCode = result.error?.includes('already queued') ? 409 : 400;
        res.status(statusCode).json({ error: result.error });
        return;
      }

      await logActivityHelper(
        `Triggered ${fullReindex ? 'full re-' : ''}indexing for ${repository}${baseBranch ? ` (branch: ${baseBranch})` : ''}`,
        'indexing-trigger', 'indexing_triggered', req.user?.username
      );

      res.json({ success: true, jobId: result.jobId, correlationId: result.correlationId, repository, fullReindex: !!fullReindex, baseBranch });
    } catch (error) {
      // Revert the optimistic indexing status since queueing threw
      if (repository && typeof repository === 'string') {
        try {
          await publishIndexingStatus(repository, baseBranch || 'HEAD', 'idle');
        } catch {
          // Best-effort rollback
        }
      }
      console.error('Error in /api/config/repos/trigger-indexing POST:', error);
      res.status(500).json({ error: 'Failed to trigger indexing' });
    }
  }

  async function triggerResummarizationSafe(): Promise<number> {
    try {
      return await queueResummarizationForAllRepos();
    } catch (error) {
      console.error('Error triggering resummarization for repositories:', error);
      return 0;
    }
  }

  async function triggerReindexAll(req: Request, res: Response): Promise<void> {
    try {
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
      const repositoriesQueued = await triggerResummarizationSafe();

      await logActivityHelper(
        `Manually triggered reindexing for ${repositoriesQueued} repositories`,
        'reindex-all-trigger', 'reindex_all_triggered', req.user?.username
      );

      res.json({ success: true, repositoriesQueued });
    } catch (error) {
      console.error('Error in /api/config/summarization/reindex-all POST:', error);
      res.status(500).json({ error: 'Failed to trigger reindexing' });
    }
  }

  async function stopIndexing(req: Request, res: Response): Promise<void> {
    try {
      const { repository, branch } = req.body;

      if (!repository || typeof repository !== 'string') {
        res.status(400).json({ error: 'Repository is required' });
        return;
      }

      const result = await stopIndexingJob(repository, branch);

      if (!result.success) {
        res.status(500).json({ error: result.message || 'Failed to stop indexing' });
        return;
      }

      await publishIndexingStatus(repository, branch || 'HEAD', 'idle');

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

  function validateSummarizationInput(body: Record<string, unknown>): string | null {
    const { enabled, agent_alias, custom_prompt } = body;
    if (typeof enabled !== 'boolean') return 'enabled must be a boolean';
    if (agent_alias !== undefined && typeof agent_alias !== 'string') return 'agent_alias must be a string';
    if (custom_prompt !== undefined && typeof custom_prompt !== 'string') return 'custom_prompt must be a string';
    return null;
  }

  function buildSummarizationDescription(enabled: boolean, agent_alias: string, promptChanged: boolean, reindexScheduled: boolean): string {
    const base = `Updated summarization settings (enabled: ${enabled}, agent: ${agent_alias || 'none'})`;
    return promptChanged && reindexScheduled ? `${base}. Scheduled reindexing in 10 minutes.` : base;
  }

  async function postSummarizationSettings(req: Request, res: Response): Promise<void> {
    const validationError = validateSummarizationInput(req.body);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    const { enabled, agent_alias, custom_prompt } = req.body;
    const currentSettings = await configManager.loadSummarizationSettings();
    const newCustomPrompt = custom_prompt || '';
    const promptChanged = newCustomPrompt !== (currentSettings.custom_prompt || '');

    const settings = {
      enabled,
      agent_alias: agent_alias || '',
      custom_prompt: newCustomPrompt
    };

    await configManager.saveSummarizationSettings(settings);
    await publishConfigUpdate('summarization_settings_update');

    let reindexScheduled = false;
    if (promptChanged && enabled && agent_alias) {
      reindexScheduled = await scheduleDelayedReindex(redisClient);
    }

    const description = buildSummarizationDescription(enabled, agent_alias, promptChanged, reindexScheduled);
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
