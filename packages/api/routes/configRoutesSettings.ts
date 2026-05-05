import { db } from '@propr/core';
import * as configManager from '@propr/core';
import { extractSettingSaves, ConfigRouteError, upsertConfigValue, type ConfigLockContext, type SettingSaveName } from './configHelpers.js';
import { invalidateSettingsCache } from '../../core/src/services/relevance/keywordExtractor.js';
import type { Knex } from 'knex';

interface SettingsStore {
  saveSettings: typeof configManager.saveSettings;
  saveConfig: typeof configManager.saveConfig;
  loadSettings: typeof configManager.loadSettings;
  loadAutoFollowupScoreThreshold: typeof configManager.loadAutoFollowupScoreThreshold;
  saveAutoFollowupScoreThreshold: typeof configManager.saveAutoFollowupScoreThreshold;
  loadAutoResolveMergeConflicts: typeof configManager.loadAutoResolveMergeConflicts;
  saveAutoResolveMergeConflicts: typeof configManager.saveAutoResolveMergeConflicts;
  loadPrReviewModel: typeof configManager.loadPrReviewModel;
  savePrReviewModel: typeof configManager.savePrReviewModel;
  loadUltrafixRatingGoal: typeof configManager.loadUltrafixRatingGoal;
  saveUltrafixRatingGoal: typeof configManager.saveUltrafixRatingGoal;
  loadUltrafixMaxCycles: typeof configManager.loadUltrafixMaxCycles;
  saveUltrafixMaxCycles: typeof configManager.saveUltrafixMaxCycles;
  loadUltrafixPauseSeconds: typeof configManager.loadUltrafixPauseSeconds;
  saveUltrafixPauseSeconds: typeof configManager.saveUltrafixPauseSeconds;
}

interface SaveSettingsRequest {
  settings: Record<string, unknown>;
  publishConfigUpdate: (subtype: string) => Promise<void>;
  configStore?: SettingsStore;
  lock?: ConfigLockContext;
}

type SaveResponse = { status: number; body: Record<string, unknown> };
type SpecializedSettingName = SettingSaveName;

function buildMergedSettings(previousSettings: Record<string, unknown>, updates: Record<string, unknown>): Record<string, unknown> {
  const mergedSettings = { ...previousSettings, ...updates };
  for (const [key, value] of Object.entries(mergedSettings)) {
    if (value === undefined) {
      delete mergedSettings[key];
    }
  }
  return mergedSettings;
}

async function persistSettingsAtomically(
  configStore: SettingsStore,
  otherSettings: Record<string, unknown>,
  normalizedSpecializedSettings: Record<string, unknown>,
  specializedNames: SpecializedSettingName[],
  lock?: ConfigLockContext
): Promise<void> {
  let trx: Knex.Transaction | null = null;
  try {
    await lock?.assertLockHeld();
    const mergedSettings = Object.keys(otherSettings).length > 0
      ? buildMergedSettings(await configStore.loadSettings() as Record<string, unknown>, otherSettings)
      : null;
    trx = await db.transaction();

    if (mergedSettings) {
      try {
        await upsertConfigValue(trx, 'settings', mergedSettings);
      } catch (saveError) {
        console.error('Settings save failed for general settings:', saveError);
        throw new ConfigRouteError(500, {
          error: 'Failed to save general settings. No settings were committed. Please retry or check system logs.'
        });
      }
    }

    for (const name of specializedNames) {
      try {
        await lock?.assertLockHeld();
        await upsertConfigValue(trx, name, normalizedSpecializedSettings[name]);
      } catch (saveError) {
        console.error(`Settings save failed for "${name}":`, saveError);
        throw new ConfigRouteError(500, {
          error: `Failed to save "${name}". No settings were committed. Please retry or check system logs.`
        });
      }
    }

    await lock?.assertLockHeld();
    await trx.commit();
    invalidateSettingsCache();
  } catch (error) {
    if (trx) {
      try {
        await trx.rollback();
      } catch {
        // Ignore rollback errors after a failed transaction; the original error is more actionable.
      }
    }
    throw error;
  }
}

function isPlainSettingsObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export async function saveSettingsWithRollback({
  settings,
  publishConfigUpdate,
  configStore = configManager,
  lock
}: SaveSettingsRequest): Promise<SaveResponse> {
  if (!isPlainSettingsObject(settings)) {
    return { status: 400, body: { error: 'settings object is required' } };
  }

  const {
    auto_followup_score_threshold,
    auto_resolve_merge_conflicts,
    pr_review_model,
    ultrafix_rating_goal,
    ultrafix_max_cycles,
    ultrafix_pause_seconds,
    ...otherSettings
  } = settings;

  const extracted = await extractSettingSaves({
    auto_followup_score_threshold,
    auto_resolve_merge_conflicts,
    pr_review_model,
    ultrafix_rating_goal,
    ultrafix_max_cycles,
    ultrafix_pause_seconds
  });

  if (extracted.error) {
    return { status: 400, body: { error: extracted.error } };
  }

  try {
    await persistSettingsAtomically(
      configStore,
      otherSettings,
      extracted.normalized,
      extracted.saves.map(({ name }) => name),
      lock
    );
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

  await publishConfigUpdate('settings_update');
  return { status: 200, body: { success: true, settings: { ...otherSettings, ...extracted.normalized } } };
}
