import { useState } from 'react';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBranchesLoader, useRepoInfoLoader, useDraftSettingsPersistence, type PlannerConfig } from './setupWizardHooks';
import { getRepoBranches, updateDraft } from '../../api/proprApi';
import { baseConfig, makeDraft } from './setupWizardHooks.testUtils';

vi.mock('../../api/proprApi', () => ({ uploadAttachment: vi.fn(), removeAttachment: vi.fn(), abortGeneration: vi.fn(), getInstanceCatalog: vi.fn(), getRepoBranches: vi.fn(), createDraft: vi.fn(), updateDraft: vi.fn(), generatePlan: vi.fn() }));
vi.mock('../../api/repoIndexingApi', () => ({ getRepositoriesIndexingStatus: vi.fn() }));
vi.mock('../../api/userRepoPreferencesApi', () => ({ getUserRepoPreferences: vi.fn() }));
vi.mock('../../hooks/usePlannerSettings', () => ({ savePlannerSettings: vi.fn() }));
vi.mock('./imageUtils', () => ({ resizeImage: vi.fn() }));

const mockGetRepoBranches = vi.mocked(getRepoBranches);
const mockUpdateDraft = vi.mocked(updateDraft);

describe('setupWizardHooks existing draft branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps an existing draft baseBranch when the repository catalog resolves after mount in edit mode', async () => {
    vi.useFakeTimers();
    try {
      const draft = makeDraft({ context_config: { baseBranch: 'main' } });
      const { result, rerender } = renderHook(({ catalogRepo, catalogBaseBranch }) => {
        const [config, setConfig] = useState<PlannerConfig>(baseConfig);
        useBranchesLoader(catalogRepo, catalogBaseBranch, setConfig, false);
        useRepoInfoLoader(false, draft, setConfig);
        useDraftSettingsPersistence(draft.draft_id, config, draft);
        return config;
      }, { initialProps: { catalogRepo: '', catalogBaseBranch: '' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(result.current.baseBranch).toBe('main');

      rerender({ catalogRepo: 'integry/other', catalogBaseBranch: 'develop' });
      await vi.advanceTimersByTimeAsync(1_100);

      expect(result.current.baseBranch).toBe('main');
      expect(mockGetRepoBranches).not.toHaveBeenCalled();
      expect(mockUpdateDraft).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
