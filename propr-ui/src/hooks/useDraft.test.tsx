import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useDraft } from './useDraft';
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('useDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        ],
      },
    });
  });

  it('applies generation socket snapshots without refetching the draft', async () => {
    mockGetDraft.mockResolvedValueOnce({
      draft_id: 'draft-1',
      repository: 'integry/propr',
      initial_prompt: 'Test prompt',
      status: 'generating',
      attachments: [],
      created_at: '2026-05-05T00:00:00Z',
      generation_trace: {
        steps: [
          { name: 'relevance', status: 'in_progress', data: { includedFiles: ['src/a.ts'] } },
        ],
      },
    });

    const { result } = renderHook(() => useDraft('draft-1'));

    await waitFor(() => {
      expect(result.current.draft?.draft_id).toBe('draft-1');
    });

    expect(mockGetDraft).toHaveBeenCalledTimes(1);

    await act(async () => {
      await Promise.all(
        [...draftUpdateListeners].map(listener => listener({
          eventType: 'draft:update',
          draftId: 'draft-1',
          step: 'context',
          status: 'in_progress',
          timestamp: '2026-05-05T00:00:05Z',
          draftStatus: 'generating',
          generationTrace: {
            steps: [
              { name: 'relevance', status: 'completed' },
              { name: 'context', status: 'in_progress' },
            ],
          },
        }))
      );
    });

    expect(mockGetDraft).toHaveBeenCalledTimes(1);
    expect(result.current.draft?.generation_trace?.steps).toEqual([
      { name: 'relevance', status: 'completed', data: { includedFiles: ['src/a.ts'] } },
      { name: 'context', status: 'in_progress' },
    ]);
  });

  it('resyncs once when a socket event reports a terminal draft status', async () => {
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
            { name: 'relevance', status: 'in_progress' },
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

    renderHook(() => useDraft('draft-1'));

    await waitFor(() => {
      expect(draftUpdateListeners.size).toBeGreaterThan(0);
    });

    await act(async () => {
      await Promise.all(
        [...draftUpdateListeners].map(listener => listener({
          eventType: 'draft:update',
          draftId: 'draft-1',
          step: 'llm',
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

    await waitFor(() => {
      expect(mockGetDraft).toHaveBeenCalledTimes(2);
    });
  });

  it('applies terminal draft status from the socket before the follow-up fetch resolves', async () => {
    const deferredFetch = createDeferred<Awaited<ReturnType<typeof getDraft>>>();

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
            { name: 'relevance', status: 'in_progress' },
          ],
        },
      })
      .mockImplementationOnce(() => deferredFetch.promise);

    const { result } = renderHook(() => useDraft('draft-1'));

    await waitFor(() => {
      expect(result.current.draft?.status).toBe('generating');
    });

    // Dispatch the terminal socket event WITHOUT awaiting the listeners: the
    // handler's follow-up fetch is parked on deferredFetch, and awaiting here
    // would deadlock the act() against our own later resolve call.
    let dispatchDone: Promise<unknown> = Promise.resolve();
    act(() => {
      dispatchDone = Promise.all(
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

    expect(result.current.draft?.status).toBe('review');

    await act(async () => {
      deferredFetch.resolve({
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
      await deferredFetch.promise;
      await dispatchDone;
    });

    await waitFor(() => {
      expect(mockGetDraft).toHaveBeenCalledTimes(2);
    });
  });

  it('normalizes malformed attachments payloads to an empty array', async () => {
    mockGetDraft.mockResolvedValueOnce({
      draft_id: 'draft-1',
      repository: 'integry/propr',
      initial_prompt: 'Test prompt',
      status: 'draft',
      attachments: { id: 'bad-shape' },
      created_at: '2026-05-05T00:00:00Z',
      generation_trace: {
        steps: [],
      },
    } as never);

    const { result } = renderHook(() => useDraft('draft-1'));

    await waitFor(() => {
      expect(result.current.draft?.attachments).toEqual([]);
    });
  });
});
