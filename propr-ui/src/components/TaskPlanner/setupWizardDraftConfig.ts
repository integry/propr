import type {
  DraftContextConfig,
  PlannerAttachment,
  PlannerDraft,
} from '../../api/proprApi';
import type { PlannerConfig } from './setupWizardHooks';

type DraftWithContextConfig = PlannerDraft & { context_config?: DraftContextConfig };

type DraftConfigSnapshot = Pick<
  PlannerConfig,
  | 'prompt'
  | 'baseBranch'
  | 'granularity'
  | 'contextLevel'
  | 'compress'
  | 'files'
  | 'contextRepositories'
  | 'generationModel'
  | 'manualFiles'
  | 'excludedFiles'
>;

export type PersistedDraftSettings = Pick<
  PlannerConfig,
  | 'baseBranch'
  | 'granularity'
  | 'contextLevel'
  | 'compress'
  | 'contextRepositories'
  | 'generationModel'
  | 'manualFiles'
  | 'excludedFiles'
>;

type DraftConfigPatch = Partial<DraftConfigSnapshot>;

const ensureArray = <T,>(value: T[] | unknown): T[] =>
  Array.isArray(value) ? value : [];

function hasDraftConfigValue<K extends keyof DraftContextConfig>(
  draftConfig: DraftContextConfig | undefined,
  key: K
): draftConfig is DraftContextConfig & Required<Pick<DraftContextConfig, K>> {
  return !!draftConfig && Object.prototype.hasOwnProperty.call(draftConfig, key);
}

export function getDraftConfigSnapshot(
  draft: PlannerDraft | undefined
): DraftConfigPatch | null {
  if (!draft) return null;

  const draftConfig = (draft as DraftWithContextConfig).context_config;
  const snapshot: DraftConfigPatch = {
    prompt: draft.initial_prompt,
    files: ensureArray<PlannerAttachment>(draft.attachments),
  };

  if (hasDraftConfigValue(draftConfig, 'baseBranch')) {
    snapshot.baseBranch = draftConfig.baseBranch ?? '';
  }
  if (hasDraftConfigValue(draftConfig, 'granularity')) {
    snapshot.granularity = draftConfig.granularity ?? 'balanced';
  }
  if (hasDraftConfigValue(draftConfig, 'contextLevel')) {
    snapshot.contextLevel = draftConfig.contextLevel ?? 50;
  }
  if (hasDraftConfigValue(draftConfig, 'compress')) {
    snapshot.compress = draftConfig.compress ?? false;
  }
  if (hasDraftConfigValue(draftConfig, 'contextRepositories')) {
    snapshot.contextRepositories = ensureArray<{ repository: string; branch?: string }>(
      draftConfig.contextRepositories
    );
  }
  if (hasDraftConfigValue(draftConfig, 'generationModel')) {
    snapshot.generationModel = draftConfig.generationModel ?? null;
  }
  if (hasDraftConfigValue(draftConfig, 'manualFiles')) {
    snapshot.manualFiles = ensureArray<string>(draftConfig.manualFiles);
  }
  if (hasDraftConfigValue(draftConfig, 'excludedFiles')) {
    snapshot.excludedFiles = ensureArray<string>(draftConfig.excludedFiles);
  }

  return snapshot;
}

export function getHydratedDraftConfigSnapshot(
  draft: PlannerDraft | undefined
): DraftConfigSnapshot | null {
  if (!draft) return null;

  const draftConfig = (draft as DraftWithContextConfig).context_config;

  return {
    prompt: draft.initial_prompt,
    baseBranch: draftConfig?.baseBranch ?? '',
    granularity: draftConfig?.granularity ?? 'balanced',
    contextLevel: draftConfig?.contextLevel ?? 50,
    compress: draftConfig?.compress ?? false,
    files: ensureArray<PlannerAttachment>(draft.attachments),
    contextRepositories: ensureArray<{ repository: string; branch?: string }>(
      draftConfig?.contextRepositories
    ),
    generationModel: draftConfig?.generationModel ?? null,
    manualFiles: ensureArray<string>(draftConfig?.manualFiles),
    excludedFiles: ensureArray<string>(draftConfig?.excludedFiles),
  };
}

export function matchesDraftConfig(
  prev: PlannerConfig,
  next: DraftConfigPatch
): boolean {
  const entries = Object.entries(next) as [
    keyof DraftConfigSnapshot,
    DraftConfigSnapshot[keyof DraftConfigSnapshot],
  ][];

  return entries.every(([key, value]) => {
    if (Array.isArray(value) || (value && typeof value === 'object')) {
      return JSON.stringify(prev[key]) === JSON.stringify(value);
    }

    return prev[key] === value;
  });
}

export function getPersistedDraftSettings(
  config: PlannerConfig
): PersistedDraftSettings {
  return {
    baseBranch: config.baseBranch,
    granularity: config.granularity,
    contextLevel: config.contextLevel,
    compress: config.compress,
    contextRepositories: config.contextRepositories,
    generationModel: config.generationModel,
    manualFiles: config.manualFiles,
    excludedFiles: config.excludedFiles,
  };
}

export function serializePersistedDraftSettings(
  settings: PersistedDraftSettings
): string {
  return JSON.stringify(settings);
}
