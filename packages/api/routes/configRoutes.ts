import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { randomUUID } from 'crypto';
import * as configManager from '@propr/core';
import { DEFAULT_INSTRUCTIONS, RepoToMonitor } from '@propr/core';
import { withConfigLock, SETTINGS_CONFIG_LOCK_KEY } from './configHelpers.js';
import { createIndexingRoutes } from './configRoutesIndexing.js';
import { createAgentTankRoutes } from './configRoutesAgentTank.js';
import { createAgentsRoutes } from './configRoutesAgents.js';
import { saveSettingsWithRollback } from './configRoutesSettings.js';

interface ConfigRoutesDeps {
  redisClient: RedisClientType;
}

interface JsonPostHandlerConfig<T> {
  lockKey: string;
  pickValue: (body: Record<string, unknown>) => unknown;
  validate: (value: unknown) => ValidationResult<T>;
  save: (value: T) => Promise<unknown>;
  subtype: string;
  body: (value: T) => Record<string, unknown>;
}

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const CONFIG_EVENT_CHANNEL = 'system:config:events';
function validateStringArray(value: unknown, fieldName: string): string[] | string {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    return `${fieldName} must be an array of strings`;
  }
  return value;
}

function success<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function failure<T>(error: string): ValidationResult<T> {
  return { ok: false, error };
}

function validateStringArrayResult(value: unknown, fieldName: string): ValidationResult<string[]> {
  const validated = validateStringArray(value, fieldName);
  return typeof validated === 'string' ? failure(validated) : success(validated);
}

function validateJsonObjectBody(value: unknown): ValidationResult<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return failure('Request body must be a JSON object');
  }
  return success(value as Record<string, unknown>);
}

function createJsonGetHandler<T>(
  load: () => Promise<T>,
  body: (value: T) => Record<string, unknown>,
  errorMessage: string,
  logContext: string
) {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      res.json(body(await load()));
    } catch (error) {
      console.error(`Error in ${logContext}:`, error);
      res.status(500).json({ error: errorMessage });
    }
  };
}

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
  const agentTankRoutes = createAgentTankRoutes();
  const agentsRoutes = createAgentsRoutes({ redisClient, publishConfigUpdate, logActivityHelper });
  const createJsonPostHandler = <T>(
    {
      lockKey,
      pickValue,
      validate,
      save,
      subtype,
      body
    }: JsonPostHandlerConfig<T>
  ) => async (req: Request, res: Response): Promise<void> => {
    const bodyValidation = validateJsonObjectBody(req.body);
    if (!bodyValidation.ok) {
      res.status(400).json({ error: bodyValidation.error });
      return;
    }
    const result = await withConfigLock(redisClient, lockKey, async () => {
      const rawValue = pickValue(bodyValidation.value);
      const validated = validate(rawValue);
      if (!validated.ok) {
        return { status: 400, body: { error: validated.error } };
      }
      await save(validated.value);
      await publishConfigUpdate(subtype);
      return { status: 200, body: { success: true, ...body(validated.value) } };
    });
    res.status(result.status).json(result.body);
  };

  const getFollowupKeywords = createJsonGetHandler(
    () => configManager.loadFollowupKeywords(),
    followup_keywords => ({ followup_keywords }),
    'Failed to load followup keywords',
    '/api/config/followup-keywords GET'
  );
  const postFollowupKeywords = createJsonPostHandler(
    {
      lockKey: 'config:keywords:lock',
      pickValue: body => body.followup_keywords,
      validate: followup_keywords => validateStringArrayResult(followup_keywords, 'followup_keywords'),
      save: followup_keywords => configManager.saveFollowupKeywords(followup_keywords),
      subtype: 'followup_keywords_update',
      body: followup_keywords => ({ followup_keywords })
    }
  );
  const getFollowupIgnoreKeywords = createJsonGetHandler(
    () => configManager.loadFollowupIgnoreKeywords(),
    followup_ignore_keywords => ({ followup_ignore_keywords }),
    'Failed to load followup ignore keywords',
    '/api/config/followup-ignore-keywords GET'
  );
  const postFollowupIgnoreKeywords = createJsonPostHandler(
    {
      lockKey: 'config:ignore-keywords:lock',
      pickValue: body => body.followup_ignore_keywords,
      validate: followup_ignore_keywords => validateStringArrayResult(followup_ignore_keywords, 'followup_ignore_keywords'),
      save: followup_ignore_keywords => configManager.saveFollowupIgnoreKeywords(followup_ignore_keywords),
      subtype: 'followup_ignore_keywords_update',
      body: followup_ignore_keywords => ({ followup_ignore_keywords })
    }
  );

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
      const [
        settings,
        autoFollowupThreshold,
        autoResolveMergeConflicts,
        prReviewModel,
        ultrafixRatingGoal,
        ultrafixMaxCycles,
        ultrafixPauseSeconds
      ] = await Promise.all([
        configManager.loadSettings(),
        configManager.loadAutoFollowupScoreThreshold(),
        configManager.loadAutoResolveMergeConflicts(),
        configManager.loadPrReviewModel(),
        configManager.loadUltrafixRatingGoal(),
        configManager.loadUltrafixMaxCycles(),
        configManager.loadUltrafixPauseSeconds()
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
        auto_followup_score_threshold: autoFollowupThreshold,
        auto_resolve_merge_conflicts: autoResolveMergeConflicts,
        pr_review_model: prReviewModel,
        ultrafix_rating_goal: ultrafixRatingGoal,
        ultrafix_max_cycles: ultrafixMaxCycles,
        ultrafix_pause_seconds: ultrafixPauseSeconds
      };
      res.json(mergedSettings);
    } catch (error) {
      console.error('Error in /api/config/settings GET:', error);
      res.status(500).json({ error: 'Failed to load settings' });
    }
  }

  async function postSettings(req: Request, res: Response): Promise<void> {
    const bodyValidation = validateJsonObjectBody(req.body);
    if (!bodyValidation.ok) {
      res.status(400).json({ error: bodyValidation.error });
      return;
    }
    const settingsValidation = validateJsonObjectBody(bodyValidation.value.settings);
    if (!settingsValidation.ok) {
      res.status(400).json({ error: 'settings object is required' });
      return;
    }

    const result = await withConfigLock(redisClient, SETTINGS_CONFIG_LOCK_KEY, async () => {
      return saveSettingsWithRollback({
        settings: settingsValidation.value,
        publishConfigUpdate
      });
    });

    res.status(result.status).json(result.body);
  }

  const getPrLabel = createJsonGetHandler(
    () => configManager.loadPrLabel(),
    pr_label => ({ pr_label }),
    'Failed to load PR label',
    '/api/config/pr-label GET'
  );
  const postPrLabel = createJsonPostHandler<string>(
    {
      lockKey: 'config:pr-label:lock',
      pickValue: body => body.pr_label,
      validate: pr_label => typeof pr_label === 'string' && pr_label.trim() !== ''
        ? success(pr_label.trim())
        : failure('pr_label must be a non-empty string'),
      save: pr_label => configManager.savePrLabel(pr_label),
      subtype: 'pr_label_update',
      body: pr_label => ({ pr_label })
    }
  );
  const getAiPrimaryTag = createJsonGetHandler(
    () => configManager.loadAiPrimaryTag(),
    ai_primary_tag => ({ ai_primary_tag }),
    'Failed to load AI primary tag',
    '/api/config/ai-primary-tag GET'
  );
  const postAiPrimaryTag = createJsonPostHandler<string>(
    {
      lockKey: 'config:ai-primary-tag:lock',
      pickValue: body => body.ai_primary_tag,
      validate: ai_primary_tag => typeof ai_primary_tag === 'string' && ai_primary_tag.trim() !== ''
        ? success(ai_primary_tag.trim())
        : failure('ai_primary_tag must be a non-empty string'),
      save: ai_primary_tag => configManager.saveAiPrimaryTag(ai_primary_tag),
      subtype: 'ai_primary_tag_update',
      body: ai_primary_tag => ({ ai_primary_tag })
    }
  );

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
    getAgents: agentsRoutes.getAgents,
    postAgents: agentsRoutes.postAgents,
    getSummarizationSettings,
    postSummarizationSettings: indexingRoutes.postSummarizationSettings,
    getRepositoriesIndexingStatus: indexingRoutes.getRepositoriesIndexingStatus,
    triggerIndexing: indexingRoutes.triggerIndexing,
    triggerReindexAll: indexingRoutes.triggerReindexAll,
    stopIndexing: indexingRoutes.stopIndexing,
    getAgentTankSettings: agentTankRoutes.getAgentTankSettings,
    postAgentTankSettings: agentTankRoutes.postAgentTankSettings,
    getAgentTankStatus: agentTankRoutes.getAgentTankStatus,
    getAgentTankUsage: agentTankRoutes.getAgentTankUsage,
    postAgentTankRefresh: agentTankRoutes.postAgentTankRefresh,
    getAgentTankDetect: agentTankRoutes.getAgentTankDetect
  };
}
