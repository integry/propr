import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useGenerationPolling } from './useGenerationPolling';
import { getDraft } from '../api/proprApi';

const socketState = {
  isConnected: true,
  subscribeToDraft: vi.fn(),
  unsubscribeFromDraft: vi.fn(),
  onDraftUpdate: vi.fn(() => () => {}),
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
    socketState.isConnected = true;
    socketState.onDraftUpdate.mockImplementation(() => () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not keep HTTP polling while the socket is connected', () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => useGenerationPolling({ draftId: 'draft-1', onComplete }));

    act(() => {
      result.current.startPolling();
    });

    act(() => {
      vi.advanceTimersByTime(35_000);
    });

    expect(mockGetDraft).not.toHaveBeenCalled();
  });
});
