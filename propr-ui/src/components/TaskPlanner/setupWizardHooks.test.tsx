import React, { useState } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeIsGenerateDisabled, useBranchesLoader, useRepoInfoLoader, useDraftCreation, usePlannerSettingsPersistence, useDraftContextConfigSync, usePromptPersistence, useDraftSettingsPersistence, type PlannerConfig } from './setupWizardHooks';
import { getRepoBranches, createDraft, generatePlan, updateDraft } from '../../api/proprApi';
import { savePlannerSettings } from '../../hooks/usePlannerSettings';

vi.mock('../../api/proprApi', () => ({ uploadAttachment: vi.fn(), removeAttachment: vi.fn(), abortGeneration: vi.fn(), getAgents: vi.fn(), getRepoConfig: vi.fn(), getRepoBranches: vi.fn(), createDraft: vi.fn(), updateDraft: vi.fn(), generatePlan: vi.fn() }));
vi.mock('../../api/repoIndexingApi', () => ({ getRepositoriesIndexingStatus: vi.fn() }));
vi.mock('../../api/userRepoPreferencesApi', () => ({ getUserRepoPreferences: vi.fn() }));
vi.mock('../../hooks/usePlannerSettings', () => ({ savePlannerSettings: vi.fn() }));
vi.mock('./imageUtils', () => ({ resizeImage: vi.fn() }));

const mockGetRepoBranches = vi.mocked(getRepoBranches);
const mockCreateDraft = vi.mocked(createDraft);
const mockGeneratePlan = vi.mocked(generatePlan);
const mockUpdateDraft = vi.mocked(updateDraft);
const mockSavePlannerSettings = vi.mocked(savePlannerSettings);
const baseConfig: PlannerConfig = { prompt: '', baseBranch: '', granularity: 'balanced', contextLevel: 50, compress: false, files: [], contextRepositories: [], generationModel: null, manualFiles: [], excludedFiles: [] };
const makeDraft = (overrides: Record<string, unknown> = {}) => ({ draft_id: 'draft-1', repository: 'integry/propr', initial_prompt: 'Test prompt', status: 'draft', attachments: [], created_at: '2026-05-06T00:00:00Z', ...overrides });

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function renderBranchesLoader(repo: string, configuredBaseBranch = '', initialConfig: PlannerConfig = baseConfig) {
  return renderHook(({ currentRepo, currentBaseBranch }) => {
    const [config, setConfig] = useState<PlannerConfig>(initialConfig);
    const state = useBranchesLoader(currentRepo, currentBaseBranch, setConfig);
    return { config, state };
  }, { initialProps: { currentRepo: repo, currentBaseBranch: configuredBaseBranch } });
}

function renderRepoInfoLoader(draft = makeDraft(), initialConfig: PlannerConfig = baseConfig) {
  return renderHook(({ currentDraft }) => {
    const [config, setConfig] = useState<PlannerConfig>(initialConfig);
    const state = useRepoInfoLoader(false, currentDraft as never, setConfig);
    return { config, state };
  }, { initialProps: { currentDraft: draft } });
}

describe('setupWizardHooks branch resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the selected repository entry baseBranch without fetching branch lists', async () => {
    const { result } = renderBranchesLoader('integry/propr', 'develop');
    await waitFor(() => expect(result.current.config.baseBranch).toBe('develop'));
    expect(result.current.state.isLoading).toBe(false);
    expect(mockGetRepoBranches).not.toHaveBeenCalled();
  });

  it('falls back to the repository default branch when no configured baseBranch exists', async () => {
    mockGetRepoBranches.mockResolvedValue({ defaultBranch: 'main', branches: ['main', 'develop'] });
    const { result } = renderBranchesLoader('integry/propr');
    await waitFor(() => expect(result.current.config.baseBranch).toBe('main'));
    expect(mockGetRepoBranches).toHaveBeenCalledWith('integry', 'propr');
  });

  it('clears the resolved base branch when branch lookup fails in new mode', async () => {
    mockGetRepoBranches.mockRejectedValue(new Error('GitHub unavailable'));
    const { result } = renderBranchesLoader('integry/propr', '', { ...baseConfig, baseBranch: 'develop' });
    await waitFor(() => expect(result.current.state.error).toBe('GitHub unavailable'));
    expect(result.current.config.baseBranch).toBe('');
  });

  it('ignores stale branch lookup results after the selected repo changes', async () => {
    const firstRequest = createDeferred<{ defaultBranch: string; branches: string[] }>();
    const secondRequest = createDeferred<{ defaultBranch: string; branches: string[] }>();
    mockGetRepoBranches.mockReturnValueOnce(firstRequest.promise).mockReturnValueOnce(secondRequest.promise);
    const { result, rerender } = renderBranchesLoader('integry/propr');
    rerender({ currentRepo: 'integry/other', currentBaseBranch: '' });
    secondRequest.resolve({ defaultBranch: 'release', branches: ['release'] });
    await waitFor(() => expect(result.current.config.baseBranch).toBe('release'));
    firstRequest.resolve({ defaultBranch: 'main', branches: ['main'] });
    await waitFor(() => expect(result.current.config.baseBranch).toBe('release'));
  });

  it('preserves a draft context_config baseBranch instead of snapping back to the GitHub default branch', async () => {
    const { result } = renderRepoInfoLoader(makeDraft({ context_config: { baseBranch: 'develop' } }));
    await waitFor(() => expect(result.current.config.baseBranch).toBe('develop'));
    expect(result.current.state.isLoading).toBe(false);
    expect(mockGetRepoBranches).not.toHaveBeenCalled();
  });

  it('ignores stale repo info lookups after the draft changes', async () => {
    const firstRequest = createDeferred<{ defaultBranch: string; branches: string[] }>();
    const secondRequest = createDeferred<{ defaultBranch: string; branches: string[] }>();
    mockGetRepoBranches.mockReturnValueOnce(firstRequest.promise).mockReturnValueOnce(secondRequest.promise);
    const { result, rerender } = renderRepoInfoLoader();
    rerender({ currentDraft: makeDraft({ draft_id: 'draft-2', repository: 'integry/other' }) });
    secondRequest.resolve({ defaultBranch: 'release', branches: ['release'] });
    await waitFor(() => expect(result.current.config.baseBranch).toBe('release'));
    firstRequest.resolve({ defaultBranch: 'main', branches: ['main'] });
    await waitFor(() => expect(result.current.config.baseBranch).toBe('release'));
  });

  it('preserves the current base branch when an edit-mode draft is temporarily unavailable', async () => {
    const pendingRequest = createDeferred<{ defaultBranch: string; branches: string[] }>();
    mockGetRepoBranches.mockReturnValueOnce(pendingRequest.promise);
    const { result, rerender } = renderHook(({ draft }) => {
      const [config, setConfig] = useState<PlannerConfig>({ ...baseConfig, baseBranch: 'develop' });
      const state = useRepoInfoLoader(false, draft as never, setConfig);
      return { config, state };
    }, { initialProps: { draft: makeDraft() } });

    await waitFor(() => expect(result.current.state.isLoading).toBe(true));
    rerender({ draft: undefined });
    await waitFor(() => expect(result.current.state).toEqual({ isLoading: false, error: null }));
    expect(result.current.config.baseBranch).toBe('develop');

    pendingRequest.resolve({ defaultBranch: 'main', branches: ['main'] });
    await waitFor(() => expect(result.current.config.baseBranch).toBe('develop'));
  });

  it('resets loading and error state when repo info resolution becomes disabled', async () => {
    const pendingRequest = createDeferred<{ defaultBranch: string; branches: string[] }>();
    mockGetRepoBranches.mockReturnValueOnce(pendingRequest.promise);
    const { result, rerender } = renderHook(({ isNewMode, draft }) => {
      const [config, setConfig] = useState<PlannerConfig>({ ...baseConfig, baseBranch: 'develop' });
      const state = useRepoInfoLoader(isNewMode, draft as never, setConfig);
      return { config, state };
    }, { initialProps: { isNewMode: false, draft: makeDraft() } });

    await waitFor(() => expect(result.current.state.isLoading).toBe(true));
    rerender({ isNewMode: true, draft: makeDraft() });
    await waitFor(() => expect(result.current.state).toEqual({ isLoading: false, error: null }));
    expect(result.current.config.baseBranch).toBe('');

    pendingRequest.resolve({ defaultBranch: 'main', branches: ['main'] });
    await waitFor(() => expect(result.current.state).toEqual({ isLoading: false, error: null }));
    expect(result.current.config.baseBranch).toBe('');
  });

  it.each([
    ['persists the resolved baseBranch when creating a draft before generation starts', undefined, undefined],
    ['continues generation when persisting the resolved baseBranch fails after draft creation', new Error('Transient update failure'), expect.stringContaining('failed to save base branch "develop"')],
  ])('%s', async (_, updateError, expectedWarning) => {
    mockCreateDraft.mockResolvedValue(makeDraft());
    if (updateError) mockUpdateDraft.mockRejectedValue(updateError);
    const navigate = vi.fn();
    const setError = vi.fn();
    const setIsCreating = vi.fn();
    const { result } = renderHook(() => useDraftCreation({ selectedRepo: 'integry/propr', config: { ...baseConfig, prompt: 'Test prompt', baseBranch: 'develop' }, localFiles: [], navigate, setError, setIsCreating }));
    await result.current();
    expect(mockGeneratePlan).toHaveBeenCalledWith('draft-1', expect.objectContaining({ baseBranch: 'develop' }));
    expect(mockUpdateDraft).toHaveBeenCalledWith('draft-1', expect.objectContaining({ context_config: { baseBranch: 'develop' } }));
    if (expectedWarning) {
      expect(navigate).toHaveBeenCalledWith('/studio/draft-1', expect.objectContaining({ replace: true, state: expect.objectContaining({ initialBaseBranch: 'develop', baseBranchPersistenceWarning: expectedWarning }) }));
      expect(setError).not.toHaveBeenCalledWith('Transient update failure');
    }
  });

  it.each([
    ['persists only the explicitly selected repo-entry branch for repository restoration', { config: { ...baseConfig, baseBranch: 'main' }, draftRepository: undefined, draftBaseBranch: undefined, selectedRepo: 'integry/propr', selectedBaseBranch: '' }, { lastRepository: 'integry/propr', lastBaseBranch: null }, { lastRepository: 'integry/propr', lastBaseBranch: 'main' }],
    ['persists the draft repository branch together with the draft repository in edit mode', { config: { ...baseConfig, baseBranch: 'release' }, draftRepository: 'integry/propr', draftBaseBranch: 'develop', selectedRepo: 'integry/other', selectedBaseBranch: 'release' }, { lastRepository: 'integry/propr', lastBaseBranch: 'develop' }, { lastRepository: 'integry/propr', lastBaseBranch: 'release' }],
  ])('%s', (_, props, expectedSaved, unexpectedSaved) => {
    renderHook(() => usePlannerSettingsPersistence(props.config, props.draftRepository, props.draftBaseBranch, props.selectedRepo, props.selectedBaseBranch));
    expect(mockSavePlannerSettings).toHaveBeenCalledWith(expectedSaved);
    expect(mockSavePlannerSettings).not.toHaveBeenCalledWith(unexpectedSaved);
  });

  it('clears stale draft context state when a replacement draft omits optional context config values', async () => {
    const replacementDraft = makeDraft({ draft_id: 'draft-2', initial_prompt: 'Replacement prompt', attachments: [{ id: 'attachment-2', filename: 'new.txt' } as never], context_config: { baseBranch: 'release', contextRepositories: [], generationModel: null, manualFiles: [], excludedFiles: [] } });
    const { result } = renderHook(() => {
      const [config, setConfig] = useState<PlannerConfig>({ ...baseConfig, prompt: 'Stale prompt', baseBranch: 'main', files: [{ id: 'attachment-1', filename: 'old.txt' } as never], contextRepositories: [{ repository: 'integry/other', branch: 'main' }], generationModel: 'gpt-5.4', manualFiles: ['src/a.ts'], excludedFiles: ['src/b.ts'] });
      useDraftContextConfigSync(replacementDraft as never, setConfig);
      return config;
    });
    await waitFor(() => expect(result.current).toMatchObject({ prompt: 'Replacement prompt', baseBranch: 'release', files: [{ id: 'attachment-2', filename: 'new.txt' }], contextRepositories: [], generationModel: null, manualFiles: [], excludedFiles: [] }));
  });

  it('does not overwrite local edits when the same draft rerenders with stale server values', async () => {
    const sameDraft = makeDraft({ initial_prompt: 'Server prompt', context_config: { baseBranch: 'main', granularity: 'balanced', contextLevel: 50, compress: false, contextRepositories: [], generationModel: null, manualFiles: [], excludedFiles: [] } });
    const { result, rerender } = renderHook(({ draft }) => {
      const [config, setConfig] = useState<PlannerConfig>({ ...baseConfig, prompt: 'Local edit', baseBranch: 'release', generationModel: 'codex:gpt-5.4' });
      useDraftContextConfigSync(draft as never, setConfig);
      return config;
    }, { initialProps: { draft: sameDraft } });
    rerender({ draft: { ...sameDraft } });
    await waitFor(() => expect(result.current).toMatchObject({ prompt: 'Local edit', baseBranch: 'release', generationModel: 'codex:gpt-5.4' }));
  });

  it('persists editable draft settings to context_config after debounce', async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useDraftSettingsPersistence('draft-1', { ...baseConfig, baseBranch: 'develop', granularity: 'granular', contextLevel: 80, compress: true, contextRepositories: [{ repository: 'integry/other', branch: 'main' }], generationModel: 'codex:gpt-5.4', manualFiles: ['src/a.ts'], excludedFiles: ['src/b.ts'] }, makeDraft({ context_config: { baseBranch: 'main', granularity: 'balanced', contextLevel: 50, compress: false, contextRepositories: [], generationModel: null, manualFiles: [], excludedFiles: [] } }) as never));
      await vi.advanceTimersByTimeAsync(1_100);
      expect(mockUpdateDraft).toHaveBeenCalledWith('draft-1', expect.objectContaining({ context_config: { baseBranch: 'develop', granularity: 'granular', contextLevel: 80, compress: true, contextRepositories: [{ repository: 'integry/other', branch: 'main' }], generationModel: 'codex:gpt-5.4', manualFiles: ['src/a.ts'], excludedFiles: ['src/b.ts'] } }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not persist a stale prompt when the mounted wizard switches to a different draft', async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = renderHook(({ draftId, prompt, initialPrompt }) => usePromptPersistence(draftId, prompt, initialPrompt), { initialProps: { draftId: 'draft-1', prompt: 'Edited prompt', initialPrompt: 'Original prompt' } });
      rerender({ draftId: 'draft-2', prompt: 'Edited prompt', initialPrompt: 'Replacement prompt' });
      await vi.advanceTimersByTimeAsync(1_100);
      expect(mockUpdateDraft).not.toHaveBeenCalled();
      rerender({ draftId: 'draft-2', prompt: 'Replacement prompt', initialPrompt: 'Replacement prompt' });
      await vi.advanceTimersByTimeAsync(1_100);
      expect(mockUpdateDraft).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('computeIsGenerateDisabled', () => {
  it.each([
    ['blocks new-mode generation until the branch is resolved', { isNewMode: true, isCreating: false, selectedRepo: 'integry/propr', promptTrimmed: 'Test prompt', reposLoading: false, isGenerating: false, branchError: null, repoInfoLoading: true, repoError: null, baseBranch: '' }],
    ['blocks generation when repository branch lookup fails', { isNewMode: false, isCreating: false, selectedRepo: 'integry/propr', promptTrimmed: 'Test prompt', reposLoading: false, isGenerating: false, branchError: null, repoInfoLoading: false, repoError: 'GitHub unavailable', baseBranch: '' }],
    ['blocks edit-mode generation while a replacement draft is being created', { isNewMode: false, isCreating: true, selectedRepo: 'integry/propr', promptTrimmed: 'Test prompt', reposLoading: false, isGenerating: false, branchError: null, repoInfoLoading: false, repoError: null, baseBranch: 'main' }],
  ])('%s', (_, params) => {
    expect(computeIsGenerateDisabled(params)).toBe(true);
  });
});
