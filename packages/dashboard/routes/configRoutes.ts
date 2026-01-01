import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import * as configManager from '@gitfix/core';
import { AgentRegistry, indexingQueue, generateCorrelationId, ensureRepoCloned, getRepoUrl, getAuthenticatedOctokit } from '@gitfix/core';
import type { IndexingJobData } from '@gitfix/core';

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

      for (const repo of repos_to_monitor) {
        const isValid = typeof repo.name === 'string' &&
          repo.name.match(/^[a-zA-Z0-9\-_]+\/[a-zA-Z0-9\-_]+$/) &&
          typeof repo.enabled === 'boolean';
        if (!isValid) {
          return { status: 400, body: { error: `Invalid repository format: ${JSON.stringify(repo)}` } };
        }
      }

      await configManager.saveMonitoredRepos(repos_to_monitor);

      // Publish config update event for repos
      await publishConfigUpdate('repos_update');

      const activity = {
        id: `activity-${Date.now()}-config-update`,
        type: 'config_updated',
        timestamp: new Date().toISOString(),
        user: req.user?.username,
        description: `Updated monitored repositories list (${repos_to_monitor.length} repos)`,
        status: 'success'
      };
      await redisClient.lPush('system:activity:log', JSON.stringify(activity));
      await redisClient.lTrim('system:activity:log', 0, 999);

      return { status: 200, body: { success: true, repos_to_monitor } };
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

      // Publish config update event
      await publishConfigUpdate('pr_label_update');

      return { status: 200, body: { success: true, pr_label: pr_label.trim() } };
    });

    res.status(result.status).json(result.body);
  }

  async function getAiPrimaryTag(_req: Request, res: Response): Promise<void> {
    try {
      const aiPrimaryTag = await configManager.loadAiPrimaryTag();
      res.json({ ai_primary_tag: aiPrimaryTag });
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

      // Publish config update event
      await publishConfigUpdate('ai_primary_tag_update');

      return { status: 200, body: { success: true, ai_primary_tag: ai_primary_tag.trim() } };
    });

    res.status(result.status).json(result.body);
  }

  async function getPrimaryProcessingLabels(_req: Request, res: Response): Promise<void> {
    try {
      const primaryLabels = await configManager.loadPrimaryProcessingLabels();
      res.json({ primary_processing_labels: primaryLabels });
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

      // Publish config update event
      await publishConfigUpdate('primary_processing_labels_update');

      return { status: 200, body: { success: true, primary_processing_labels: labels } };
    });

    res.status(result.status).json(result.body);
  }

  async function getAgents(_req: Request, res: Response): Promise<void> {
    try {
      const agents = await configManager.loadAgents();
      res.json({ agents });
    } catch (error) {
      console.error('Error in /api/config/agents GET:', error);
      res.status(500).json({ error: 'Failed to load agents configuration' });
    }
  }

  async function postAgents(req: Request, res: Response): Promise<void> {
    const result = await withConfigLock(redisClient, 'config:agents:lock', async () => {
      const { agents } = req.body;

      if (!Array.isArray(agents)) {
        return { status: 400, body: { error: 'agents must be an array' } };
      }

      // Validate each agent configuration
      const aliasRegex = /^[a-z0-9-]+$/;
      const seenAliases = new Set<string>();
      const validTypes = ['claude', 'codex', 'gemini'];

      for (const agent of agents) {
        // Validate required fields
        if (!agent.id || typeof agent.id !== 'string') {
          return { status: 400, body: { error: `Agent missing required 'id' field` } };
        }
        if (!agent.type || !validTypes.includes(agent.type)) {
          return { status: 400, body: { error: `Agent '${agent.id}' has invalid type. Must be one of: ${validTypes.join(', ')}` } };
        }
        if (!agent.alias || typeof agent.alias !== 'string') {
          return { status: 400, body: { error: `Agent '${agent.id}' missing required 'alias' field` } };
        }
        if (!aliasRegex.test(agent.alias)) {
          return { status: 400, body: { error: `Agent '${agent.id}' has invalid alias '${agent.alias}'. Must match pattern ^[a-z0-9-]+$` } };
        }
        if (typeof agent.enabled !== 'boolean') {
          return { status: 400, body: { error: `Agent '${agent.id}' missing required 'enabled' field` } };
        }
        if (!agent.dockerImage || typeof agent.dockerImage !== 'string') {
          return { status: 400, body: { error: `Agent '${agent.id}' missing required 'dockerImage' field` } };
        }
        if (!agent.configPath || typeof agent.configPath !== 'string') {
          return { status: 400, body: { error: `Agent '${agent.id}' missing required 'configPath' field` } };
        }
        if (!Array.isArray(agent.supportedModels)) {
          return { status: 400, body: { error: `Agent '${agent.id}' missing required 'supportedModels' field` } };
        }

        // Check for duplicate aliases
        if (seenAliases.has(agent.alias)) {
          return { status: 400, body: { error: `Duplicate agent alias '${agent.alias}' found` } };
        }
        seenAliases.add(agent.alias);
      }

      // Save the agents configuration
      await configManager.saveAgents(agents);

      // Refresh the AgentRegistry to apply changes immediately
      try {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();
      } catch (refreshError) {
        console.error('Warning: Failed to refresh agent registry:', refreshError);
        // Don't fail the request, the config was saved successfully
      }

      // Publish config update event so daemon also refreshes
      await publishConfigUpdate('agents_update');

      const activity = {
        id: `activity-${Date.now()}-agents-update`,
        type: 'agents_updated',
        timestamp: new Date().toISOString(),
        user: req.user?.username,
        description: `Updated agents configuration (${agents.length} agents)`,
        status: 'success'
      };
      await redisClient.lPush('system:activity:log', JSON.stringify(activity));
      await redisClient.lTrim('system:activity:log', 0, 999);

      return { status: 200, body: { success: true, agents } };
    });

    res.status(result.status).json(result.body);
  }

  async function getSummarizationSettings(_req: Request, res: Response): Promise<void> {
    try {
      const settings = await configManager.loadSummarizationSettings();
      res.json(settings);
    } catch (error) {
      console.error('Error in /api/config/summarization GET:', error);
      res.status(500).json({ error: 'Failed to load summarization settings' });
    }
  }

  async function postSummarizationSettings(req: Request, res: Response): Promise<void> {
    const result = await withConfigLock(redisClient, 'config:summarization:lock', async () => {
      const { enabled, agent_alias } = req.body;

      if (typeof enabled !== 'boolean') {
        return { status: 400, body: { error: 'enabled must be a boolean' } };
      }

      if (agent_alias !== undefined && typeof agent_alias !== 'string') {
        return { status: 400, body: { error: 'agent_alias must be a string' } };
      }

      const settings = {
        enabled,
        agent_alias: agent_alias || ''
      };

      await configManager.saveSummarizationSettings(settings);

      // Publish config update event
      await publishConfigUpdate('summarization_settings_update');

      const activity = {
        id: `activity-${Date.now()}-summarization-update`,
        type: 'summarization_updated',
        timestamp: new Date().toISOString(),
        user: req.user?.username,
        description: `Updated summarization settings (enabled: ${enabled}, agent: ${agent_alias || 'none'})`,
        status: 'success'
      };
      await redisClient.lPush('system:activity:log', JSON.stringify(activity));
      await redisClient.lTrim('system:activity:log', 0, 999);

      return { status: 200, body: { success: true, ...settings } };
    });

    res.status(result.status).json(result.body);
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
      const { repository, fullReindex } = req.body;

      if (!repository || typeof repository !== 'string') {
        res.status(400).json({ error: 'repository is required and must be a string (e.g., "owner/repo")' });
        return;
      }

      // Validate repository format
      if (!repository.match(/^[a-zA-Z0-9\-_]+\/[a-zA-Z0-9\-_.]+$/)) {
        res.status(400).json({ error: 'Invalid repository format. Expected "owner/repo"' });
        return;
      }

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

      // Check if job already queued
      const existingJobs = await indexingQueue.getJobs(['waiting', 'active', 'delayed']);
      const alreadyQueued = existingJobs.some((j: { data: IndexingJobData }) => j.data.repository === repository);

      if (alreadyQueued) {
        res.status(409).json({ error: 'Indexing job already queued for this repository' });
        return;
      }

      // Ensure repo is cloned
      const [owner, name] = repository.split('/');

      // Get auth token for cloning
      const octokit = await getAuthenticatedOctokit();
      const { token } = await octokit.auth({ type: "installation" }) as { token: string };
      const repoUrl = getRepoUrl({ repoOwner: owner, repoName: name });

      let repoPath: string;
      try {
        repoPath = await ensureRepoCloned(repoUrl, owner, name, token);
      } catch (cloneError) {
        res.status(500).json({ error: `Failed to clone repository: ${(cloneError as Error).message}` });
        return;
      }

      // Queue the indexing job
      const correlationId = generateCorrelationId();
      const job = await indexingQueue.add(
        'indexRepository',
        {
          repository,
          repoPath,
          correlationId,
          priority: 'high',
          fullReindex: !!fullReindex
        },
        {
          jobId: `index-${repository.replace('/', '-')}-${Date.now()}`,
          priority: 1 // High priority for manual triggers
        }
      );

      // Log activity
      const activity = {
        id: `activity-${Date.now()}-indexing-trigger`,
        type: 'indexing_triggered',
        timestamp: new Date().toISOString(),
        user: req.user?.username,
        description: `Triggered ${fullReindex ? 'full re-' : ''}indexing for ${repository}`,
        status: 'success'
      };
      await redisClient.lPush('system:activity:log', JSON.stringify(activity));
      await redisClient.lTrim('system:activity:log', 0, 999);

      res.json({
        success: true,
        jobId: job.id,
        correlationId,
        repository,
        fullReindex: !!fullReindex
      });
    } catch (error) {
      console.error('Error in /api/config/repos/trigger-indexing POST:', error);
      res.status(500).json({ error: 'Failed to trigger indexing' });
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
    triggerIndexing
  };
}

async function withConfigLock(
  redisClient: RedisClientType,
  lockKey: string,
  operation: () => Promise<{ status: number; body: Record<string, unknown> }>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const lockValue = `${Date.now()}-${Math.random()}`;
  const lockTimeout = 30;

  try {
    const acquired = await redisClient.set(lockKey, lockValue, {
      NX: true,
      EX: lockTimeout
    });

    if (!acquired) {
      return { status: 409, body: { error: 'Configuration is being updated. Please try again.' } };
    }

    try {
      return await operation();
    } finally {
      const currentLockValue = await redisClient.get(lockKey);
      if (currentLockValue === lockValue) {
        await redisClient.del(lockKey);
      }
    }
  } catch (error) {
    console.error(`Error in config operation with lock ${lockKey}:`, error);
    try {
      const currentLockValue = await redisClient.get(lockKey);
      if (currentLockValue === lockValue) {
        await redisClient.del(lockKey);
      }
    } catch (unlockError) {
      console.error('Error releasing lock:', unlockError);
    }
    return { status: 500, body: { error: 'Failed to update configuration' } };
  }
}
