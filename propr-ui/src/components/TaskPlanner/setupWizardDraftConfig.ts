import type {
  DraftContextConfig,
  PlannerAttachment,
  PlannerDraft,
} from '../../api/proprApi';
import type { PlannerConfig } from './setupWizardHooks';

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(entry => typeof entry === 'string');

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === 'string';

function isContextRepository(value: unknown): boolean {
  return isRecord(value)
    && typeof value.repository === 'string'
    && value.repository.trim().length > 0
    && isOptionalString(value.branch)
    && isOptionalString(value.description);
}

function isGranularityEnforcement(value: unknown): boolean {
  return isRecord(value)
    && typeof value.enforced === 'boolean'
    && typeof value.granularity === 'string'
    && ['single', 'balanced', 'granular'].includes(value.granularity)
    && isFiniteNumber(value.originalTaskCount)
    && isFiniteNumber(value.finalTaskCount)
    && isOptionalString(value.message);
}

function isContextCache(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.fileTokenCounts === undefined) return true;
  return isRecord(value.fileTokenCounts)
    && Object.values(value.fileTokenCounts).every(isFiniteNumber);
}

function isPreviewStats(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const required = ['totalTokens', 'costEstimate', 'contextLength', 'fileCount'];
  const optional = [
    'maxTokens',
    'modelMaxContextTokens',
    'attachmentTokens',
    'usageEstimatePercent',
  ];
  return required.every(key => isFiniteNumber(value[key]))
    && optional.every(key => value[key] === undefined || isFiniteNumber(value[key]))
    && isOptionalString(value.modelName);
}

function isSmartFileSelection(value: unknown): boolean {
  return isRecord(value)
    && typeof value.path === 'string'
    && typeof value.reason === 'string'
    && typeof value.source === 'string'
    && ['manual', 'auto', 'context-repo'].includes(value.source)
    && isOptionalString(value.repository)
    && (value.score === undefined || isFiniteNumber(value.score));
}

function isLastPreview(value: unknown): boolean {
  return isRecord(value)
    && typeof value.success === 'boolean'
    && isPreviewStats(value.stats)
    && Array.isArray(value.smartSelection)
    && value.smartSelection.every(isSmartFileSelection)
    && isStringArray(value.warnings);
}

type DraftFieldValidator = (value: unknown) => boolean;

const DRAFT_CONTEXT_FIELD_VALIDATORS = {
  baseBranch: (value: unknown) => typeof value === 'string',
  granularity: (value: unknown) => typeof value === 'string'
    && ['single', 'balanced', 'granular'].includes(value),
  contextLevel: isFiniteNumber,
  compress: (value: unknown) => typeof value === 'boolean',
  manualFiles: isStringArray,
  autoFiles: isStringArray,
  contextRepositories: (value: unknown) => Array.isArray(value) && value.every(isContextRepository),
  granularityEnforcement: isGranularityEnforcement,
  generationModel: (value: unknown) => value === null || typeof value === 'string',
  excludedFiles: isStringArray,
  contextCache: isContextCache,
  lastPreview: isLastPreview,
  lastPreviewRequestId: (value: unknown) => typeof value === 'string',
  lastPreviewError: (value: unknown) => typeof value === 'string',
  useEpic: (value: unknown) => typeof value === 'boolean',
  autoMerge: (value: unknown) => typeof value === 'boolean',
  runUltrafix: (value: unknown) => typeof value === 'boolean',
  ultrafixGoal: (value: unknown) => value === null || isFiniteNumber(value),
  ultrafixMaxCycles: (value: unknown) => value === null || isFiniteNumber(value),
  epicLabel: (value: unknown) => typeof value === 'string',
} satisfies Record<keyof DraftContextConfig, DraftFieldValidator>;

export function parseDraftContextConfig(value: unknown): DraftContextConfig | undefined {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return undefined;
    }
  }

  if (!isRecord(parsed)) return undefined;

  const validated: Record<string, unknown> = {};
  const validators = Object.entries(DRAFT_CONTEXT_FIELD_VALIDATORS) as Array<[
    keyof DraftContextConfig,
    DraftFieldValidator,
  ]>;
  for (const [key, validate] of validators) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
    if (!validate(parsed[key])) return undefined;
    validated[key] = parsed[key];
  }
  return validated as DraftContextConfig;
}

export function getDraftContextConfig(
  draft: PlannerDraft | undefined
): DraftContextConfig | undefined {
  return parseDraftContextConfig(draft?.context_config);
}

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

  const draftConfig = getDraftContextConfig(draft);
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

  const draftConfig = getDraftContextConfig(draft);

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
