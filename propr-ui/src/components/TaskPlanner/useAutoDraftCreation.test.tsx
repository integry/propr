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
      expect.objectContaining({ context_config: { baseBranch: 'develop' } })
    );
  });

  it('keeps navigating when persisting the resolved baseBranch fails after auto-creating a draft', async () => {
    const navigate = vi.fn();
    mockUpdateDraft.mockRejectedValue(new Error('Transient update failure'));

    renderHook(() => useAutoDraftCreation({
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
          baseBranchPersistenceWarning: expect.stringContaining('failed to save base branch "develop"')
        })
      })
    );
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

    const { result } = renderHook(() => useAutoDraftCreation({
      isNewMode: true,
      selectedRepo: 'integry/propr',
      resolvedBaseBranch: 'develop',
      prompt: 'Test prompt',
      localFiles: [],
      onDraftCreatedInPlace,
      navigate,
    }));

    expect(result.current.isAutoCreating).toBe(false);

    await flushAutoCreate();

    expect(onDraftCreatedInPlace).toHaveBeenCalledWith(expect.objectContaining({
      draft_id: 'draft-1',
      context_config: { baseBranch: 'develop' }
    }));

    expect(result.current.isAutoCreating).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
