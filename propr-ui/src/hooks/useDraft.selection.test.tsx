import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useDraft } from './useDraft';
import { getDraft } from '../api/proprApi';
import type { DraftUpdatePayload } from '@propr/shared';

// Reads are owned by the selection that requested them; see useDraft.test.tsx for the
// generation-acknowledgement and socket cases.
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
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDraft.mockReset();
  draftUpdateListeners.clear();
});

describe('useDraft when the selection changes while a read is in flight', () => {
  type DraftFetch = ReturnType<typeof createDeferred<Awaited<ReturnType<typeof getDraft>>>>;
  const draftRecord = (id: string, status: string, runId?: string) => ({
    draft_id: id, repository: 'integry/propr', initial_prompt: `Prompt ${id}`, status, attachments: [],
    created_at: '2026-10-22T22:00:00Z', ...(runId ? { generation_trace: { runId, steps: [] } } : {}),
  });
  const queueFetch = (): DraftFetch => {
    const fetch = createDeferred<Awaited<ReturnType<typeof getDraft>>>();
    mockGetDraft.mockImplementationOnce(() => fetch.promise);
    return fetch;
  };
  // Revisiting A through a history entry whose router snapshot still says generating.
  const renderRevisitedGeneratingA = () => {
    const resyncA = queueFetch();
    const initialData = draftRecord('draft-a', 'generating', 'generation-run-a') as never;
    const hook = renderHook(({ id }) => useDraft(id, { initialData }), { initialProps: { id: 'draft-a' } });
    expect(mockGetDraft).toHaveBeenLastCalledWith('draft-a');
    return { ...hook, resyncA };
  };

  it('keeps B and its run when A’s background resync resolves after B loaded', async () => {
    const { result, rerender, resyncA } = renderRevisitedGeneratingA();
    const fetchB = queueFetch();
    rerender({ id: 'draft-b' });
    expect(result.current.loading).toBe(true);

    await act(async () => fetchB.resolve(draftRecord('draft-b', 'generating', 'generation-run-b') as never));
    expect(result.current.loading).toBe(false);
    await act(async () => resyncA.resolve(draftRecord('draft-a', 'review', 'generation-run-a') as never));
    expect(result.current.draft).toMatchObject({ draft_id: 'draft-b', status: 'generating', generation_trace: { runId: 'generation-run-b' } });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();

    // B's active run identity survived: its socket progress is still accepted, A's is not.
    await act(async () => {
      for (const listener of draftUpdateListeners) {
        await listener({ draftId: 'draft-b', runId: 'generation-run-a', draftStatus: 'generating', timestamp: '2026-10-22T22:01:00Z',
          generationTrace: { runId: 'generation-run-a', steps: [{ name: 'context', status: 'failed' }] } } as never);
        await listener({ draftId: 'draft-b', runId: 'generation-run-b', draftStatus: 'generating', timestamp: '2026-10-22T22:01:01Z',
          generationTrace: { runId: 'generation-run-b', steps: [{ name: 'context', status: 'in_progress' }] } } as never);
      }
    });
    expect(result.current.draft?.generation_trace?.steps).toEqual([{ name: 'context', status: 'in_progress' }]);
    expect(mockGetDraft).toHaveBeenCalledTimes(2);
  });

  it('keeps B loading when A’s resync settles before B’s read, then installs B', async () => {
    const { result, rerender, resyncA } = renderRevisitedGeneratingA();
    const fetchB = queueFetch();
    rerender({ id: 'draft-b' });

    await act(async () => resyncA.resolve(draftRecord('draft-a', 'review', 'generation-run-a') as never));
    expect(result.current.loading).toBe(true);
    expect(result.current.draft).toBeNull();

    await act(async () => fetchB.resolve(draftRecord('draft-b', 'review', 'generation-run-b') as never));
    expect(result.current.draft).toMatchObject({ draft_id: 'draft-b', status: 'review', generation_trace: { runId: 'generation-run-b' } });
    expect(result.current.loading).toBe(false);
  });

  it('does not report A’s failed resync on B, nor end B’s loading', async () => {
    const { result, rerender, resyncA } = renderRevisitedGeneratingA();
    const fetchB = queueFetch();
    rerender({ id: 'draft-b' });

    await act(async () => resyncA.reject(new Error('draft-a unavailable')));
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => fetchB.resolve(draftRecord('draft-b', 'generating', 'generation-run-b') as never));
    expect(result.current.draft).toMatchObject({ draft_id: 'draft-b', generation_trace: { runId: 'generation-run-b' } });
    expect(result.current.error).toBeNull();
  });

  it.each([
    ['resolves', (fetch: DraftFetch) => fetch.resolve(draftRecord('draft-a', 'generating', 'generation-run-a') as never)],
    ['fails', (fetch: DraftFetch) => fetch.reject(new Error('stale read failed'))],
  ])('ignores A’s obsolete resync that %s after re-selecting A via B', async (_label, settleObsolete) => {
    const { result, rerender, resyncA } = renderRevisitedGeneratingA();
    const fetchB = queueFetch();
    rerender({ id: 'draft-b' });
    await act(async () => fetchB.resolve(draftRecord('draft-b', 'review', 'generation-run-b') as never));

    const refetchA = queueFetch();
    rerender({ id: 'draft-a' });
    await act(async () => refetchA.resolve(draftRecord('draft-a', 'review', 'generation-run-a2') as never));
    expect(result.current.draft).toMatchObject({ draft_id: 'draft-a', status: 'review', generation_trace: { runId: 'generation-run-a2' } });

    await act(async () => settleObsolete(resyncA));
    expect(result.current.draft).toMatchObject({ draft_id: 'draft-a', status: 'review', generation_trace: { runId: 'generation-run-a2' } });
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(mockGetDraft).toHaveBeenCalledTimes(3);
  });

  it('lets the newest read for the re-selected draft own loading even if the obsolete one settles first', async () => {
    const { result, rerender, resyncA } = renderRevisitedGeneratingA();
    const fetchB = queueFetch();
    rerender({ id: 'draft-b' });
    await act(async () => fetchB.resolve(draftRecord('draft-b', 'review', 'generation-run-b') as never));
    const refetchA = queueFetch();
    rerender({ id: 'draft-a' });

    await act(async () => resyncA.resolve(draftRecord('draft-a', 'generating', 'generation-run-a') as never));
    expect(result.current.loading).toBe(true);
    expect(result.current.draft).toBeNull();

    await act(async () => refetchA.resolve(draftRecord('draft-a', 'review', 'generation-run-a2') as never));
    expect(result.current.draft).toMatchObject({ draft_id: 'draft-a', status: 'review', generation_trace: { runId: 'generation-run-a2' } });
    expect(result.current.loading).toBe(false);
  });

  it('ignores a refetch requested through A’s stale callback after switching to B', async () => {
    const { result, rerender, resyncA } = renderRevisitedGeneratingA();
    await act(async () => resyncA.resolve(draftRecord('draft-a', 'generating', 'generation-run-a') as never));
    const refetchFromA = result.current.refetch;
    const fetchB = queueFetch();
    rerender({ id: 'draft-b' });

    await act(async () => refetchFromA());
    await act(async () => fetchB.resolve(draftRecord('draft-b', 'review', 'generation-run-b') as never));
    expect(result.current.draft).toMatchObject({ draft_id: 'draft-b', generation_trace: { runId: 'generation-run-b' } });
    expect(mockGetDraft).toHaveBeenCalledTimes(2);
  });
});
