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
    vi.setSystemTime(new Date('2026-05-05T00:00:00Z'));
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

  it('does not poll while connected socket updates keep arriving', async () => {
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
          step: 'context',
          status: 'in_progress',
          timestamp: '2026-05-05T00:00:03Z',
          draftStatus: 'generating',
          generationTrace: {
            steps: [
              { name: 'relevance', status: 'completed' },
              { name: 'context', status: 'in_progress' },
              { name: 'llm', status: 'pending' },
            ],
          },
        }))
      );
    });

    act(() => {
      vi.advanceTimersByTime(9_000);
    });

    await act(async () => {
      await Promise.all(
        [...draftUpdateListeners].map(listener => listener({
          eventType: 'draft:update',
          draftId: 'draft-1',
          step: 'context',
          status: 'completed',
          timestamp: '2026-05-05T00:00:12Z',
          draftStatus: 'generating',
          generationTrace: {
            steps: [
              { name: 'relevance', status: 'completed' },
              { name: 'context', status: 'completed' },
              { name: 'llm', status: 'in_progress' },
            ],
          },
        }))
      );
    });

    act(() => {
      vi.advanceTimersByTime(9_000);
    });

    expect(mockGetDraft).not.toHaveBeenCalled();
  });

  it('resyncs over HTTP after connected socket inactivity', async () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => useGenerationPolling({ draftId: 'draft-1', onComplete }));

    act(() => {
      result.current.startPolling();
    });

    act(() => {
      vi.advanceTimersByTime(14_000);
    });

    expect(mockGetDraft).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
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

  it('falls back to HTTP polling when the socket is disconnected', async () => {
    socketState.isConnected = false;

    const onComplete = vi.fn();
    const { result } = renderHook(() => useGenerationPolling({ draftId: 'draft-1', onComplete }));

    act(() => {
      result.current.startPolling();
      vi.advanceTimersByTime(1_000);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockGetDraft).toHaveBeenCalledTimes(1);
  });

  it('resyncs once on socket reconnection after a disconnected gap', async () => {
    mockGetDraft
      .mockResolvedValueOnce({
        draft_id: 'draft-1',
        repository: 'integry/propr',
        initial_prompt: 'Test prompt',
        status: 'generating',
        attachments: [],
        created_at: '2026-05-05T00:00:00Z',
        generation_trace: {
          steps: [
            { name: 'relevance', status: 'completed' },
            { name: 'context', status: 'in_progress' },
            { name: 'llm', status: 'pending' },
          ],
        },
      })
      .mockResolvedValueOnce({
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
    const { result, rerender } = renderHook(() => useGenerationPolling({ draftId: 'draft-1', onComplete }));

    act(() => {
      result.current.startPolling();
    });

    act(() => {
      socketState.isConnected = false;
      rerender();
    });

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });

    expect(mockGetDraft).toHaveBeenCalledTimes(1);
    expect(result.current.isGenerating).toBe(true);

    act(() => {
      socketState.isConnected = true;
      rerender();
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockGetDraft).toHaveBeenCalledTimes(2);
    expect(result.current.isGenerating).toBe(false);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('clears a previous generation error when a new run starts', async () => {
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

    expect(result.current.generationError).toBe('Plan generation failed');

    act(() => {
      result.current.startPolling();
    });

    expect(result.current.generationError).toBeNull();
  });

  it('ignores failed socket events from before the current run started', async () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => useGenerationPolling({ draftId: 'draft-1', onComplete }));

    vi.setSystemTime(new Date('2026-05-05T00:01:00Z'));

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
              { name: 'context', status: 'completed' },
              { name: 'llm', status: 'failed' },
            ],
            error: 'Old Codex failure',
          },
        }))
      );
    });

    expect(result.current.generationError).toBeNull();
    expect(result.current.isGenerating).toBe(true);
  });

  it('clears stale trace errors when polling finds a completed draft', async () => {
    const onComplete = vi.fn();
    socketState.isConnected = false;
    mockGetDraft.mockResolvedValueOnce({
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
        error: 'Old Codex failure',
      },
    });
    const { result } = renderHook(() => useGenerationPolling({ draftId: 'draft-1', onComplete }));

    act(() => {
      result.current.setGenerationError('Old Codex failure');
      result.current.startPolling();
    });

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    expect(result.current.generationError).toBeNull();
    expect(result.current.isGenerating).toBe(false);
    expect(onComplete).toHaveBeenCalled();
  });
});
