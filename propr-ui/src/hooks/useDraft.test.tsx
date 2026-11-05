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

  it('does not apply a socket snapshot from a replaced generation run', async () => {
    mockGetDraft.mockResolvedValueOnce({
      draft_id: 'draft-1',
      repository: 'integry/propr',
      initial_prompt: 'Test prompt',
      status: 'generating',
      attachments: [],
      created_at: '2026-05-05T00:00:00Z',
      generation_trace: {
        runId: 'generation-run-2',
        steps: [{ name: 'context', status: 'in_progress' }],
      },
    });
    const { result } = renderHook(() => useDraft('draft-1'));

    await waitFor(() => expect(result.current.draft?.generation_trace?.runId).toBe('generation-run-2'));
    await act(async () => {
      await Promise.all([...draftUpdateListeners].map(listener => listener({
        eventType: 'draft:update',
        draftId: 'draft-1',
        runId: 'generation-run-1',
        step: 'complete',
        status: 'failed',
        timestamp: '2026-05-05T00:00:10Z',
        draftStatus: 'failed',
        generationTrace: {
          runId: 'generation-run-1',
          steps: [{ name: 'context', status: 'failed' }],
          error: 'stale failure',
        },
      })));
    });

    expect(result.current.draft?.status).toBe('generating');
    expect(result.current.draft?.generation_trace?.runId).toBe('generation-run-2');
    expect(mockGetDraft).toHaveBeenCalledTimes(1);
  });

  it('installs the next run ID before accepting its first socket snapshot', async () => {
    const initialDraft = {
      draft_id: 'draft-1',
      repository: 'integry/propr',
      initial_prompt: 'Test prompt',
      status: 'failed',
      attachments: [],
      created_at: '2026-05-05T00:00:00Z',
      generation_trace: {
        runId: 'generation-run-1',
        steps: [{ name: 'llm', status: 'failed' as const }],
        error: 'Previous run failed',
      },
    };
    const { result } = renderHook(() => useDraft('draft-1', { initialData: initialDraft as never }));

    act(() => result.current.activateGenerationRun('generation-run-2', 'draft-1'));
    await waitFor(() => expect(draftUpdateListeners.size).toBeGreaterThan(0));
    await act(async () => {
      await Promise.all([...draftUpdateListeners].map(listener => listener({
        eventType: 'draft:update',
        draftId: 'draft-1',
        runId: 'generation-run-2',
        step: 'context',
        status: 'in_progress',
        timestamp: '2026-05-05T00:00:10Z',
        draftStatus: 'generating',
        generationTrace: {
          runId: 'generation-run-2',
          steps: [{ name: 'context', status: 'in_progress' }],
        },
      })));
    });

    expect(result.current.draft?.status).toBe('generating');
    expect(result.current.draft?.generation_trace?.runId).toBe('generation-run-2');
    expect(result.current.draft?.generation_trace?.steps).toEqual([
      { name: 'context', status: 'in_progress' },
    ]);
  });

  it('activates a fresh run from its acknowledged snapshot while the first fetch is in flight', async () => {
    const staleFetch = createDeferred<Awaited<ReturnType<typeof getDraft>>>();
    mockGetDraft.mockImplementationOnce(() => staleFetch.promise);
    const snapshot = {
      draft_id: 'draft-1', repository: 'integry/propr', initial_prompt: 'Fresh prompt', status: 'draft', attachments: [], created_at: '2026-10-22T22:00:00Z',
    };
    const { result } = renderHook(() => useDraft('draft-1'));
    expect(result.current.loading).toBe(true);

    act(() => result.current.activateGenerationRun('generation-run-1', 'draft-1', snapshot as never));
    expect(result.current.loading).toBe(false);
    expect(result.current.draft?.status).toBe('generating');
    expect(result.current.draft?.initial_prompt).toBe('Fresh prompt');
    expect(result.current.draft?.generation_trace?.runId).toBe('generation-run-1');

    // The fetch requested before generation started returns the pre-generation draft.
    await act(async () => staleFetch.resolve({ ...snapshot, status: 'draft' } as never));
    expect(result.current.draft?.status).toBe('generating');
    expect(result.current.draft?.generation_trace?.runId).toBe('generation-run-1');

    // A resync requested after the acknowledgement is authoritative.
    mockGetDraft.mockResolvedValueOnce({ ...snapshot, status: 'review', generation_trace: { runId: 'generation-run-1', steps: [] } } as never);
    await act(async () => result.current.refetch());
    expect(result.current.draft?.status).toBe('review');
  });

  it('resyncs a generating router snapshot once when the entry is revisited', async () => {
    mockGetDraft.mockResolvedValueOnce({
      draft_id: 'draft-1', repository: 'integry/propr', initial_prompt: 'Test prompt', status: 'review', attachments: [],
      created_at: '2026-05-05T00:00:00Z', generation_trace: { runId: 'generation-run-1', steps: [] },
    });
    const initialDraft = {
      draft_id: 'draft-1', repository: 'integry/propr', initial_prompt: 'Test prompt', status: 'generating', attachments: [],
      created_at: '2026-05-05T00:00:00Z', generation_trace: { runId: 'generation-run-1', steps: [] },
    };
    const { result } = renderHook(() => useDraft('draft-1', { initialData: initialDraft as never }));
    expect(result.current.loading).toBe(false);
    expect(result.current.draft?.status).toBe('generating');

    await waitFor(() => expect(result.current.draft?.status).toBe('review'));
    expect(result.current.loading).toBe(false);
    expect(mockGetDraft).toHaveBeenCalledTimes(1);
  });

  it('ignores an acknowledgement whose snapshot belongs to another draft', async () => {
    mockGetDraft.mockResolvedValueOnce({
      draft_id: 'draft-1', repository: 'integry/propr', initial_prompt: 'Test prompt', status: 'draft', attachments: [], created_at: '2026-05-05T00:00:00Z',
    });
    const { result } = renderHook(() => useDraft('draft-1'));
    await waitFor(() => expect(result.current.draft?.draft_id).toBe('draft-1'));

    act(() => result.current.activateGenerationRun('generation-run-9', 'draft-1', { draft_id: 'draft-2', status: 'draft' } as never));
    act(() => result.current.activateGenerationRun('generation-run-9', 'draft-2'));
    expect(result.current.draft?.draft_id).toBe('draft-1');
    expect(result.current.draft?.status).toBe('draft');
    expect(result.current.draft?.generation_trace?.runId).toBeUndefined();
  });

  it('ignores the acknowledgement for draft A after switching to draft B', async () => {
    const draftA = {
      draft_id: 'draft-a', repository: 'integry/propr', initial_prompt: 'Prompt A', status: 'draft', attachments: [], created_at: '2026-10-22T22:00:00Z',
    };
    const draftB = {
      draft_id: 'draft-b', repository: 'integry/propr', initial_prompt: 'Prompt B', status: 'generating', attachments: [],
      created_at: '2026-10-22T22:00:00Z', generation_trace: { runId: 'generation-run-b', steps: [] },
    };
    mockGetDraft.mockResolvedValueOnce(draftA as never);
    const { result, rerender } = renderHook(({ id }) => useDraft(id), { initialProps: { id: 'draft-a' } });
    await waitFor(() => expect(result.current.draft?.draft_id).toBe('draft-a'));
    // The activation callback captured while A's generate request was pending.
    const activateFromA = result.current.activateGenerationRun;

    const draftBFetch = createDeferred<Awaited<ReturnType<typeof getDraft>>>();
    mockGetDraft.mockImplementationOnce(() => draftBFetch.promise);
    rerender({ id: 'draft-b' });

    // A's acknowledgement lands while B's fetch is still in flight, then again after it settles.
    act(() => activateFromA('generation-run-a', 'draft-a', draftA as never));
    await act(async () => draftBFetch.resolve(draftB as never));
    expect(result.current.draft).toMatchObject({ draft_id: 'draft-b', status: 'generating', generation_trace: { runId: 'generation-run-b' } });

    act(() => activateFromA('generation-run-a', 'draft-a', draftA as never));
    expect(result.current.draft).toMatchObject({ draft_id: 'draft-b', status: 'generating', generation_trace: { runId: 'generation-run-b' } });

    // B's own socket updates are still accepted under B's run ID.
    await act(async () => {
      for (const listener of draftUpdateListeners) {
        await listener({
          draftId: 'draft-b', runId: 'generation-run-b', draftStatus: 'generating', timestamp: '2026-10-22T22:01:00Z',
          generationTrace: { runId: 'generation-run-b', steps: [{ name: 'context', status: 'in_progress' }] },
        } as never);
      }
    });
    expect(result.current.draft?.generation_trace?.steps).toEqual([{ name: 'context', status: 'in_progress' }]);
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
