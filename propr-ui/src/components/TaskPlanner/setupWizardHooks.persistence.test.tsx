import React, { useState } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useDraftContextConfigSync,
  useDraftSettingsPersistence,
  usePromptPersistence,
  type PlannerConfig,
} from './setupWizardHooks';
import { updateDraft } from '../../api/proprApi';
import { baseConfig, makeDraft } from './setupWizardHooks.testUtils';

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

const mockUpdateDraft = vi.mocked(updateDraft);

describe('setupWizardHooks persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates only the fields present in sparse draft context data', async () => {
    const replacementDraft = makeDraft({
      draft_id: 'draft-2',
      initial_prompt: 'Replacement prompt',
      attachments: [{ id: 'attachment-2', filename: 'new.txt' } as never],
      context_config: { baseBranch: 'release' },
    });

    const { result } = renderHook(() => {
      const [config, setConfig] = useState<PlannerConfig>({
        ...baseConfig,
        prompt: 'Stale prompt',
        baseBranch: 'main',
        granularity: 'granular',
        contextLevel: 80,
        compress: true,
        files: [{ id: 'attachment-1', filename: 'old.txt' } as never],
        contextRepositories: [{ repository: 'integry/other', branch: 'main' }],
        generationModel: 'gpt-5.4',
        manualFiles: ['src/a.ts'],
        excludedFiles: ['src/b.ts'],
      });

      useDraftContextConfigSync(replacementDraft as never, setConfig);
      return config;
    });

    await waitFor(() => {
      expect(result.current.prompt).toBe('Replacement prompt');
      expect(result.current.baseBranch).toBe('release');
      expect(result.current.granularity).toBe('granular');
      expect(result.current.contextLevel).toBe(80);
      expect(result.current.compress).toBe(true);
      expect(result.current.files).toEqual([{ id: 'attachment-2', filename: 'new.txt' }]);
      expect(result.current.contextRepositories).toEqual([{ repository: 'integry/other', branch: 'main' }]);
      expect(result.current.generationModel).toBe('gpt-5.4');
      expect(result.current.manualFiles).toEqual(['src/a.ts']);
      expect(result.current.excludedFiles).toEqual(['src/b.ts']);
    });
  });

  it('does not overwrite local edits when the same draft rerenders with stale server values', async () => {
    const sameDraft = makeDraft({
      initial_prompt: 'Server prompt',
      context_config: {
        baseBranch: 'main',
        granularity: 'balanced',
        contextLevel: 50,
        compress: false,
        contextRepositories: [],
        generationModel: null,
        manualFiles: [],
        excludedFiles: [],
      },
    });

    const { result, rerender } = renderHook(
      ({ draft }) => {
        const [config, setConfig] = useState<PlannerConfig>({
          ...baseConfig,
          prompt: 'Local edit',
          baseBranch: 'release',
          generationModel: 'codex:gpt-5.4',
        });
        useDraftContextConfigSync(draft as never, setConfig);
        return config;
      },
      { initialProps: { draft: sameDraft } }
    );

    rerender({ draft: { ...sameDraft } });

    await waitFor(() => {
      expect(result.current.prompt).toBe('Local edit');
      expect(result.current.baseBranch).toBe('release');
      expect(result.current.generationModel).toBe('codex:gpt-5.4');
    });
  });

  it('persists editable draft settings to context_config after debounce', async () => {
    vi.useFakeTimers();
    try {
      renderHook(() =>
        useDraftSettingsPersistence(
          'draft-1',
          {
            ...baseConfig,
            baseBranch: 'develop',
            granularity: 'granular',
            contextLevel: 80,
            compress: true,
            contextRepositories: [{ repository: 'integry/other', branch: 'main' }],
            generationModel: 'codex:gpt-5.4',
            manualFiles: ['src/a.ts'],
            excludedFiles: ['src/b.ts'],
          },
          makeDraft({
            context_config: {
              baseBranch: 'main',
              granularity: 'balanced',
              contextLevel: 50,
              compress: false,
              contextRepositories: [],
              generationModel: null,
              manualFiles: [],
              excludedFiles: [],
            },
          }) as never
        )
      );

      await vi.advanceTimersByTimeAsync(1_100);

      expect(mockUpdateDraft).toHaveBeenCalledWith(
        'draft-1',
        expect.objectContaining({
          context_config: {
            baseBranch: 'develop',
            granularity: 'granular',
            contextLevel: 80,
            compress: true,
            contextRepositories: [{ repository: 'integry/other', branch: 'main' }],
            generationModel: 'codex:gpt-5.4',
            manualFiles: ['src/a.ts'],
            excludedFiles: ['src/b.ts'],
          },
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not persist a stale prompt when the mounted wizard switches to a different draft', async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = renderHook(
        ({ draftId, prompt, initialPrompt }) => {
          usePromptPersistence(draftId, prompt, initialPrompt);
        },
        {
          initialProps: {
            draftId: 'draft-1',
            prompt: 'Edited prompt',
            initialPrompt: 'Original prompt',
          },
        }
      );

      rerender({
        draftId: 'draft-2',
        prompt: 'Edited prompt',
        initialPrompt: 'Replacement prompt',
      });

      await vi.advanceTimersByTimeAsync(1_100);
      expect(mockUpdateDraft).not.toHaveBeenCalled();

      rerender({
        draftId: 'draft-2',
        prompt: 'Replacement prompt',
        initialPrompt: 'Replacement prompt',
      });

      await vi.advanceTimersByTimeAsync(1_100);
      expect(mockUpdateDraft).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
