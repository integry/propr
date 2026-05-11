import React, { useState } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeIsGenerateDisabled,
  useBranchesLoader,
  useRepoInfoLoader,
  useDraftCreation,
  usePlannerSettingsPersistence,
  useDraftContextConfigSync,
  usePromptPersistence,
  useDraftSettingsPersistence,
  type PlannerConfig
} from './setupWizardHooks';
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
const makeDraft = (overrides: Record<string, unknown> = {}) => ({
  draft_id: 'draft-1',
  repository: 'integry/propr',
  initial_prompt: 'Test prompt',
  status: 'draft',
  attachments: [],
  created_at: '2026-05-06T00:00:00Z',
  ...overrides,
});
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
      expect.objectContaining({ context_config: { baseBranch: 'develop' } })
    );
    expect(mockGeneratePlan).toHaveBeenCalled();
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
  it('syncs draft context config into local state on first load only', async () => {
    const draft = makeDraft({
      initial_prompt: 'Draft prompt',
      attachments: [{ id: 'file-1', filename: 'foo.txt' }],
      context_config: {
        baseBranch: 'develop',
        granularity: 'granular',
        contextLevel: 80,
        compress: true,
        contextRepositories: [{ repository: 'integry/other', branch: 'main' }],
        generationModel: 'gpt-5',
        manualFiles: ['src/index.ts'],
        excludedFiles: ['dist/bundle.js'],
      }
    });

    const { result, rerender } = renderHook(
      ({ currentDraft }) => {
        const [config, setConfig] = useState<PlannerConfig>(baseConfig);
        useDraftContextConfigSync(currentDraft, setConfig);
        return config;
      },
      { initialProps: { currentDraft: draft } }
    );

    await waitFor(() => {
      expect(result.current).toMatchObject({
        prompt: 'Draft prompt',
        baseBranch: 'develop',
        granularity: 'granular',
        contextLevel: 80,
        compress: true,
        contextRepositories: [{ repository: 'integry/other', branch: 'main' }],
        generationModel: 'gpt-5',
        manualFiles: ['src/index.ts'],
        excludedFiles: ['dist/bundle.js'],
      });
      expect(result.current.files).toEqual([{ id: 'file-1', filename: 'foo.txt' }]);
    });

    rerender({
      currentDraft: makeDraft({
        ...draft,
        initial_prompt: 'Server updated prompt',
        context_config: {
          ...draft.context_config,
          baseBranch: 'release',
        }
      })
    });

    await waitFor(() => {
      expect(result.current.prompt).toBe('Draft prompt');
      expect(result.current.baseBranch).toBe('develop');
    });
  });
  it('debounces prompt persistence and skips no-op updates', async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => usePromptPersistence('draft-1', '  Updated prompt. Second sentence.  ', 'Original prompt'));

      await vi.advanceTimersByTimeAsync(999);
      expect(mockUpdateDraft).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(mockUpdateDraft).toHaveBeenCalledTimes(1);
      expect(mockUpdateDraft).toHaveBeenCalledWith(
        'draft-1',
        expect.objectContaining({
          initial_prompt: 'Updated prompt. Second sentence.',
          name: 'Updated prompt. Second sentence.',
        })
      );

      mockUpdateDraft.mockClear();
      renderHook(() => usePromptPersistence('draft-1', 'Original prompt', 'Original prompt'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockUpdateDraft).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it('debounces draft settings persistence and avoids saving unchanged server-backed config', async () => {
    vi.useFakeTimers();
    try {
      const draft = makeDraft({
        context_config: {
          baseBranch: 'develop',
          granularity: 'granular',
          contextLevel: 70,
          compress: true,
          contextRepositories: [{ repository: 'integry/other', branch: 'main' }],
          generationModel: 'gpt-5',
          manualFiles: ['src/index.ts'],
          excludedFiles: ['dist/bundle.js'],
        }
      });

      renderHook(() => useDraftSettingsPersistence('draft-1', {
        ...baseConfig,
        baseBranch: 'develop',
        granularity: 'granular',
        contextLevel: 70,
        compress: true,
        contextRepositories: [{ repository: 'integry/other', branch: 'main' }],
        generationModel: 'gpt-5',
        manualFiles: ['src/index.ts'],
        excludedFiles: ['dist/bundle.js'],
      }, draft));

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockUpdateDraft).not.toHaveBeenCalled();

      renderHook(() => useDraftSettingsPersistence('draft-1', {
        ...baseConfig,
        baseBranch: 'release',
        granularity: 'balanced',
        contextLevel: 20,
        compress: false,
        contextRepositories: [],
        generationModel: null,
        manualFiles: [],
        excludedFiles: [],
      }, draft));

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockUpdateDraft).toHaveBeenCalledWith(
        'draft-1',
        expect.objectContaining({
          context_config: {
            baseBranch: 'release',
            granularity: 'balanced',
            contextLevel: 20,
            compress: false,
            contextRepositories: [],
            generationModel: null,
            manualFiles: [],
            excludedFiles: [],
          }
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
describe('computeIsGenerateDisabled', () => {
  it('blocks new-mode generation until the branch is resolved', () => {
    expect(computeIsGenerateDisabled({
      isNewMode: true,
      isCreating: false,
      selectedRepo: 'integry/propr',
      promptTrimmed: 'Build a plan',
      reposLoading: false,
      isGenerating: false,
      branchError: null,
      repoInfoLoading: false,
      repoError: null,
      baseBranch: '',
    })).toBe(true);
  });

  it('allows edit-mode generation when branch data is ready', () => {
    expect(computeIsGenerateDisabled({
      isNewMode: false,
      isCreating: false,
      selectedRepo: '',
      promptTrimmed: 'Build a plan',
      reposLoading: false,
      isGenerating: false,
      branchError: null,
      repoInfoLoading: false,
      repoError: null,
      baseBranch: 'develop',
    })).toBe(false);
  });
});
