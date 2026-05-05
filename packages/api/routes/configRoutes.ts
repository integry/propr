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
import type { ConfigLockContext } from './configHelpers.js';

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
  committedErrorMessage: string;
  activity?: { description: (value: T) => string; idSuffix: string; type: string };
}
type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };
const CONFIG_EVENT_CHANNEL = 'system:config:events';
const DEFAULT_AUTO_FOLLOWUP_SCORE_THRESHOLD = 4;
const DEFAULT_ULTRAFIX_RATING_GOAL = 7;
const DEFAULT_ULTRAFIX_MAX_CYCLES = 5;
const DEFAULT_ULTRAFIX_PAUSE_SECONDS = 60;

function parseStoredIntegerSetting(value: unknown, minimum: number, maximum: number = Number.MAX_SAFE_INTEGER): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const candidate = typeof value === 'string' && /^-?\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;
  return typeof candidate === 'number'
    && Number.isSafeInteger(candidate)
    && candidate >= minimum
    && candidate <= maximum
    ? candidate
    : null;
}

function getIntegerSettingOrThrow(name: string, value: unknown, defaultValue: number, minimum: number, maximum: number = Number.MAX_SAFE_INTEGER): number {
  const parsed = parseStoredIntegerSetting(value, minimum, maximum);
  if (parsed !== null) {
    return parsed;
  }
  if (value === undefined || value === null) {
    return defaultValue;
  }
  throw new Error(`Stored ${name} is invalid: ${JSON.stringify(value)}`);
}

function validateStringArray(value: unknown, fieldName: string): string[] | string {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    return `${fieldName} must be an array of strings`;
  }
  return value;
}

// These endpoints intentionally persist trimmed, de-duplicated string arrays.
function normalizeStringEntries(values: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function success<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}
function failure<T>(error: string): ValidationResult<T> {
  return { ok: false, error };
}
function parseNormalizedStringArrayResult(value: unknown, fieldName: string): ValidationResult<string[]> {
  const validated = validateStringArray(value, fieldName);
  return typeof validated === 'string' ? failure(validated) : success(normalizeStringEntries(validated));
}
function validateJsonObjectBody(value: unknown): ValidationResult<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return failure('Request body must be a JSON object');
  }
  return success(value as Record<string, unknown>);
}
function createJsonGetHandler<T>(load: () => Promise<T>, body: (value: T) => Record<string, unknown>, errorMessage: string, logContext: string) {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      res.json(body(await load()));
    } catch (error) {
      console.error(`Error in ${logContext}:`, error);
      res.status(500).json({ error: errorMessage });
    }
  };
}
async function saveThenPublishConfigUpdate({
  save,
  publish,
  lock,
  committedErrorMessage,
  successBody
}: {
  save: () => Promise<void>;
  publish: () => Promise<void>;
  lock?: ConfigLockContext;
  committedErrorMessage: string;
  successBody: Record<string, unknown>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  await save();
  lock?.markCommitted();
  try {
    await publish();
  } catch {
    return {
      status: 500,
      body: {
        error: committedErrorMessage,
        committed: true
      }
    };
  }
  return { status: 200, body: successBody };
}

export function createConfigRoutes(deps: ConfigRoutesDeps) {
  const { redisClient } = deps;
  const publishConfigUpdate = async (subtype: string): Promise<void> => {
    try {
      await redisClient.publish(CONFIG_EVENT_CHANNEL, JSON.stringify({ type: 'config_update', subtype, timestamp: Date.now() }));
    } catch (error) {
      console.error(`Failed to publish config update event for ${subtype}:`, error);
      throw error;
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
  const createJsonPostHandler = <T>({ lockKey, pickValue, validate, save, subtype, body, committedErrorMessage, activity }: JsonPostHandlerConfig<T>) => async (req: Request, res: Response): Promise<void> => {
    const bodyValidation = validateJsonObjectBody(req.body);
    if (!bodyValidation.ok) {
      res.status(400).json({ error: bodyValidation.error });
      return;
    }
    const rawValue = pickValue(bodyValidation.value);
    const validated = validate(rawValue);
    if (!validated.ok) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const result = await withConfigLock(redisClient, lockKey, async lock => {
      return saveThenPublishConfigUpdate({
        save: async () => {
          await save(validated.value);
        },
        publish: async () => {
          await publishConfigUpdate(subtype);
        },
        lock,
        committedErrorMessage,
        successBody: { success: true, ...body(validated.value) }
      });
    });
    if (result.status === 200 && activity) {
      try {
        await logActivityHelper(activity.description(validated.value), activity.idSuffix, activity.type, req.user?.username);
      } catch (error) {
        console.error(`Failed to log config activity for ${subtype}:`, error);
      }
    }
    res.status(result.status).json(result.body);
  };
  const getFollowupKeywords = createJsonGetHandler(() => configManager.loadFollowupKeywords(), followup_keywords => ({ followup_keywords }), 'Failed to load followup keywords', '/api/config/followup-keywords GET');
  const postFollowupKeywords = createJsonPostHandler({ lockKey: 'config:keywords:lock', pickValue: body => body.followup_keywords, validate: followup_keywords => parseNormalizedStringArrayResult(followup_keywords, 'followup_keywords'), save: followup_keywords => configManager.saveFollowupKeywords(followup_keywords), subtype: 'followup_keywords_update', body: followup_keywords => ({ followup_keywords }), committedErrorMessage: 'Follow-up keywords were saved, but publishing the config update notification failed. Persisted config may require a follow-up check.' });
  const getFollowupIgnoreKeywords = createJsonGetHandler(() => configManager.loadFollowupIgnoreKeywords(), followup_ignore_keywords => ({ followup_ignore_keywords }), 'Failed to load followup ignore keywords', '/api/config/followup-ignore-keywords GET');
  const postFollowupIgnoreKeywords = createJsonPostHandler({ lockKey: 'config:ignore-keywords:lock', pickValue: body => body.followup_ignore_keywords, validate: followup_ignore_keywords => parseNormalizedStringArrayResult(followup_ignore_keywords, 'followup_ignore_keywords'), save: followup_ignore_keywords => configManager.saveFollowupIgnoreKeywords(followup_ignore_keywords), subtype: 'followup_ignore_keywords_update', body: followup_ignore_keywords => ({ followup_ignore_keywords }), committedErrorMessage: 'Follow-up ignore keywords were saved, but publishing the config update notification failed. Persisted config may require a follow-up check.' });

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
    const bodyValidation = validateJsonObjectBody(req.body);
    if (!bodyValidation.ok) {
      res.status(400).json({ error: bodyValidation.error });
      return;
    }

    const { repos_to_monitor } = bodyValidation.value;
    if (!Array.isArray(repos_to_monitor)) {
      res.status(400).json({ error: 'repos_to_monitor must be an array' });
      return;
    }
    // Validate and process repos before taking the lock to avoid blocking valid updates on malformed requests.
    const processedRepos: RepoToMonitor[] = [];
    for (const repo of repos_to_monitor) {
      const isValid = typeof repo?.name === 'string' &&
        repo.name.match(/^[a-zA-Z0-9\-_]+\/[a-zA-Z0-9\-_.]+$/) &&
        typeof repo.enabled === 'boolean';
      if (!isValid) {
        res.status(400).json({ error: `Invalid repository format: ${JSON.stringify(repo)}` });
        return;
      }

      if (repo.alias !== undefined && typeof repo.alias !== 'string') {
        res.status(400).json({ error: `Invalid alias format for ${repo.name}: must be a string` });
        return;
      }
      if (repo.baseBranch !== undefined && typeof repo.baseBranch !== 'string') {
        res.status(400).json({ error: `Invalid baseBranch format for ${repo.name}: must be a string` });
        return;
      }
      processedRepos.push({ id: repo.id || randomUUID(), name: repo.name, enabled: repo.enabled, alias: repo.alias?.trim() || undefined, baseBranch: repo.baseBranch?.trim() || undefined });
    }
    const result = await withConfigLock(redisClient, 'config:repos:lock', async lock => {
      return saveThenPublishConfigUpdate({
        save: async () => {
          await configManager.saveMonitoredRepos(processedRepos);
        },
        publish: async () => {
          await publishConfigUpdate('repos_update');
        },
        lock,
        committedErrorMessage: 'Repository configuration was saved, but publishing the config update notification failed. Persisted config may require a follow-up check.',
        successBody: { success: true, repos_to_monitor: processedRepos }
      });
    });
    if (result.status === 200) {
      try {
        await logActivityHelper(`Updated monitored repositories list (${processedRepos.length} repos)`, 'config-update', 'config_updated', req.user?.username);
      } catch (error) {
        console.error('Failed to log monitored repositories update activity:', error);
      }
    }

    res.status(result.status).json(result.body);
  }

  async function getSettings(_req: Request, res: Response): Promise<void> {
    try {
      const [
        loadedSettings,
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
      const settings = loadedSettings as Record<string, unknown>;
      const envDefaults = {
        worker_concurrency: parseInt(process.env.WORKER_CONCURRENCY || '5', 10),
        github_user_whitelist: (process.env.GITHUB_USER_WHITELIST || '').split(',').filter(u => u.trim()),
        analysis_model_fast: process.env.ANALYSIS_MODEL_FAST || 'claude-3-5-haiku-20241022',
        planner_context_model: process.env.PLANNER_CONTEXT_MODEL || '',
        planner_generation_model: process.env.PLANNER_GENERATION_MODEL || ''
      };
      res.json({
        worker_concurrency: settings.worker_concurrency ?? envDefaults.worker_concurrency,
        github_user_whitelist: settings.github_user_whitelist ?? envDefaults.github_user_whitelist,
        analysis_model_fast: settings.analysis_model_fast ?? envDefaults.analysis_model_fast,
        planner_context_model: settings.planner_context_model ?? envDefaults.planner_context_model,
        planner_generation_model: settings.planner_generation_model ?? envDefaults.planner_generation_model,
        auto_followup_score_threshold: getIntegerSettingOrThrow('auto_followup_score_threshold', autoFollowupThreshold, DEFAULT_AUTO_FOLLOWUP_SCORE_THRESHOLD, 0, 9),
        auto_resolve_merge_conflicts: autoResolveMergeConflicts,
        pr_review_model: prReviewModel,
        ultrafix_rating_goal: getIntegerSettingOrThrow('ultrafix_rating_goal', ultrafixRatingGoal, DEFAULT_ULTRAFIX_RATING_GOAL, 1, 10),
        ultrafix_max_cycles: getIntegerSettingOrThrow('ultrafix_max_cycles', ultrafixMaxCycles, DEFAULT_ULTRAFIX_MAX_CYCLES, 1),
        ultrafix_pause_seconds: getIntegerSettingOrThrow('ultrafix_pause_seconds', ultrafixPauseSeconds, DEFAULT_ULTRAFIX_PAUSE_SECONDS, 0)
      });
    } catch (error) {
      console.error('Error in /api/config/settings GET:', error);
      if (error instanceof Error && error.message.startsWith('Stored ')) {
        res.status(500).json({ error: error.message, invalid_settings: true });
        return;
      }
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
    if (Object.keys(settingsValidation.value).length === 0) {
      res.json({ success: true, settings: {}, noop: true });
      return;
    }

    const result = await withConfigLock(redisClient, SETTINGS_CONFIG_LOCK_KEY, async lock =>
      saveSettingsWithRollback({ settings: settingsValidation.value, publishConfigUpdate, lock })
    );
    if (result.status === 200 && result.body.noop !== true) {
      try {
        const updatedKeys = Object.keys(settingsValidation.value);
        await logActivityHelper(`Updated system settings (${updatedKeys.length} keys)`, 'settings-update', 'settings_updated', req.user?.username);
      } catch (error) {
        console.error('Failed to log settings update activity:', error);
      }
    }

    res.status(result.status).json(result.body);
  }

  const getPrLabel = createJsonGetHandler(() => configManager.loadPrLabel(), pr_label => ({ pr_label }), 'Failed to load PR label', '/api/config/pr-label GET');
  const postPrLabel = createJsonPostHandler<string>({ lockKey: 'config:pr-label:lock', pickValue: body => body.pr_label, validate: pr_label => typeof pr_label === 'string' && pr_label.trim() !== '' ? success(pr_label.trim()) : failure('pr_label must be a non-empty string'), save: pr_label => configManager.savePrLabel(pr_label), subtype: 'pr_label_update', body: pr_label => ({ pr_label }), committedErrorMessage: 'PR label was saved, but publishing the config update notification failed. Persisted config may require a follow-up check.', activity: { description: pr_label => `Updated PR label to "${pr_label}"`, idSuffix: 'pr-label-update', type: 'config_updated' } });
  const getAiPrimaryTag = createJsonGetHandler(() => configManager.loadAiPrimaryTag(), ai_primary_tag => ({ ai_primary_tag }), 'Failed to load AI primary tag', '/api/config/ai-primary-tag GET');
  const postAiPrimaryTag = createJsonPostHandler<string>({ lockKey: 'config:ai-primary-tag:lock', pickValue: body => body.ai_primary_tag, validate: ai_primary_tag => typeof ai_primary_tag === 'string' && ai_primary_tag.trim() !== '' ? success(ai_primary_tag.trim()) : failure('ai_primary_tag must be a non-empty string'), save: ai_primary_tag => configManager.saveAiPrimaryTag(ai_primary_tag), subtype: 'ai_primary_tag_update', body: ai_primary_tag => ({ ai_primary_tag }), committedErrorMessage: 'AI primary tag was saved, but publishing the config update notification failed. Persisted config may require a follow-up check.', activity: { description: ai_primary_tag => `Updated AI primary tag to "${ai_primary_tag}"`, idSuffix: 'ai-primary-tag-update', type: 'config_updated' } });

  async function getPrimaryProcessingLabels(_req: Request, res: Response): Promise<void> {
    try {
      res.json({ primary_processing_labels: await configManager.loadPrimaryProcessingLabels() });
    } catch (error) {
      console.error('Error in /api/config/primary-processing-labels GET:', error);
      res.status(500).json({ error: 'Failed to load primary processing labels' });
    }
  }

  async function postPrimaryProcessingLabels(req: Request, res: Response): Promise<void> {
    const bodyValidation = validateJsonObjectBody(req.body);
    if (!bodyValidation.ok) {
      res.status(400).json({ error: bodyValidation.error });
      return;
    }

    const { primary_processing_labels } = bodyValidation.value;
    if (!Array.isArray(primary_processing_labels) || primary_processing_labels.length === 0) {
      res.status(400).json({ error: 'primary_processing_labels must be a non-empty array of strings' });
      return;
    }
    if (!primary_processing_labels.every(label => typeof label === 'string')) {
      res.status(400).json({ error: 'primary_processing_labels must be a non-empty array of strings' });
      return;
    }
    const labels = normalizeStringEntries(primary_processing_labels);
    if (labels.length === 0) {
      res.status(400).json({ error: 'At least one valid label is required' });
      return;
    }

    const result = await withConfigLock(redisClient, 'config:primary-processing-labels:lock', async lock => {
      return saveThenPublishConfigUpdate({
        save: async () => {
          await configManager.savePrimaryProcessingLabels(labels);
        },
        publish: async () => {
          await publishConfigUpdate('primary_processing_labels_update');
        },
        lock,
        committedErrorMessage: 'Primary processing labels were saved, but publishing the config update notification failed. Persisted config may require a follow-up check.',
        successBody: { success: true, primary_processing_labels: labels }
      });
    });
    if (result.status === 200) {
      try {
        await logActivityHelper(`Updated primary processing labels (${labels.length} labels)`, 'primary-processing-labels-update', 'config_updated', req.user?.username);
      } catch (error) {
        console.error('Failed to log primary processing labels update activity:', error);
      }
    }
    res.status(result.status).json(result.body);
  }

  async function getSummarizationSettings(_req: Request, res: Response): Promise<void> {
    try {
      const settings = await configManager.loadSummarizationSettings();
      res.json({ ...settings, default_prompt: DEFAULT_INSTRUCTIONS });
    } catch (error) {
      console.error('Error in /api/config/summarization GET:', error);
      res.status(500).json({ error: 'Failed to load summarization settings' });
    }
  }

  return {
    getFollowupKeywords, postFollowupKeywords, getFollowupIgnoreKeywords, postFollowupIgnoreKeywords, getRepos, postRepos, getSettings, postSettings,
    getPrLabel, postPrLabel, getAiPrimaryTag, postAiPrimaryTag, getPrimaryProcessingLabels, postPrimaryProcessingLabels,
    getAgents: agentsRoutes.getAgents, postAgents: agentsRoutes.postAgents, getSummarizationSettings,
    postSummarizationSettings: indexingRoutes.postSummarizationSettings, getRepositoriesIndexingStatus: indexingRoutes.getRepositoriesIndexingStatus,
    triggerIndexing: indexingRoutes.triggerIndexing, triggerReindexAll: indexingRoutes.triggerReindexAll, stopIndexing: indexingRoutes.stopIndexing,
    getAgentTankSettings: agentTankRoutes.getAgentTankSettings, postAgentTankSettings: agentTankRoutes.postAgentTankSettings,
    getAgentTankStatus: agentTankRoutes.getAgentTankStatus, getAgentTankUsage: agentTankRoutes.getAgentTankUsage,
    postAgentTankRefresh: agentTankRoutes.postAgentTankRefresh, getAgentTankDetect: agentTankRoutes.getAgentTankDetect
  };
}
