import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useGenerationPolling } from './useGenerationPolling';
import { getDraft } from '../api/proprApi';
import type { DraftUpdatePayload } from '@propr/shared';

const draftUpdateListeners = new Set<(payload: DraftUpdatePayload) => void | Promise<void>>();
const socketState = {
  isConnected: true,
  subscribeToDraft: vi.fn(),
  unsubscribeFromDraft: vi.fn(),
  onDraftUpdate: vi.fn((callback: (payload: DraftUpdatePayload) => void | Promise<void>) => {
    draftUpdateListeners.add(callback);
    return () => {
      draftUpdateListeners.delete(callback);
    };
  }),
};

vi.mock('../api/proprApi', () => ({
  getDraft: vi.fn(),
}));

vi.mock('../contexts/useSocket', () => ({
  useSocket: () => socketState,
}));

const mockGetDraft = vi.mocked(getDraft);

describe('useGenerationPolling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    draftUpdateListeners.clear();
    socketState.isConnected = true;
    mockGetDraft.mockResolvedValue({
      draft_id: 'draft-1',
      repository: 'integry/propr',
      initial_prompt: 'Test prompt',
      status: 'generating',
      attachments: [],
      created_at: '2026-05-05T00:00:00Z',
      generation_trace: {
        steps: [
          { name: 'relevance', status: 'in_progress' },
          { name: 'context', status: 'pending' },
          { name: 'llm', status: 'pending' },
        ],
      },
    });
    socketState.onDraftUpdate.mockImplementation((callback: (payload: DraftUpdatePayload) => void | Promise<void>) => {
      draftUpdateListeners.add(callback);
      return () => {
        draftUpdateListeners.delete(callback);
      };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps connected-state resync polling infrequent', () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => useGenerationPolling({ draftId: 'draft-1', onComplete }));

    act(() => {
      result.current.startPolling();
    });

    act(() => {
      vi.advanceTimersByTime(9_999);
    });

    expect(mockGetDraft).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(mockGetDraft).toHaveBeenCalledTimes(1);
  });

  it('stops generating immediately on terminal socket events', async () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => useGenerationPolling({ draftId: 'draft-1', onComplete }));

    act(() => {
      result.current.startPolling();
    });

    await act(async () => {
      await Promise.all(
        [...draftUpdateListeners].map(listener => listener({
          eventType: 'draft:update',
          draftId: 'draft-1',
          step: 'complete',
          status: 'completed',
          timestamp: '2026-05-05T00:00:10Z',
          draftStatus: 'review',
          generationTrace: {
            steps: [
              { name: 'relevance', status: 'completed' },
              { name: 'context', status: 'completed' },
              { name: 'llm', status: 'completed' },
            ],
          },
        }))
      );
    });

    expect(result.current.isGenerating).toBe(false);
    expect(onComplete).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(20_000);
    });

    expect(mockGetDraft).not.toHaveBeenCalled();
  });

  it('captures failure from a terminal socket event without waiting for HTTP resync', async () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => useGenerationPolling({ draftId: 'draft-1', onComplete }));

    act(() => {
      result.current.startPolling();
    });

    await act(async () => {
      await Promise.all(
        [...draftUpdateListeners].map(listener => listener({
          eventType: 'draft:update',
          draftId: 'draft-1',
          step: 'complete',
          status: 'failed',
          timestamp: '2026-05-05T00:00:10Z',
          draftStatus: 'failed',
          generationTrace: {
            steps: [
              { name: 'relevance', status: 'completed' },
              { name: 'context', status: 'failed' },
              { name: 'llm', status: 'pending' },
            ],
            error: 'Plan generation failed',
          },
        }))
      );
    });

    expect(result.current.isGenerating).toBe(false);
    expect(result.current.generationError).toBe('Plan generation failed');
    expect(onComplete).not.toHaveBeenCalled();
    expect(mockGetDraft).not.toHaveBeenCalled();
  });

  it('recovers with a connected safety-net poll when a terminal socket event is missed', async () => {
    mockGetDraft.mockResolvedValue({
      draft_id: 'draft-1',
      repository: 'integry/propr',
      initial_prompt: 'Test prompt',
      status: 'review',
      attachments: [],
      created_at: '2026-05-05T00:00:00Z',
      generation_trace: {
        steps: [
          { name: 'relevance', status: 'completed' },
          { name: 'context', status: 'completed' },
          { name: 'llm', status: 'completed' },
        ],
      },
    });

    const onComplete = vi.fn();
    const { result } = renderHook(() => useGenerationPolling({ draftId: 'draft-1', onComplete }));

    act(() => {
      result.current.startPolling();
      vi.advanceTimersByTime(10_000);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockGetDraft).toHaveBeenCalledTimes(1);
    expect(result.current.isGenerating).toBe(false);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
