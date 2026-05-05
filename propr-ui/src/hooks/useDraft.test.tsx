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
      { name: 'relevance', status: 'completed' },
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
});
