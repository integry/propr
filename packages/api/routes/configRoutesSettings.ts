import * as configManager from '@propr/core';
import { extractSettingSaves } from './configHelpers.js';

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
}

type SaveResponse = { status: number; body: Record<string, unknown> };
type SpecializedSettingName =
  | 'auto_followup_score_threshold'
  | 'auto_resolve_merge_conflicts'
  | 'pr_review_model'
  | 'ultrafix_rating_goal'
  | 'ultrafix_max_cycles'
  | 'ultrafix_pause_seconds';

type SpecializedValueMap = {
  auto_followup_score_threshold: number;
  auto_resolve_merge_conflicts: boolean;
  pr_review_model: string;
  ultrafix_rating_goal: number;
  ultrafix_max_cycles: number;
  ultrafix_pause_seconds: number;
};

type SpecializedSave = { name: SpecializedSettingName; execute: () => Promise<unknown> };
type RollbackActionMap = Map<'general' | SpecializedSettingName, () => Promise<unknown>>;

const SPECIALIZED_SETTING_HANDLERS: {
  [K in SpecializedSettingName]: {
    load: (store: SettingsStore) => Promise<SpecializedValueMap[K]>;
    save: (store: SettingsStore, value: SpecializedValueMap[K]) => Promise<unknown>;
  };
} = {
  auto_followup_score_threshold: {
    load: store => store.loadAutoFollowupScoreThreshold(),
    save: (store, value) => store.saveAutoFollowupScoreThreshold(value)
  },
  auto_resolve_merge_conflicts: {
    load: store => store.loadAutoResolveMergeConflicts(),
    save: (store, value) => store.saveAutoResolveMergeConflicts(value)
  },
  pr_review_model: {
    load: store => store.loadPrReviewModel(),
    save: (store, value) => store.savePrReviewModel(value)
  },
  ultrafix_rating_goal: {
    load: store => store.loadUltrafixRatingGoal(),
    save: (store, value) => store.saveUltrafixRatingGoal(value)
  },
  ultrafix_max_cycles: {
    load: store => store.loadUltrafixMaxCycles(),
    save: (store, value) => store.saveUltrafixMaxCycles(value)
  },
  ultrafix_pause_seconds: {
    load: store => store.loadUltrafixPauseSeconds(),
    save: (store, value) => store.saveUltrafixPauseSeconds(value)
  }
};

function loadSpecializedValue<K extends SpecializedSettingName>(
  configStore: SettingsStore,
  name: K
): Promise<SpecializedValueMap[K]> {
  return SPECIALIZED_SETTING_HANDLERS[name].load(configStore);
}

function saveSpecializedValue<K extends SpecializedSettingName>(
  configStore: SettingsStore,
  name: K,
  value: SpecializedValueMap[K]
): Promise<unknown> {
  return SPECIALIZED_SETTING_HANDLERS[name].save(configStore, value);
}

function createSpecializedSaves(
  configStore: SettingsStore,
  names: SpecializedSettingName[],
  normalized: Record<string, unknown>
): SpecializedSave[] {
  return names.map(name => ({
    name,
    execute: () => saveSpecializedValue(configStore, name, normalized[name] as SpecializedValueMap[typeof name])
  }));
}

async function createGeneralRollbackActions(
  configStore: SettingsStore,
  hasGeneralSettings: boolean
): Promise<RollbackActionMap> {
  const rollbackActions: RollbackActionMap = new Map();
  if (hasGeneralSettings) {
    const previousSettings = await configStore.loadSettings();
    rollbackActions.set('general', () => configStore.saveConfig('settings', previousSettings));
  }
  return rollbackActions;
}

async function rollbackCommittedSettings(
  committedNames: Array<'general' | SpecializedSettingName>,
  rollbackActions: RollbackActionMap,
  failedName: SpecializedSettingName
): Promise<boolean> {
  let rollbackFailed = false;
  for (const name of committedNames.slice().reverse()) {
    const rollback = rollbackActions.get(name);
    if (!rollback) {
      continue;
    }
    try {
      await rollback();
    } catch (rollbackError) {
      rollbackFailed = true;
      console.error(`Failed to roll back settings after "${failedName}" save failure (target: "${name}")`, rollbackError);
    }
  }
  return rollbackFailed;
}

async function saveGeneralSettings(
  configStore: SettingsStore,
  otherSettings: Record<string, unknown>
): Promise<SaveResponse | null> {
  if (Object.keys(otherSettings).length === 0) {
    return null;
  }
  try {
    await configStore.saveSettings(otherSettings);
    return null;
  } catch (saveError) {
    console.error('Settings save failed for general settings:', saveError);
    return {
      status: 500,
      body: { error: 'Failed to save general settings. No settings were committed. Please retry or check system logs.' }
    };
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
  configStore = configManager
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

  const hasGeneralSettings = Object.keys(otherSettings).length > 0;
  const specializedSaves = createSpecializedSaves(
    configStore,
    extracted.saves.map(({ name }) => name as SpecializedSettingName),
    extracted.normalized
  );
  const rollbackActions = await createGeneralRollbackActions(configStore, hasGeneralSettings);
  const generalSettingsSaveError = await saveGeneralSettings(configStore, otherSettings);
  if (generalSettingsSaveError) {
    return generalSettingsSaveError;
  }

  const committedNames: Array<'general' | SpecializedSettingName> = hasGeneralSettings ? ['general'] : [];
  for (const save of specializedSaves) {
    try {
      const previousValue = await loadSpecializedValue(configStore, save.name);
      rollbackActions.set(save.name, () => saveSpecializedValue(configStore, save.name, previousValue));
      await save.execute();
      committedNames.push(save.name);
    } catch (saveError) {
      const failedName = save.name;
      console.error(`Settings save failed for "${failedName}" (already committed: [${committedNames.join(', ')}]):`, saveError);
      const rollbackFailed = await rollbackCommittedSettings(committedNames, rollbackActions, failedName);

      if (!rollbackFailed) {
        return {
          status: 500,
          body: {
            error: `Failed to save "${failedName}". Earlier changes were rolled back.`,
            rolled_back: committedNames
          }
        };
      }

      if (committedNames.length > 0) {
        await publishConfigUpdate('settings_update');
      }
      await publishConfigUpdate('settings_update_partial_failure');
      return {
        status: 500,
        body: {
          error: `Failed to save "${failedName}".${committedNames.length ? ` Already committed: ${committedNames.join(', ')}.` : ''} Please retry or check system logs.`,
          committed: committedNames
        }
      };
    }
  }

  await publishConfigUpdate('settings_update');
  return { status: 200, body: { success: true, settings: { ...otherSettings, ...extracted.normalized } } };
}
