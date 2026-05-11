import type { PlannerConfig } from './setupWizardHooks';
import type { DraftSetupSnapshot } from './useAutoDraftCreation';

type DraftSetupConfig = Pick<
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

export function buildGenerationPayload(config: PlannerConfig) {
  return {
    baseBranch: config.baseBranch,
    granularity: config.granularity,
    contextLevel: config.contextLevel,
    compress: config.compress,
    contextRepositories: config.contextRepositories,
    generationModel: config.generationModel || undefined,
    excludedFiles: config.excludedFiles.length > 0 ? config.excludedFiles : undefined,
  };
}

export function getDraftSetupSnapshot(
  config: DraftSetupConfig
): DraftSetupSnapshot {
  return {
    baseBranch: config.baseBranch,
    granularity: config.granularity,
    contextLevel: config.contextLevel,
    compress: config.compress,
    contextRepositories: config.contextRepositories,
    generationModel: config.generationModel ?? undefined,
    manualFiles: config.manualFiles,
    excludedFiles: config.excludedFiles,
  };
}
