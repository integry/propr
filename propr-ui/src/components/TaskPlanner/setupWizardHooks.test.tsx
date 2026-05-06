import React, { useState } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeIsGenerateDisabled, useBranchesLoader, useRepoInfoLoader, useDraftCreation, usePlannerSettingsPersistence, type PlannerConfig } from './setupWizardHooks';
import { getRepoBranches, createDraft, generatePlan, updateDraft } from '../../api/proprApi';
import { savePlannerSettings } from '../../hooks/usePlannerSettings';

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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const baseConfig: PlannerConfig = {
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
    const draft = {
      draft_id: 'draft-1',
      repository: 'integry/propr',
      initial_prompt: 'Test prompt',
      status: 'draft',
      attachments: [],
      created_at: '2026-05-06T00:00:00Z',
      context_config: { baseBranch: 'develop' },
    };

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
      {
        initialProps: {
          draft: {
            draft_id: 'draft-1',
            repository: 'integry/propr',
            initial_prompt: 'Test prompt',
            status: 'draft',
            attachments: [],
            created_at: '2026-05-06T00:00:00Z',
          },
        },
      }
    );

    rerender({
      draft: {
        draft_id: 'draft-2',
        repository: 'integry/other',
        initial_prompt: 'Test prompt',
        status: 'draft',
        attachments: [],
        created_at: '2026-05-06T00:00:00Z',
      },
    });

    secondRequest.resolve({ defaultBranch: 'release', branches: ['release'] });
    await waitFor(() => expect(result.current.config.baseBranch).toBe('release'));

    firstRequest.resolve({ defaultBranch: 'main', branches: ['main'] });
    await waitFor(() => expect(result.current.config.baseBranch).toBe('release'));
  });

  it('persists the resolved baseBranch when creating a draft before generation starts', async () => {
    mockCreateDraft.mockResolvedValue({
      draft_id: 'draft-1',
      repository: 'integry/propr',
      initial_prompt: 'Test prompt',
      status: 'draft',
      attachments: [],
      created_at: '2026-05-06T00:00:00Z',
    });

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
      expect.objectContaining({ context_config: { baseBranch: 'develop' } })
    );
    expect(mockGeneratePlan).toHaveBeenCalled();
  });

  it('continues generation when persisting the resolved baseBranch fails after draft creation', async () => {
    mockCreateDraft.mockResolvedValue({
      draft_id: 'draft-1',
      repository: 'integry/propr',
      initial_prompt: 'Test prompt',
      status: 'draft',
      attachments: [],
      created_at: '2026-05-06T00:00:00Z',
    });
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
          baseBranchPersistenceWarning: expect.stringContaining('failed to save base branch "develop"')
        })
      })
    );
    expect(setError).not.toHaveBeenCalledWith('Transient update failure');
  });

  it('persists only the explicitly selected repo-entry branch for repository restoration', () => {
    renderHook(() => usePlannerSettingsPersistence(
      { ...baseConfig, baseBranch: 'main' },
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
