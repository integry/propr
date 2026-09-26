import { useState } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useDraftContextConfigSync,
  useDraftSettingsPersistence,
  useGenerationHandlers,
  usePromptPersistence,
  type PlannerConfig,
} from './setupWizardHooks';
import { generatePlan, updateDraft, type PlannerDraft } from '../../api/proprApi';
import { baseConfig, createDeferred, makeDraft } from './setupWizardHooks.testUtils';

vi.mock('../../api/proprApi', () => ({
  uploadAttachment: vi.fn(),
  removeAttachment: vi.fn(),
  abortGeneration: vi.fn(),
  getInstanceCatalog: vi.fn(),
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
const mockGeneratePlan = vi.mocked(generatePlan);

describe('setupWizardHooks persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves prompt edits made while an in-place draft is being created', async () => {
    type HookProps = { draft: PlannerDraft | undefined };
    const staleCreatedDraft = makeDraft({
      draft_id: 'draft-2',
      initial_prompt: 'Prompt captured when creation started',
      context_config: { baseBranch: 'release' },
    });
    const { result, rerender } = renderHook(({ draft }: HookProps) => {
      const [config, setConfig] = useState<PlannerConfig>({
        ...baseConfig,
        prompt: 'Prompt including everything typed while creation was pending',
      });
      useDraftContextConfigSync(draft, setConfig, true);
      return config;
    }, { initialProps: { draft: undefined } as HookProps });

    rerender({ draft: staleCreatedDraft });

    await waitFor(() => {
      expect(result.current.prompt).toBe('Prompt including everything typed while creation was pending');
      expect(result.current.baseBranch).toBe('release');
    });
  });

  it('persists the preserved prompt when the in-place draft id arrives', async () => {
    vi.useFakeTimers();
    try {
      type HookProps = { draftId: string | undefined; initialPrompt: string | undefined };
      const prompt = 'Prompt including later input';
      const { rerender } = renderHook(
        ({ draftId, initialPrompt }: HookProps) => {
          usePromptPersistence(draftId, prompt, initialPrompt, true);
        },
        { initialProps: { draftId: undefined, initialPrompt: undefined } as HookProps }
      );

      rerender({
        draftId: 'draft-2',
        initialPrompt: 'Prompt captured when creation started',
      });
      await vi.advanceTimersByTimeAsync(1_100);

      expect(mockUpdateDraft).toHaveBeenCalledWith('draft-2', {
        initial_prompt: prompt,
        name: prompt,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the derived name to onPersisted after each successful save', async () => {
    vi.useFakeTimers();
    try {
      const onPersisted = vi.fn();
      renderHook(() =>
        usePromptPersistence('draft-1', 'Add dark mode toggle to settings. Keep it simple. Ignore this sentence.', 'Add', false, onPersisted)
      );

      await vi.advanceTimersByTimeAsync(1_100);

      expect(mockUpdateDraft).toHaveBeenCalledWith('draft-1', {
        initial_prompt: 'Add dark mode toggle to settings. Keep it simple. Ignore this sentence.',
        name: 'Add dark mode toggle to settings. Keep it simple.',
      });
      expect(onPersisted).toHaveBeenCalledWith({
        draftId: 'draft-1',
        initial_prompt: 'Add dark mode toggle to settings. Keep it simple. Ignore this sentence.',
        name: 'Add dark mode toggle to settings. Keep it simple.',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the derived name to onPersisted when the prompt is flushed before generation', async () => {
    const onPersisted = vi.fn();
    const { result } = renderHook(() =>
      usePromptPersistence('draft-1', 'Add', 'Add', false, onPersisted)
    );

    await act(async () => {
      await result.current.flushPrompt('draft-1', 'Add dark mode toggle to settings.');
    });

    expect(onPersisted).toHaveBeenCalledWith({
      draftId: 'draft-1',
      initial_prompt: 'Add dark mode toggle to settings.',
      name: 'Add dark mode toggle to settings.',
    });
  });

  it('waits for an in-flight autosave and cancels the queued debounce before saving the final prompt', async () => {
    vi.useFakeTimers();
    try {
      const olderAutosave = createDeferred<void>();
      mockGeneratePlan.mockResolvedValue({ success: true, status: 'generating', message: 'Plan generation started', runId: 'generation-run-1' });
      mockUpdateDraft.mockImplementationOnce(() => olderAutosave.promise);
      const draft = makeDraft({ initial_prompt: 'Original prompt' }) as never;
      const { result, rerender } = renderHook(({ prompt }: { prompt: string }) => {
        const { flushPrompt } = usePromptPersistence('draft-1', prompt, 'Original prompt');
        return useGenerationHandlers({
          draft,
          config: { ...baseConfig, prompt },
          branchError: null,
          flushPrompt,
          contextHelpers: { isContextStale: false, clearCountdown: vi.fn(), fetchPreview: vi.fn() },
          startPolling: vi.fn(),
          stopPolling: vi.fn(),
          setError: vi.fn(),
          setGenerationError: vi.fn(),
        });
      }, { initialProps: { prompt: 'Older prompt' } });

      await vi.advanceTimersByTimeAsync(1_100);
      expect(mockUpdateDraft).toHaveBeenCalledTimes(1);
      expect(mockUpdateDraft).toHaveBeenLastCalledWith('draft-1', { initial_prompt: 'Older prompt', name: 'Older prompt' });

      rerender({ prompt: 'Latest prompt' });
      let generation!: Promise<void>;
      act(() => {
        generation = result.current.handleGenerateForExistingDraft();
      });
      await act(async () => Promise.resolve());
      expect(mockUpdateDraft).toHaveBeenCalledTimes(1);
      expect(mockGeneratePlan).not.toHaveBeenCalled();

      olderAutosave.resolve();
      await act(async () => generation);
      await vi.advanceTimersByTimeAsync(1_100);

      expect(mockUpdateDraft).toHaveBeenCalledTimes(2);
      expect(mockUpdateDraft).toHaveBeenLastCalledWith('draft-1', { initial_prompt: 'Latest prompt', name: 'Latest prompt' });
      expect(mockGeneratePlan).toHaveBeenCalledOnce();
      expect(mockUpdateDraft.mock.invocationCallOrder[1]).toBeLessThan(mockGeneratePlan.mock.invocationCallOrder[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves same-draft setup after a full replacement snapshot rerenders as sparse server data', async () => {
    const initialDraft = makeDraft({
      draft_id: 'draft-2',
      initial_prompt: 'Replacement prompt',
      attachments: [{ id: 'attachment-2', filename: 'new.txt' } as never],
      context_config: {
        baseBranch: 'release',
        granularity: 'granular',
        contextLevel: 80,
        compress: true,
        contextRepositories: [{ repository: 'integry/other', branch: 'main' }],
        generationModel: 'gpt-5.4',
        manualFiles: ['src/a.ts'],
        excludedFiles: ['src/b.ts'],
      },
    });
    const sparseServerDraft = makeDraft({
      draft_id: 'draft-2',
      initial_prompt: 'Replacement prompt',
      attachments: [{ id: 'attachment-2', filename: 'new.txt' } as never],
      context_config: { baseBranch: 'release' },
    });

    const { result, rerender } = renderHook(({ draft }) => {
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

      useDraftContextConfigSync(draft as never, setConfig);
      return config;
    }, { initialProps: { draft: initialDraft } });

    rerender({ draft: sparseServerDraft });

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

  it('resets missing settings when switching to an unrelated sparse draft', async () => {
    const draft = makeDraft({
      draft_id: 'draft-2',
      initial_prompt: 'Existing prompt',
      attachments: [{ id: 'attachment-2', filename: 'existing.txt' } as never],
      context_config: { baseBranch: 'release' },
    });

    const { result } = renderHook(() => {
      const [config, setConfig] = useState<PlannerConfig>({
        ...baseConfig,
        prompt: 'Leaked prompt',
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

      useDraftContextConfigSync(draft as never, setConfig);
      return config;
    });

    await waitFor(() => {
      expect(result.current.prompt).toBe('Existing prompt');
      expect(result.current.baseBranch).toBe('release');
      expect(result.current.granularity).toBe('balanced');
      expect(result.current.contextLevel).toBe(50);
      expect(result.current.compress).toBe(false);
      expect(result.current.files).toEqual([{ id: 'attachment-2', filename: 'existing.txt' }]);
      expect(result.current.contextRepositories).toEqual([]);
      expect(result.current.generationModel).toBe(null);
      expect(result.current.manualFiles).toEqual([]);
      expect(result.current.excludedFiles).toEqual([]);
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
        });
        useDraftContextConfigSync(draft as never, setConfig);
        return { config, setConfig };
      },
      { initialProps: { draft: sameDraft } }
    );

    await waitFor(() => {
      expect(result.current.config.prompt).toBe('Server prompt');
      expect(result.current.config.baseBranch).toBe('main');
    });

    act(() => {
      result.current.setConfig(prev => ({
        ...prev,
        prompt: 'Local edit',
        baseBranch: 'release',
        generationModel: 'codex:gpt-5.4',
      }));
    });

    rerender({ draft: { ...sameDraft } });

    await waitFor(() => {
      expect(result.current.config.prompt).toBe('Local edit');
      expect(result.current.config.baseBranch).toBe('release');
      expect(result.current.config.generationModel).toBe('codex:gpt-5.4');
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
