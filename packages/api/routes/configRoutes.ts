import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { randomUUID } from 'crypto';
import * as configManager from '@propr/core';
import {
    AgentRegistry,
    DEFAULT_INSTRUCTIONS,
    RepoToMonitor,
    resolveVersion,
    computeContentHash,
    generateImageTag,
    AGENT_DEFAULT_VERSIONS
} from '@propr/core';
import type { CliVersionType, AgentType } from '@propr/core';
import { withConfigLock, validateAgentsConfig } from './configHelpers.js';
import { createIndexingRoutes } from './configRoutesIndexing.js';

interface ConfigRoutesDeps {
  redisClient: RedisClientType;
}

const CONFIG_EVENT_CHANNEL = 'system:config:events';

export function createConfigRoutes(deps: ConfigRoutesDeps) {
  const { redisClient } = deps;

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

  const indexingRoutes = createIndexingRoutes({ redisClient, publishConfigUpdate, logActivityHelper });

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

  async function getFollowupIgnoreKeywords(_req: Request, res: Response): Promise<void> {
    try {
      const keywords = await configManager.loadFollowupIgnoreKeywords();
      res.json({ followup_ignore_keywords: keywords });
    } catch (error) {
      console.error('Error in /api/config/followup-ignore-keywords GET:', error);
      res.status(500).json({ error: 'Failed to load followup ignore keywords' });
    }
  }

  async function postFollowupIgnoreKeywords(req: Request, res: Response): Promise<void> {
    const result = await withConfigLock(redisClient, 'config:ignore-keywords:lock', async () => {
      const { followup_ignore_keywords } = req.body;

      if (!Array.isArray(followup_ignore_keywords)) {
        return { status: 400, body: { error: 'followup_ignore_keywords must be an array of strings' } };
      }

      await configManager.saveFollowupIgnoreKeywords(followup_ignore_keywords);

      // Publish config update event
      await publishConfigUpdate('followup_ignore_keywords_update');

      return { status: 200, body: { success: true, followup_ignore_keywords } };
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
      const [settings, autoFollowupThreshold] = await Promise.all([
        configManager.loadSettings(),
        configManager.loadAutoFollowupScoreThreshold()
      ]);
      const envDefaults = {
        worker_concurrency: parseInt(process.env.WORKER_CONCURRENCY || '5', 10),
        github_user_whitelist: (process.env.GITHUB_USER_WHITELIST || '').split(',').filter(u => u.trim()),
        analysis_model_fast: process.env.ANALYSIS_MODEL_FAST || 'claude-3-5-haiku-20241022',
        planner_context_model: process.env.PLANNER_CONTEXT_MODEL || '',
        planner_generation_model: process.env.PLANNER_GENERATION_MODEL || ''
      };
      const mergedSettings = {
        worker_concurrency: settings.worker_concurrency || envDefaults.worker_concurrency,
        github_user_whitelist: settings.github_user_whitelist || envDefaults.github_user_whitelist,
        analysis_model_fast: settings.analysis_model_fast || envDefaults.analysis_model_fast,
        planner_context_model: settings.planner_context_model || envDefaults.planner_context_model,
        planner_generation_model: settings.planner_generation_model || envDefaults.planner_generation_model,
        auto_followup_score_threshold: autoFollowupThreshold
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

      // Handle auto_followup_score_threshold separately since it's stored in its own key
      const { auto_followup_score_threshold, ...otherSettings } = settings;

      const savePromises: Promise<boolean>[] = [configManager.saveSettings(otherSettings)];

      if (auto_followup_score_threshold !== undefined) {
        const threshold = parseInt(auto_followup_score_threshold, 10);
        if (isNaN(threshold) || threshold < 0 || threshold > 9) {
          return { status: 400, body: { error: 'auto_followup_score_threshold must be a number between 0 and 9' } };
        }
        savePromises.push(configManager.saveAutoFollowupScoreThreshold(threshold));
      }

      await Promise.all(savePromises);

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

      // Resolve CLI versions for each agent
      const processedAgents = [];
      for (const agent of agents) {
        const processedAgent = { ...agent };

        // If agent has version configuration, resolve it
        if (agent.cliVersionType) {
          try {
            const agentType = agent.type as AgentType;
            const versionType = agent.cliVersionType as CliVersionType;

            // Resolve version to actual semver
            const resolvedVersion = await resolveVersion(agentType, versionType, agent.cliVersion);
            processedAgent.cliVersionResolved = resolvedVersion;

            // Compute content hash and update docker image tag
            const contentHash = computeContentHash(agentType);
            const imageTag = generateImageTag(agentType, resolvedVersion, contentHash);
            processedAgent.dockerImage = imageTag;

          } catch (versionError) {
            console.warn(`Failed to resolve version for agent ${agent.alias}:`, versionError);
            // Keep existing values if resolution fails
          }
        } else {
          // Default: use default version if no type specified
          const agentType = agent.type as AgentType;
          processedAgent.cliVersionType = 'default';
          processedAgent.cliVersionResolved = AGENT_DEFAULT_VERSIONS[agentType];
        }

        processedAgents.push(processedAgent);
      }

      await configManager.saveAgents(processedAgents);

      // Refresh the AgentRegistry to apply changes immediately
      try {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();
      } catch (refreshError) {
        console.error('Warning: Failed to refresh agent registry:', refreshError);
      }

      await publishConfigUpdate('agents_update');
      await logActivityHelper(`Updated agents configuration (${processedAgents.length} agents)`, 'agents-update', 'agents_updated', req.user?.username);

      return { status: 200, body: { success: true, agents: processedAgents } };
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

  return {
    getFollowupKeywords,
    postFollowupKeywords,
    getFollowupIgnoreKeywords,
    postFollowupIgnoreKeywords,
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
    postSummarizationSettings: indexingRoutes.postSummarizationSettings,
    getRepositoriesIndexingStatus: indexingRoutes.getRepositoriesIndexingStatus,
    triggerIndexing: indexingRoutes.triggerIndexing,
    triggerReindexAll: indexingRoutes.triggerReindexAll,
    stopIndexing: indexingRoutes.stopIndexing
  };
}
