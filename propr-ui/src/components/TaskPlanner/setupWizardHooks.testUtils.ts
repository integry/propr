import type { PlannerConfig } from './setupWizardHooks';

export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

export const baseConfig: PlannerConfig = {
  prompt: '',
  baseBranch: '',
  granularity: 'balanced',
  contextLevel: 50,
  compress: false,
  files: [],
  contextRepositories: [],
  generationModel: null,
  manualFiles: [],
  excludedFiles: [],
};

export const makeDraft = (overrides: Record<string, unknown> = {}) => ({
  draft_id: 'draft-1',
  repository: 'integry/propr',
  initial_prompt: 'Test prompt',
  status: 'draft',
  attachments: [],
  created_at: '2026-05-06T00:00:00Z',
  ...overrides,
});
