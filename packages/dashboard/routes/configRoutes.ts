import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { randomUUID } from 'crypto';
import * as configManager from '@gitfix/core';
import { AgentRegistry, DEFAULT_INSTRUCTIONS, RepoToMonitor } from '@gitfix/core';
import { withConfigLock, queueResummarizationForAllRepos, validateAgentsConfig, queueIndexingJob, scheduleDelayedReindex, cancelDelayedReindex, stopIndexingJob } from './configHelpers.js';

interface ConfigRoutesDeps {
  redisClient: RedisClientType;
}

// Define the channel name constant for config update events
const CONFIG_EVENT_CHANNEL = 'system:config:events';

export function createConfigRoutes(deps: ConfigRoutesDeps) {
  const { redisClient } = deps;

  // Helper function to publish config updates via Redis Pub/Sub
  const publishConfigUpdate = async (subtype: string): Promise<void> => {
    try {
      await redisClient.publish(CONFIG_EVENT_CHANNEL, JSON.stringify({
        type: 'config_update',
        subtype,
        timestamp: Date.now()
      }));
    } catch (error) {
      console.error(`Failed to publish config update event for ${subtype}:`, error);
    }
  };

  // Helper function to log activity
  const logActivityHelper = async (description: string, idSuffix: string, type: string, username?: string): Promise<void> => {
    const activity = {
      id: `activity-${Date.now()}-${idSuffix}`,
      type,
      timestamp: new Date().toISOString(),
      user: username,
      description,
      status: 'success'
    };
    await redisClient.lPush('system:activity:log', JSON.stringify(activity));
    await redisClient.lTrim('system:activity:log', 0, 999);
  };

  async function getFollowupKeywords(_req: Request, res: Response): Promise<void> {
    try {
      const keywords = await configManager.loadFollowupKeywords();
      res.json({ followup_keywords: keywords });
    } catch (error) {
      console.error('Error in /api/config/followup-keywords GET:', error);
      res.status(500).json({ error: 'Failed to load followup keywords' });
    }
  }

  async function postFollowupKeywords(req: Request, res: Response): Promise<void> {
    const result = await withConfigLock(redisClient, 'config:keywords:lock', async () => {
      const { followup_keywords } = req.body;

      if (!Array.isArray(followup_keywords)) {
        return { status: 400, body: { error: 'followup_keywords must be an array of strings' } };
      }

      await configManager.saveFollowupKeywords(followup_keywords);

      // Publish config update event
      await publishConfigUpdate('followup_keywords_update');

      return { status: 200, body: { success: true, followup_keywords } };
    });

    res.status(result.status).json(result.body);
  }

  async function getRepos(_req: Request, res: Response): Promise<void> {
    try {
      const repos = await configManager.loadMonitoredReposRaw();
      res.json({ repos_to_monitor: repos });
    } catch (error) {
      console.error('Error in /api/config/repos GET:', error);
      res.status(500).json({ error: 'Failed to load repository configuration' });
    }
  }

  async function postRepos(req: Request, res: Response): Promise<void> {
    const result = await withConfigLock(redisClient, 'config:repos:lock', async () => {
      const { repos_to_monitor } = req.body;

      if (!Array.isArray(repos_to_monitor)) {
        return { status: 400, body: { error: 'repos_to_monitor must be an array' } };
      }

      // Validate and process repos
      const processedRepos: RepoToMonitor[] = [];
      for (const repo of repos_to_monitor) {
        // Validate required fields
        const isValid = typeof repo.name === 'string' &&
          repo.name.match(/^[a-zA-Z0-9\-_]+\/[a-zA-Z0-9\-_.]+$/) &&
          typeof repo.enabled === 'boolean';
        if (!isValid) {
          return { status: 400, body: { error: `Invalid repository format: ${JSON.stringify(repo)}` } };
        }

        // Validate optional fields if present
        if (repo.alias !== undefined && typeof repo.alias !== 'string') {
          return { status: 400, body: { error: `Invalid alias format for ${repo.name}: must be a string` } };
        }
        if (repo.baseBranch !== undefined && typeof repo.baseBranch !== 'string') {
          return { status: 400, body: { error: `Invalid baseBranch format for ${repo.name}: must be a string` } };
        }

        // Process the repo with ID generation and field sanitization
        processedRepos.push({
          id: repo.id || randomUUID(),
          name: repo.name,
          enabled: repo.enabled,
          alias: repo.alias?.trim() || undefined,
          baseBranch: repo.baseBranch?.trim() || undefined
        });
      }

      await configManager.saveMonitoredRepos(processedRepos);
      await publishConfigUpdate('repos_update');
      await logActivityHelper(`Updated monitored repositories list (${processedRepos.length} repos)`, 'config-update', 'config_updated', req.user?.username);

      return { status: 200, body: { success: true, repos_to_monitor: processedRepos } };
    });

    res.status(result.status).json(result.body);
  }

  async function getSettings(_req: Request, res: Response): Promise<void> {
    try {
      const settings = await configManager.loadSettings();
      const envDefaults = {
        worker_concurrency: parseInt(process.env.WORKER_CONCURRENCY || '5', 10),
        github_user_whitelist: (process.env.GITHUB_USER_WHITELIST || '').split(',').filter(u => u.trim()),
        analysis_model_fast: process.env.ANALYSIS_MODEL_FAST || 'claude-3-5-haiku-20241022',
        analysis_model_advanced: process.env.ANALYSIS_MODEL_ADVANCED || 'claude-opus-4-20250514'
      };
      const mergedSettings = {
        worker_concurrency: settings.worker_concurrency || envDefaults.worker_concurrency,
        github_user_whitelist: settings.github_user_whitelist || envDefaults.github_user_whitelist,
        analysis_model_fast: settings.analysis_model_fast || envDefaults.analysis_model_fast,
        analysis_model_advanced: settings.analysis_model_advanced || envDefaults.analysis_model_advanced
      };
      res.json(mergedSettings);
    } catch (error) {
      console.error('Error in /api/config/settings GET:', error);
      res.status(500).json({ error: 'Failed to load settings' });
    }
  }

  async function postSettings(req: Request, res: Response): Promise<void> {
    const result = await withConfigLock(redisClient, 'config:settings:lock', async () => {
      const { settings } = req.body;

      if (!settings || typeof settings !== 'object') {
        return { status: 400, body: { error: 'settings object is required' } };
      }

      await configManager.saveSettings(settings);

      // Publish config update event
      await publishConfigUpdate('settings_update');

      return { status: 200, body: { success: true, settings } };
    });

    res.status(result.status).json(result.body);
  }

  async function getPrLabel(_req: Request, res: Response): Promise<void> {
    try {
      const prLabel = await configManager.loadPrLabel();
      res.json({ pr_label: prLabel });
    } catch (error) {
      console.error('Error in /api/config/pr-label GET:', error);
      res.status(500).json({ error: 'Failed to load PR label' });
    }
  }

  async function postPrLabel(req: Request, res: Response): Promise<void> {
    const result = await withConfigLock(redisClient, 'config:pr-label:lock', async () => {
      const { pr_label } = req.body;
      if (!pr_label || typeof pr_label !== 'string' || pr_label.trim() === '') {
        return { status: 400, body: { error: 'pr_label must be a non-empty string' } };
      }
      await configManager.savePrLabel(pr_label.trim());
      await publishConfigUpdate('pr_label_update');
      return { status: 200, body: { success: true, pr_label: pr_label.trim() } };
    });
    res.status(result.status).json(result.body);
  }

  async function getAiPrimaryTag(_req: Request, res: Response): Promise<void> {
    try {
      res.json({ ai_primary_tag: await configManager.loadAiPrimaryTag() });
    } catch (error) {
      console.error('Error in /api/config/ai-primary-tag GET:', error);
      res.status(500).json({ error: 'Failed to load AI primary tag' });
    }
  }

  async function postAiPrimaryTag(req: Request, res: Response): Promise<void> {
    const result = await withConfigLock(redisClient, 'config:ai-primary-tag:lock', async () => {
      const { ai_primary_tag } = req.body;
      if (!ai_primary_tag || typeof ai_primary_tag !== 'string' || ai_primary_tag.trim() === '') {
        return { status: 400, body: { error: 'ai_primary_tag must be a non-empty string' } };
      }
      await configManager.saveAiPrimaryTag(ai_primary_tag.trim());
      await publishConfigUpdate('ai_primary_tag_update');
      return { status: 200, body: { success: true, ai_primary_tag: ai_primary_tag.trim() } };
    });
    res.status(result.status).json(result.body);
  }

  async function getPrimaryProcessingLabels(_req: Request, res: Response): Promise<void> {
    try {
      res.json({ primary_processing_labels: await configManager.loadPrimaryProcessingLabels() });
    } catch (error) {
      console.error('Error in /api/config/primary-processing-labels GET:', error);
      res.status(500).json({ error: 'Failed to load primary processing labels' });
    }
  }

  async function postPrimaryProcessingLabels(req: Request, res: Response): Promise<void> {
    const result = await withConfigLock(redisClient, 'config:primary-processing-labels:lock', async () => {
      const { primary_processing_labels } = req.body;
      if (!Array.isArray(primary_processing_labels) || primary_processing_labels.length === 0) {
        return { status: 400, body: { error: 'primary_processing_labels must be a non-empty array' } };
      }
      const labels = primary_processing_labels.map(l => String(l).trim()).filter(l => l.length > 0);
      if (labels.length === 0) {
        return { status: 400, body: { error: 'At least one valid label is required' } };
      }
      await configManager.savePrimaryProcessingLabels(labels);
      await publishConfigUpdate('primary_processing_labels_update');
      return { status: 200, body: { success: true, primary_processing_labels: labels } };
    });
    res.status(result.status).json(result.body);
  }

  async function getAgents(_req: Request, res: Response): Promise<void> {
    try {
      res.json({ agents: await configManager.loadAgents() });
    } catch (error) {
      console.error('Error in /api/config/agents GET:', error);
      res.status(500).json({ error: 'Failed to load agents configuration' });
    }
  }

  async function postAgents(req: Request, res: Response): Promise<void> {
    const result = await withConfigLock(redisClient, 'config:agents:lock', async () => {
      const { agents } = req.body;

      const validationError = validateAgentsConfig(agents);
      if (validationError) {
        return { status: 400, body: { error: validationError } };
      }

      await configManager.saveAgents(agents);

      // Refresh the AgentRegistry to apply changes immediately
      try {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();
      } catch (refreshError) {
        console.error('Warning: Failed to refresh agent registry:', refreshError);
      }

      await publishConfigUpdate('agents_update');
      await logActivityHelper(`Updated agents configuration (${agents.length} agents)`, 'agents-update', 'agents_updated', req.user?.username);

      return { status: 200, body: { success: true, agents } };
    });

    res.status(result.status).json(result.body);
  }

  async function getSummarizationSettings(_req: Request, res: Response): Promise<void> {
    try {
      const settings = await configManager.loadSummarizationSettings();
      res.json({
        ...settings,
        default_prompt: DEFAULT_INSTRUCTIONS
      });
    } catch (error) {
      console.error('Error in /api/config/summarization GET:', error);
      res.status(500).json({ error: 'Failed to load summarization settings' });
    }
  }

  async function postSummarizationSettings(req: Request, res: Response): Promise<void> {
    const result = await withConfigLock(redisClient, 'config:summarization:lock', async () => {
      const validationError = validateSummarizationInput(req.body);
      if (validationError) {
        return { status: 400, body: { error: validationError } };
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

      // Schedule delayed resummarization if prompt changed and summarization is enabled
      // The reindex will occur after 10 minutes unless cancelled by another prompt change or manual trigger
      let reindexScheduled = false;
      if (promptChanged && enabled && agent_alias) {
        reindexScheduled = await scheduleDelayedReindex(redisClient);
      }

      const description = buildSummarizationDescription(enabled, agent_alias, promptChanged, reindexScheduled);
      await logActivityHelper(description, 'summarization-update', 'summarization_updated', req.user?.username);

      return {
        status: 200,
        body: { success: true, ...settings, promptChanged, reindexScheduled }
      };
    });

    res.status(result.status).json(result.body);
  }

  function validateSummarizationInput(body: Record<string, unknown>): string | null {
    const { enabled, agent_alias, custom_prompt } = body;
    if (typeof enabled !== 'boolean') return 'enabled must be a boolean';
    if (agent_alias !== undefined && typeof agent_alias !== 'string') return 'agent_alias must be a string';
    if (custom_prompt !== undefined && typeof custom_prompt !== 'string') return 'custom_prompt must be a string';
    return null;
  }

  async function triggerResummarizationSafe(): Promise<number> {
    try {
      return await queueResummarizationForAllRepos();
    } catch (error) {
      console.error('Error triggering resummarization for repositories:', error);
      return 0;
    }
  }

  function buildSummarizationDescription(enabled: boolean, agent_alias: string, promptChanged: boolean, reindexScheduled: boolean): string {
    const base = `Updated summarization settings (enabled: ${enabled}, agent: ${agent_alias || 'none'})`;
    return promptChanged && reindexScheduled ? `${base}. Scheduled reindexing in 10 minutes.` : base;
  }

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
      const { repository, fullReindex, baseBranch } = req.body;

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

      const result = await queueIndexingJob(repository, !!fullReindex, baseBranch);
      if (!result.success) {
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
      console.error('Error in /api/config/repos/trigger-indexing POST:', error);
      res.status(500).json({ error: 'Failed to trigger indexing' });
    }
  }

  async function triggerReindexAll(req: Request, res: Response): Promise<void> {
    try {
      // Check if summarization is enabled
      const settings = await configManager.loadSummarizationSettings();
      if (!settings.enabled) {
        res.status(400).json({ error: 'Summarization is not enabled. Enable it in settings first.' });
        return;
      }
      if (!settings.agent_alias) {
        res.status(400).json({ error: 'No agent configured for summarization. Configure one in settings first.' });
        return;
      }

      // Cancel any scheduled delayed reindex
      await cancelDelayedReindex(redisClient);

      // Trigger immediate reindex for all repos
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

      // Log activity
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

  return {
    getFollowupKeywords,
    postFollowupKeywords,
    getRepos,
    postRepos,
    getSettings,
    postSettings,
    getPrLabel,
    postPrLabel,
    getAiPrimaryTag,
    postAiPrimaryTag,
    getPrimaryProcessingLabels,
    postPrimaryProcessingLabels,
    getAgents,
    postAgents,
    getSummarizationSettings,
    postSummarizationSettings,
    getRepositoriesIndexingStatus,
    triggerIndexing,
    triggerReindexAll,
    stopIndexing
  };
}
