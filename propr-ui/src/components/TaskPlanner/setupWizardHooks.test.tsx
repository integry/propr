import React, { useState } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeIsGenerateDisabled,
  useBranchesLoader,
  useRepoInfoLoader,
  useDraftCreation,
  usePlannerSettingsPersistence,
  type PlannerConfig
} from './setupWizardHooks';
import { getRepoBranches, createDraft, generatePlan, updateDraft } from '../../api/proprApi';
import { savePlannerSettings } from '../../hooks/usePlannerSettings';
import { baseConfig, createDeferred, makeDraft } from './setupWizardHooks.testUtils';

vi.mock('../../api/proprApi', () => ({
  uploadAttachment: vi.fn(),
  removeAttachment: vi.fn(),
  abortGeneration: vi.fn(),
  getAgents: vi.fn(),
  getRepoConfig: vi.fn(),
  getRepoBranches: vi.fn(),
  createDraft: vi.fn(),
  updateDraft: vi.fn(),
  generatePlan: vi.fn(),
}));

vi.mock('../../api/repoIndexingApi', () => ({
  getRepositoriesIndexingStatus: vi.fn(),
}));

vi.mock('../../api/userRepoPreferencesApi', () => ({
  getUserRepoPreferences: vi.fn(),
}));

vi.mock('../../hooks/usePlannerSettings', () => ({
  savePlannerSettings: vi.fn(),
}));

vi.mock('./imageUtils', () => ({
  resizeImage: vi.fn(),
}));
const mockGetRepoBranches = vi.mocked(getRepoBranches);
const mockCreateDraft = vi.mocked(createDraft);
const mockGeneratePlan = vi.mocked(generatePlan);
const mockUpdateDraft = vi.mocked(updateDraft);
const mockSavePlannerSettings = vi.mocked(savePlannerSettings);
describe('setupWizardHooks branch resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('uses the selected repository entry baseBranch without fetching branch lists', async () => {
    const { result } = renderHook(() => {
      const [config, setConfig] = useState<PlannerConfig>(baseConfig);
      const state = useBranchesLoader('integry/propr', 'develop', setConfig);
      return { config, state };
    });
    await waitFor(() => {
      expect(result.current.config.baseBranch).toBe('develop');
    });
    expect(result.current.state.isLoading).toBe(false);
    expect(mockGetRepoBranches).not.toHaveBeenCalled();
  });
  it('falls back to the repository default branch when no configured baseBranch exists', async () => {
    mockGetRepoBranches.mockResolvedValue({ defaultBranch: 'main', branches: ['main', 'develop'] });

    const { result } = renderHook(() => {
      const [config, setConfig] = useState<PlannerConfig>(baseConfig);
      const state = useBranchesLoader('integry/propr', '', setConfig);
      return { config, state };
    });
    await waitFor(() => {
      expect(result.current.config.baseBranch).toBe('main');
    });
    expect(mockGetRepoBranches).toHaveBeenCalledWith('integry', 'propr');
  });
  it('clears the resolved base branch when branch lookup fails in new mode', async () => {
    mockGetRepoBranches.mockRejectedValue(new Error('GitHub unavailable'));

    const { result } = renderHook(() => {
      const [config, setConfig] = useState<PlannerConfig>({ ...baseConfig, baseBranch: 'develop' });
      const state = useBranchesLoader('integry/propr', '', setConfig);
      return { config, state };
    });

    await waitFor(() => {
      expect(result.current.state.error).toBe('GitHub unavailable');
    });

    expect(result.current.config.baseBranch).toBe('');
  });
  it('ignores stale branch lookup results after the selected repo changes', async () => {
    const firstRequest = createDeferred<{ defaultBranch: string; branches: string[] }>();
    const secondRequest = createDeferred<{ defaultBranch: string; branches: string[] }>();
    mockGetRepoBranches
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);

    const { result, rerender } = renderHook(
      ({ repo, configuredBaseBranch }: { repo: string; configuredBaseBranch: string }) => {
        const [config, setConfig] = useState<PlannerConfig>(baseConfig);
        const state = useBranchesLoader(repo, configuredBaseBranch, setConfig);
        return { config, state };
      },
      { initialProps: { repo: 'integry/propr', configuredBaseBranch: '' } }
    );

    rerender({ repo: 'integry/other', configuredBaseBranch: '' });
    secondRequest.resolve({ defaultBranch: 'release', branches: ['release'] });
    await waitFor(() => expect(result.current.config.baseBranch).toBe('release'));

    firstRequest.resolve({ defaultBranch: 'main', branches: ['main'] });
    await waitFor(() => expect(result.current.config.baseBranch).toBe('release'));
  });
  it('preserves a draft context_config baseBranch instead of snapping back to the GitHub default branch', async () => {
    const draft = makeDraft({ context_config: { baseBranch: 'develop' } });

    const { result } = renderHook(() => {
      const [config, setConfig] = useState<PlannerConfig>(baseConfig);
      const state = useRepoInfoLoader(false, draft, setConfig);
      return { config, state };
    });

    await waitFor(() => {
      expect(result.current.config.baseBranch).toBe('develop');
    });

    expect(result.current.state.isLoading).toBe(false);
    expect(mockGetRepoBranches).not.toHaveBeenCalled();
  });
  it('ignores stale repo info lookups after the draft changes', async () => {
    const firstRequest = createDeferred<{ defaultBranch: string; branches: string[] }>();
    const secondRequest = createDeferred<{ defaultBranch: string; branches: string[] }>();
    mockGetRepoBranches
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);

    const { result, rerender } = renderHook(
      ({ draft }) => {
        const [config, setConfig] = useState<PlannerConfig>(baseConfig);
        const state = useRepoInfoLoader(false, draft, setConfig);
        return { config, state };
      },
      { initialProps: { draft: makeDraft() } }
    );
    rerender({ draft: makeDraft({ draft_id: 'draft-2', repository: 'integry/other' }) });

    secondRequest.resolve({ defaultBranch: 'release', branches: ['release'] });
    await waitFor(() => expect(result.current.config.baseBranch).toBe('release'));

    firstRequest.resolve({ defaultBranch: 'main', branches: ['main'] });
    await waitFor(() => expect(result.current.config.baseBranch).toBe('release'));
  });
  it('persists the resolved baseBranch when creating a draft before generation starts', async () => {
    mockCreateDraft.mockResolvedValue(makeDraft());

    const navigate = vi.fn();
    const setError = vi.fn();
    const setIsCreating = vi.fn();

    const { result } = renderHook(() => useDraftCreation({
      selectedRepo: 'integry/propr',
      config: { ...baseConfig, prompt: 'Test prompt', baseBranch: 'develop' },
      localFiles: [],
      navigate,
      setError,
      setIsCreating,
    }));

    await result.current();

    expect(mockUpdateDraft).toHaveBeenCalledWith(
      'draft-1',
      expect.objectContaining({
        context_config: {
          baseBranch: 'develop',
          granularity: 'balanced',
          contextLevel: 50,
          compress: false,
          contextRepositories: [],
          generationModel: undefined,
          manualFiles: [],
          excludedFiles: [],
        }
      })
    );
    expect(mockGeneratePlan).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(
      '/studio/draft-1',
      expect.objectContaining({
        state: expect.objectContaining({
          initialDraft: expect.objectContaining({
            context_config: {
              baseBranch: 'develop',
              granularity: 'balanced',
              contextLevel: 50,
              compress: false,
              contextRepositories: [],
              generationModel: undefined,
              manualFiles: [],
              excludedFiles: [],
            }
          })
        })
      })
    );
  });
  it('continues generation when persisting the resolved baseBranch fails after draft creation', async () => {
    mockCreateDraft.mockResolvedValue(makeDraft());
    mockUpdateDraft.mockRejectedValue(new Error('Transient update failure'));

    const navigate = vi.fn();
    const setError = vi.fn();
    const setIsCreating = vi.fn();

    const { result } = renderHook(() => useDraftCreation({
      selectedRepo: 'integry/propr',
      config: { ...baseConfig, prompt: 'Test prompt', baseBranch: 'develop' },
      localFiles: [],
      navigate,
      setError,
      setIsCreating,
    }));

    await result.current();

    expect(mockGeneratePlan).toHaveBeenCalledWith(
      'draft-1',
      expect.objectContaining({ baseBranch: 'develop' })
    );
    expect(navigate).toHaveBeenCalledWith(
      '/studio/draft-1',
      expect.objectContaining({
        replace: true,
        state: expect.objectContaining({
          initialBaseBranch: 'develop',
          baseBranchPersistenceWarning: expect.stringContaining('failed to save setup settings including base branch "develop"')
        })
      })
    );
    expect(setError).not.toHaveBeenCalledWith('Transient update failure');
  });
  it('persists only the explicitly selected repo-entry branch for repository restoration', () => {
    renderHook(() => usePlannerSettingsPersistence(
      { ...baseConfig, baseBranch: 'main' },
      undefined,
      undefined,
      'integry/propr',
      ''
    ));

    expect(mockSavePlannerSettings).toHaveBeenCalledWith({
      lastRepository: 'integry/propr',
      lastBaseBranch: null,
    });
    expect(mockSavePlannerSettings).not.toHaveBeenCalledWith({
      lastRepository: 'integry/propr',
      lastBaseBranch: 'main',
    });
  });
  it('persists the draft repository branch together with the draft repository in edit mode', () => {
    renderHook(() => usePlannerSettingsPersistence(
      { ...baseConfig, baseBranch: 'release' },
      'integry/propr',
      'develop',
      'integry/other',
      'release'
    ));

    expect(mockSavePlannerSettings).toHaveBeenCalledWith({
      lastRepository: 'integry/propr',
      lastBaseBranch: 'develop',
    });
    expect(mockSavePlannerSettings).not.toHaveBeenCalledWith({
      lastRepository: 'integry/propr',
      lastBaseBranch: 'release',
    });
  });
});
describe('computeIsGenerateDisabled', () => {
  it('blocks new-mode generation until the branch is resolved', () => {
    expect(computeIsGenerateDisabled({
      isNewMode: true,
      isCreating: false,
      selectedRepo: 'integry/propr',
      promptTrimmed: 'Test prompt',
      reposLoading: false,
      isGenerating: false,
      branchError: null,
      repoInfoLoading: true,
      repoError: null,
      baseBranch: '',
    })).toBe(true);
  });
  it('blocks generation when repository branch lookup fails', () => {
    expect(computeIsGenerateDisabled({
      isNewMode: false,
      isCreating: false,
      selectedRepo: 'integry/propr',
      promptTrimmed: 'Test prompt',
      reposLoading: false,
      isGenerating: false,
      branchError: null,
      repoInfoLoading: false,
      repoError: 'GitHub unavailable',
      baseBranch: '',
    })).toBe(true);
  });
  it('blocks edit-mode generation while a replacement draft is being created', () => {
    expect(computeIsGenerateDisabled({
      isNewMode: false,
      isCreating: true,
      selectedRepo: 'integry/propr',
      promptTrimmed: 'Test prompt',
      reposLoading: false,
      isGenerating: false,
      branchError: null,
      repoInfoLoading: false,
      repoError: null,
      baseBranch: 'main',
    })).toBe(true);
  });
});
