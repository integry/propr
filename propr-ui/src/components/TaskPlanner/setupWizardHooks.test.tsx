import React, { useState } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBranchesLoader, useRepoInfoLoader, useDraftCreation, type PlannerConfig } from './setupWizardHooks';
import { getRepoBranches, createDraft, generatePlan, updateDraft } from '../../api/proprApi';

vi.mock('../../api/proprApi', () => ({
  uploadAttachment: vi.fn(),
  removeAttachment: vi.fn(),
  generatePlan: vi.fn(),
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
});
