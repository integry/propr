import { db } from '@propr/core';
import * as configManager from '@propr/core';
import { extractSettingSaves, ConfigRouteError, upsertConfigValue, buildMergedSettings, stripSpecializedSettings, loadPersistedSettingsRecord, type ConfigLockContext, type SettingSaveName } from './configHelpers.js';
import type { Knex } from 'knex';

interface SettingsStore {
  handleSettingsSaveSideEffects: typeof configManager.handleSettingsSaveSideEffects;
  loadSettings: typeof configManager.loadSettings;
  loadSettingsRecord?: () => Promise<Record<string, unknown>>;
  loadAgents?: typeof configManager.loadAgents;
}

interface SaveSettingsRequest {
  settings: Record<string, unknown>;
  publishConfigUpdate: (subtype: string) => Promise<void>;
  configStore?: SettingsStore;
  database?: Pick<Knex, 'transaction'>;
  lock?: ConfigLockContext;
}

type SaveResponse = { status: number; body: Record<string, unknown> };
type SpecializedSettingName = SettingSaveName;
interface PersistSettingsRequest {
  configStore: SettingsStore;
  otherSettings: Record<string, unknown>;
  normalizedSpecializedSettings: Partial<Record<SpecializedSettingName, unknown>>;
  specializedNames: SpecializedSettingName[];
  database: Pick<Knex, 'transaction'>;
  lock?: ConfigLockContext;
}

async function persistSettingsAtomically({
  configStore,
  otherSettings,
  normalizedSpecializedSettings,
  specializedNames,
  database,
  lock
}: PersistSettingsRequest): Promise<void> {
  let trx: Knex.Transaction | null = null;
  let committed = false;
  try {
    await lock?.assertLockHeld();
    const shouldRewriteGeneralSettings = Object.keys(otherSettings).length > 0 || specializedNames.length > 0;
    const generalSettingsPatch = Object.keys(otherSettings).length > 0 ? otherSettings : {};
    const mergedSettings = shouldRewriteGeneralSettings
      ? buildMergedSettings(
        stripSpecializedSettings(await loadPersistedSettingsRecord(configStore)),
        generalSettingsPatch
      )
      : null;
    trx = await database.transaction();
    const transaction = trx;

    if (mergedSettings !== null) {
      try {
        await upsertConfigValue(transaction, 'settings', mergedSettings);
      } catch (saveError) {
        console.error('Settings save failed for general settings:', saveError);
        throw new ConfigRouteError(500, {
          error: 'Failed to save general settings. No settings were committed. Please retry or check system logs.'
        });
      }
    }

    for (const name of specializedNames) {
      try {
        await upsertConfigValue(transaction, name, normalizedSpecializedSettings[name]);
      } catch (saveError) {
        console.error(`Settings save failed for "${name}":`, saveError);
        throw new ConfigRouteError(500, {
          error: `Failed to save "${name}". No settings were committed. Please retry or check system logs.`
        });
      }
    }

    await lock?.assertLockHeld();
    await transaction.commit();
    committed = true;
    lock?.markCommitted();
  } catch (error) {
    if (trx && !committed) {
      try {
        await trx.rollback();
      } catch {
        // Ignore rollback errors after a failed transaction; the original error is more actionable.
      }
    }
    throw error;
  }
}

async function applyCommittedSettingsUpdate({
  configStore,
  publishConfigUpdate
}: {
  configStore: SettingsStore;
  publishConfigUpdate: (subtype: string) => Promise<void>;
}): Promise<void> {
  let sideEffectsError: unknown = null;

  try {
    await configStore.handleSettingsSaveSideEffects();
  } catch (error) {
    sideEffectsError = error;
    console.error('Settings save side effects failed after commit:', error);
  }

  try {
    await publishConfigUpdate('settings_update');
  } catch (error) {
    console.error('Settings update publish failed after commit:', error);
    throw new ConfigRouteError(500, {
      error: sideEffectsError
        ? 'Settings were saved, but post-commit side effects failed and the settings update notification could not be published. Persisted settings may require a follow-up check.'
        : 'Settings were saved, but publishing the settings update notification failed. Other processes may still be using stale configuration.',
      committed: true
    });
  }

  if (sideEffectsError) {
    throw new ConfigRouteError(500, {
      error: 'Settings were saved and distributed, but post-commit side effects failed on this API instance. Persisted settings may require a follow-up check.',
      committed: true
    });
  }
}

function isPlainSettingsObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function normalizePrReviewContextSettings(settings: Record<string, unknown>): Promise<Record<string, unknown>> {
  if ('pr_review_context_enabled' in settings && typeof settings.pr_review_context_enabled !== 'boolean') {
    throw new ConfigRouteError(400, { error: 'pr_review_context_enabled must be a boolean' });
  }

  let normalized = settings;
  if ('pr_review_context_model' in settings) {
    if (typeof settings.pr_review_context_model !== 'string') {
      throw new ConfigRouteError(400, { error: 'pr_review_context_model must be a string' });
    }
    const model = settings.pr_review_context_model.trim();
    if (model === '' && settings.pr_review_context_model.length > 0) {
      throw new ConfigRouteError(400, { error: 'pr_review_context_model must not be whitespace-only; use an empty string to clear' });
    }
    const validation = await configManager.validatePrReviewModelValue(model);
    if (!validation.valid) {
      throw new ConfigRouteError(400, {
        error: validation.error?.replaceAll('pr_review_model', 'pr_review_context_model'),
      });
    }
    normalized = { ...settings, pr_review_context_model: model };
  }

  if ('pr_review_max_context_tokens' in settings) {
    const value = settings.pr_review_max_context_tokens;
    if (!Number.isSafeInteger(value) || (value !== 0 && ((value as number) < 10_000 || (value as number) > 2_000_000))) {
      throw new ConfigRouteError(400, { error: 'pr_review_max_context_tokens must be 0 (automatic) or an integer between 10000 and 2000000' });
    }
  }
  return normalized;
}

async function saveNormalizedSettingsWithRollback({
  settings,
  publishConfigUpdate,
  configStore = configManager,
  database = db,
  lock
}: SaveSettingsRequest): Promise<SaveResponse> {
  const {
    auto_followup_score_threshold,
    auto_resolve_merge_conflicts,
    model_reasoning_level,
    pr_review_model,
    ultrafix_rating_goal,
    ultrafix_max_cycles,
    ultrafix_pause_seconds,
    ...otherSettings
  } = settings;

  const extracted = await extractSettingSaves({
    auto_followup_score_threshold,
    auto_resolve_merge_conflicts,
    model_reasoning_level,
    pr_review_model,
    ultrafix_rating_goal,
    ultrafix_max_cycles,
    ultrafix_pause_seconds
  });

  if (extracted.error) {
    return { status: 400, body: { error: extracted.error } };
  }

  try {
    await persistSettingsAtomically({
      configStore,
      otherSettings,
      normalizedSpecializedSettings: extracted.normalized,
      specializedNames: extracted.saves.map(({ name }) => name),
      database,
      lock
    });
  } catch (error) {
    if (error instanceof ConfigRouteError) {
      return { status: error.status, body: error.body };
    }
    if (lock?.hasLockBeenLost()) {
      throw error;
    }
    console.error('Settings save failed before commit:', error);
    return {
      status: 500,
      body: { error: 'Failed to save settings. No settings were committed. Please retry or check system logs.' }
    };
  }

  try {
    await applyCommittedSettingsUpdate({ configStore, publishConfigUpdate });
  } catch (error) {
    if (error instanceof ConfigRouteError) {
      return { status: error.status, body: error.body };
    }
    if (lock?.hasLockBeenLost()) {
      throw error;
    }
    console.error('Settings save failed after commit:', error);
    return {
      status: 500,
      body: { error: 'Settings were saved, but post-commit processing failed. Persisted settings may require a follow-up check.', committed: true }
    };
  }

  let warnings: string[] = [];
  const savedReasoningLevel = extracted.normalized.model_reasoning_level;
  if (typeof savedReasoningLevel === 'string' && configStore.loadAgents) {
    try {
      const validatedLevel = configManager.validateModelReasoningLevel(savedReasoningLevel);
      if (validatedLevel.valid) {
        warnings = configManager.findReasoningLevelCliVersionWarnings(
          await configStore.loadAgents(),
          validatedLevel.value
        );
      }
    } catch (warningError) {
      console.warn('Could not evaluate reasoning-level CLI compatibility after settings save:', warningError);
    }
  }

  return {
    status: 200,
    body: {
      success: true,
      settings: { ...otherSettings, ...extracted.normalized },
      ...(warnings.length > 0 ? { warnings } : {})
    }
  };
}

export async function saveSettingsWithRollback(request: SaveSettingsRequest): Promise<SaveResponse> {
  if (!isPlainSettingsObject(request.settings)) {
    return { status: 400, body: { error: 'settings object is required' } };
  }
  if (Object.keys(request.settings).length === 0) {
    return { status: 200, body: { success: true, settings: {}, noop: true } };
  }

  try {
    const settings = await normalizePrReviewContextSettings(request.settings);
    return await saveNormalizedSettingsWithRollback({ ...request, settings });
  } catch (error) {
    if (error instanceof ConfigRouteError) return { status: error.status, body: error.body };
    throw error;
  }
}
