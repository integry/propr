import { act, renderHook, waitFor } from '@testing-library/react';
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

describe('useAutoDraftCreation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockUpdateDraft).toHaveBeenCalledWith(
        'draft-1',
        expect.objectContaining({ context_config: { baseBranch: 'develop' } })
      );
    });
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

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    await waitFor(() => {
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

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

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

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockCreateDraft).toHaveBeenCalledTimes(1);
    });

    rerender({ resolvedBaseBranch: 'develop' });

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockCreateDraft).toHaveBeenCalledTimes(2);
    });
  });
});
