import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDraft, previewContext } from '../api/proprApi';
import { useContextRefresh } from './useContextRefresh';

const socketState = vi.hoisted(() => ({
  listener: null as ((payload: Record<string, unknown>) => void) | null,
  subscribeToDraft: vi.fn(),
  unsubscribeFromDraft: vi.fn(),
  onDraftUpdate: vi.fn(),
}));

vi.mock('../api/proprApi', () => ({
  getDraft: vi.fn(),
  previewContext: vi.fn(),
}));

vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: true,
    subscribeToDraft: socketState.subscribeToDraft,
    unsubscribeFromDraft: socketState.unsubscribeFromDraft,
    onDraftUpdate: socketState.onDraftUpdate,
  }),
}));

const mockGetDraft = vi.mocked(getDraft);
const mockPreviewContext = vi.mocked(previewContext);

const config = {
  prompt: 'Build the feature',
  baseBranch: 'main',
  granularity: 'balanced' as const,
  contextLevel: 50,
  compress: false,
  files: [],
  generationModel: null,
  contextRepositories: [],
  manualFiles: [],
  excludedFiles: [],
};

const completedDraft = {
  draft_id: 'draft-1',
  repository: 'integry/propr',
  initial_prompt: config.prompt,
  status: 'draft' as const,
  attachments: [],
  created_at: '2026-08-01T10:00:00.000Z',
  context_config: {
    lastPreviewRequestId: 'preview-1',
    lastPreview: {
      success: true,
      stats: { totalTokens: 100, costEstimate: 0.01, contextLength: 400, fileCount: 2 },
      smartSelection: [],
      warnings: [],
    },
    contextCache: { fileTokenCounts: { 'src/index.ts': 100 } },
  },
};

describe('useContextRefresh', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    socketState.listener = null;
    socketState.onDraftUpdate.mockImplementation((listener) => {
      socketState.listener = listener;
      return () => {
        socketState.listener = null;
      };
    });
    mockPreviewContext.mockResolvedValue({
      pending: true,
      draftId: 'draft-1',
      previewRequestId: 'preview-1',
    });
    mockGetDraft.mockResolvedValue({ ...completedDraft, context_config: {} });
  });

  it('resolves fetchPreview only after the background preview is persisted', async () => {
    const { result } = renderHook(() => useContextRefresh({
      draftId: 'draft-1',
      config,
      onBranchError: vi.fn(),
    }));

    let previewFinished!: Promise<boolean>;
    act(() => {
      previewFinished = result.current.fetchPreview();
    });
    await act(async () => Promise.resolve());

    let settled = false;
    void previewFinished.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(result.current.preview.isLoading).toBe(true);

    mockGetDraft.mockResolvedValue(completedDraft);
    await act(async () => {
      socketState.listener?.({
        draftId: 'draft-1',
        step: 'context',
        status: 'completed',
        data: { previewRequestId: 'preview-1' },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    await expect(previewFinished).resolves.toBe(true);
    expect(result.current.preview.isLoading).toBe(false);
    expect(result.current.preview.data?.fileTokenCounts).toEqual({ 'src/index.ts': 100 });
  });
  describe('autoRefresh', () => {
    const onBranchError = vi.fn();

    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not start a countdown or auto-fetch when autoRefresh is disabled', async () => {
      vi.useFakeTimers();
      const { result, rerender } = renderHook(
        ({ prompt }: { prompt: string }) => useContextRefresh({
          draftId: 'draft-1',
          config: { ...config, prompt },
          onBranchError,
          autoRefresh: false,
        }),
        { initialProps: { prompt: config.prompt } }
      );

      expect(result.current.isContextStale).toBe(true);
      expect(result.current.timeUntilRefresh).toBeNull();

      rerender({ prompt: 'Build a completely different feature with new requirements' });
      await act(async () => {
        vi.advanceTimersByTime(30000);
      });

      expect(result.current.isContextStale).toBe(true);
      expect(result.current.timeUntilRefresh).toBeNull();
      expect(mockPreviewContext).not.toHaveBeenCalled();
    });

    it('defaults to autoRefresh disabled', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useContextRefresh({
        draftId: 'draft-1',
        config,
        onBranchError,
      }));

      await act(async () => {
        vi.advanceTimersByTime(30000);
      });

      expect(result.current.timeUntilRefresh).toBeNull();
      expect(mockPreviewContext).not.toHaveBeenCalled();
    });

    it('starts the countdown when autoRefresh is enabled', () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useContextRefresh({
        draftId: 'draft-1',
        config,
        onBranchError,
        autoRefresh: true,
      }));

      expect(result.current.isContextStale).toBe(true);
      expect(result.current.timeUntilRefresh).toBe(20);
    });

    it('fetches context on manual refresh when autoRefresh is disabled', async () => {
      const { result } = renderHook(() => useContextRefresh({
        draftId: 'draft-1',
        config,
        onBranchError,
        autoRefresh: false,
      }));

      act(() => {
        void result.current.handleManualRefresh();
      });
      await act(async () => Promise.resolve());

      expect(mockPreviewContext).toHaveBeenCalledTimes(1);
      expect(mockPreviewContext).toHaveBeenCalledWith(expect.objectContaining({ draftId: 'draft-1', prompt: config.prompt }), expect.anything());
      expect(result.current.isContextStale).toBe(false);
      expect(result.current.preview.isLoading).toBe(true);
    });

    it('uses the override draft ID when the draftId prop has not propagated yet', async () => {
      const { result } = renderHook(() => useContextRefresh({
        draftId: '',
        config,
        onBranchError,
      }));

      act(() => {
        void result.current.handleManualRefresh('draft-new');
      });
      await act(async () => Promise.resolve());

      expect(mockPreviewContext).toHaveBeenCalledWith(expect.objectContaining({ draftId: 'draft-new' }), expect.anything());
    });

    it('marks context stale again when the prompt changes after a completed preview', async () => {
      mockPreviewContext.mockResolvedValue(completedDraft.context_config.lastPreview);
      const { result, rerender } = renderHook(
        ({ prompt }: { prompt: string }) => useContextRefresh({
          draftId: 'draft-1',
          config: { ...config, prompt },
          onBranchError,
        }),
        { initialProps: { prompt: config.prompt } }
      );

      await act(async () => {
        await result.current.handleManualRefresh();
      });
      expect(result.current.isContextStale).toBe(false);
      expect(result.current.preview.data).not.toBeNull();

      rerender({ prompt: `${config.prompt} with tests` });

      expect(result.current.isContextStale).toBe(true);
      expect(result.current.timeUntilRefresh).toBeNull();
    });
  });
});
