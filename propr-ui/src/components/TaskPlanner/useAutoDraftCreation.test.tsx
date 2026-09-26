import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDraft, updateDraft, uploadAttachment } from '../../api/proprApi';
import { useAutoDraftCreation } from './useAutoDraftCreation';

vi.mock('../../api/proprApi', () => ({
  createDraft: vi.fn(),
  updateDraft: vi.fn(),
  uploadAttachment: vi.fn(),
}));

const mockCreateDraft = vi.mocked(createDraft);
const mockUpdateDraft = vi.mocked(updateDraft);
const mockUploadAttachment = vi.mocked(uploadAttachment);

async function flushAutoCreate() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
}

describe('useAutoDraftCreation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    mockCreateDraft.mockResolvedValue({
      draft_id: 'draft-1',
      repository: 'integry/propr',
      initial_prompt: 'Test prompt',
      status: 'draft',
      attachments: [],
      created_at: '2026-05-06T00:00:00Z',
    });
    mockUploadAttachment.mockResolvedValue({
      id: 'attachment-1',
      originalName: 'file.txt',
      tokenEstimate: 1,
    });
    mockUpdateDraft.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists the resolved baseBranch when auto-creating a draft', async () => {
    const navigate = vi.fn();

    renderHook(() => useAutoDraftCreation({
      isNewMode: true,
      selectedRepo: 'integry/propr',
      resolvedBaseBranch: 'develop',
      prompt: 'Test prompt',
      localFiles: [],
      navigate,
    }));

    await flushAutoCreate();

    expect(mockUpdateDraft).toHaveBeenCalledWith(
      'draft-1',
      expect.objectContaining({
        context_config: {
          baseBranch: 'develop',
        }
      })
    );
  });

  it('persists the full setup snapshot when auto-creating a draft', async () => {
    const navigate = vi.fn();
    const setupSnapshot = {
      baseBranch: 'develop',
      granularity: 'granular' as const,
      contextLevel: 80,
      compress: true,
      contextRepositories: [{ repository: 'integry/other', branch: 'main' }],
      generationModel: 'codex:gpt-5.4',
      manualFiles: ['src/a.ts'],
      excludedFiles: ['src/b.ts']
    };

    renderHook(() => useAutoDraftCreation({
      isNewMode: true,
      selectedRepo: 'integry/propr',
      resolvedBaseBranch: 'develop',
      setupSnapshot,
      prompt: 'Test prompt',
      localFiles: [],
      navigate,
    }));

    await flushAutoCreate();

    expect(mockUpdateDraft).toHaveBeenCalledWith(
      'draft-1',
      expect.objectContaining({ context_config: setupSnapshot })
    );
  });

  it('keeps navigating when persisting the resolved baseBranch fails after auto-creating a draft', async () => {
    const navigate = vi.fn();
    mockUpdateDraft.mockRejectedValue(new Error('Transient update failure'));

    const { result } = renderHook(() => useAutoDraftCreation({
      isNewMode: true,
      selectedRepo: 'integry/propr',
      resolvedBaseBranch: 'develop',
      prompt: 'Test prompt',
      localFiles: [],
      navigate,
    }));

    await flushAutoCreate();

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
    expect(result.current.autoCreateWarning).toBe(null);
  });

  it('clears the auto-creating state before navigation after successful auto-creation', async () => {
    const navigate = vi.fn();

    const { result } = renderHook(() => useAutoDraftCreation({
      isNewMode: true,
      selectedRepo: 'integry/propr',
      resolvedBaseBranch: 'develop',
      prompt: 'Test prompt',
      localFiles: [],
      navigate,
    }));

    await flushAutoCreate();

    expect(navigate).toHaveBeenCalled();
    expect(result.current.isAutoCreating).toBe(false);
  });

  it('waits for a resolved base branch before auto-creating a draft', async () => {
    const navigate = vi.fn();

    renderHook(() => useAutoDraftCreation({
      isNewMode: true,
      selectedRepo: 'integry/propr',
      resolvedBaseBranch: '',
      prompt: 'Test prompt',
      localFiles: [],
      navigate,
    }));

    await flushAutoCreate();

    expect(mockCreateDraft).not.toHaveBeenCalled();
  });

  it('resets auto-draft state when switching duplicate repo entries on another branch', async () => {
    const navigate = vi.fn();
    const { rerender } = renderHook(
      (props: { resolvedBaseBranch: string }) => useAutoDraftCreation({
        isNewMode: true,
        selectedRepo: 'integry/propr',
        resolvedBaseBranch: props.resolvedBaseBranch,
        prompt: 'Test prompt',
        localFiles: [],
        navigate,
      }),
      { initialProps: { resolvedBaseBranch: 'main' } }
    );

    await flushAutoCreate();

    expect(mockCreateDraft).toHaveBeenCalledTimes(1);

    rerender({ resolvedBaseBranch: 'develop' });

    await flushAutoCreate();

    expect(mockCreateDraft).toHaveBeenCalledTimes(2);
  });

  it('clears the auto-creating state after successful in-place draft creation', async () => {
    const navigate = vi.fn();
    const onDraftCreatedInPlace = vi.fn();
    const setupSnapshot = {
      baseBranch: 'develop',
      granularity: 'granular' as const,
      contextLevel: 80,
      compress: true,
      contextRepositories: [{ repository: 'integry/other', branch: 'main' }],
      generationModel: 'codex:gpt-5.4',
      manualFiles: ['src/a.ts'],
      excludedFiles: ['src/b.ts']
    };

    const { result } = renderHook(() => useAutoDraftCreation({
      isNewMode: true,
      selectedRepo: 'integry/propr',
      resolvedBaseBranch: 'develop',
      setupSnapshot,
      prompt: 'Test prompt',
      localFiles: [],
      onDraftCreatedInPlace,
      navigate,
    }));

    expect(result.current.isAutoCreating).toBe(false);

    await flushAutoCreate();

    expect(onDraftCreatedInPlace).toHaveBeenCalledWith(expect.objectContaining({
      draft_id: 'draft-1',
      context_config: setupSnapshot
    }));

    expect(result.current.isAutoCreating).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('hydrates navigated drafts with the full setup snapshot in router state', async () => {
    const navigate = vi.fn();
    const setupSnapshot = {
      baseBranch: 'develop',
      granularity: 'granular' as const,
      contextLevel: 80,
      compress: true,
      contextRepositories: [{ repository: 'integry/other', branch: 'main' }],
      generationModel: 'codex:gpt-5.4',
      manualFiles: ['src/a.ts'],
      excludedFiles: ['src/b.ts']
    };

    renderHook(() => useAutoDraftCreation({
      isNewMode: true,
      selectedRepo: 'integry/propr',
      resolvedBaseBranch: 'develop',
      setupSnapshot,
      prompt: 'Test prompt',
      localFiles: [],
      navigate,
    }));

    await flushAutoCreate();

    expect(navigate).toHaveBeenCalledWith(
      '/studio/draft-1',
      expect.objectContaining({
        replace: true,
        state: expect.objectContaining({
          initialDraft: expect.objectContaining({
            context_config: setupSnapshot
          })
        })
      })
    );
  });

  it('surfaces the persistence warning only for in-place auto-created drafts', async () => {
    const navigate = vi.fn();
    const onDraftCreatedInPlace = vi.fn();
    mockUpdateDraft.mockRejectedValue(new Error('Transient update failure'));

    const { result } = renderHook(() => useAutoDraftCreation({
      isNewMode: true,
      selectedRepo: 'integry/propr',
      resolvedBaseBranch: 'develop',
      prompt: 'Test prompt',
      localFiles: [],
      onDraftCreatedInPlace,
      navigate,
    }));

    await flushAutoCreate();

    expect(onDraftCreatedInPlace).toHaveBeenCalled();
    expect(result.current.autoCreateWarning).toContain('failed to save setup settings including base branch "develop"');
    expect(navigate).not.toHaveBeenCalled();
  });
  it('ensureDraftCreated skips the debounce and returns the persisted draft once', async () => {
    const onDraftCreatedInPlace = vi.fn();
    const { result } = renderHook(() => useAutoDraftCreation({
      isNewMode: true,
      selectedRepo: 'integry/propr',
      resolvedBaseBranch: 'develop',
      prompt: 'Test prompt',
      localFiles: [],
      onDraftCreatedInPlace,
      navigate: vi.fn(),
    }));

    let created: Awaited<ReturnType<typeof result.current.ensureDraftCreated>> = null;
    await act(async () => {
      const [first, second] = await Promise.all([result.current.ensureDraftCreated(), result.current.ensureDraftCreated()]);
      created = first;
      expect(second).toBe(first);
    });

    expect(created).toEqual(expect.objectContaining({ draft_id: 'draft-1' }));
    expect(onDraftCreatedInPlace).toHaveBeenCalledTimes(1);

    await flushAutoCreate();
    expect(mockCreateDraft).toHaveBeenCalledTimes(1);
    await act(async () => {
      await expect(result.current.ensureDraftCreated()).resolves.toEqual(expect.objectContaining({ draft_id: 'draft-1' }));
    });
    expect(mockCreateDraft).toHaveBeenCalledTimes(1);
  });

  it('does not reuse or apply a pending draft creation from a previous selection', async () => {
    const onDraftCreatedInPlace = vi.fn();
    let resolveFirstDraft: (draft: Awaited<ReturnType<typeof createDraft>>) => void = () => {};
    mockCreateDraft
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstDraft = resolve; }))
      .mockResolvedValueOnce({
        draft_id: 'draft-b',
        repository: 'integry/other',
        initial_prompt: 'Test prompt',
        status: 'draft',
        attachments: [],
        created_at: '2026-05-06T00:00:00Z',
      });

    const { result, rerender } = renderHook((props: { selectedRepo: string }) => useAutoDraftCreation({
      isNewMode: true,
      selectedRepo: props.selectedRepo,
      resolvedBaseBranch: 'main',
      prompt: 'Test prompt',
      localFiles: [],
      onDraftCreatedInPlace,
      navigate: vi.fn(),
    }), { initialProps: { selectedRepo: 'integry/propr' } });

    await flushAutoCreate();
    expect(mockCreateDraft).toHaveBeenCalledWith('integry/propr', 'Test prompt', expect.anything());

    rerender({ selectedRepo: 'integry/other' });

    let created: Awaited<ReturnType<typeof result.current.ensureDraftCreated>> = null;
    await act(async () => {
      created = await result.current.ensureDraftCreated();
    });
    expect(created).toEqual(expect.objectContaining({ draft_id: 'draft-b' }));
    expect(mockCreateDraft).toHaveBeenLastCalledWith('integry/other', 'Test prompt', expect.anything());

    await act(async () => {
      resolveFirstDraft({
        draft_id: 'draft-a',
        repository: 'integry/propr',
        initial_prompt: 'Test prompt',
        status: 'draft',
        attachments: [],
        created_at: '2026-05-06T00:00:00Z',
      });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(onDraftCreatedInPlace).toHaveBeenCalledTimes(1);
    expect(onDraftCreatedInPlace).toHaveBeenCalledWith(expect.objectContaining({ draft_id: 'draft-b' }));
    await act(async () => {
      await expect(result.current.ensureDraftCreated()).resolves.toEqual(expect.objectContaining({ draft_id: 'draft-b' }));
    });
    expect(mockCreateDraft).toHaveBeenCalledTimes(2);
  });
});
